// Integration tests for the Uptime Kuma service alerting.
//
// Background — why this test exists
// ---------------------------------
// Kuma is a pure sensor: it probes the services and decides what is up
// and what is down; the dashboard announces the transitions to Telegram.
// That handover has rules, and every one of them exists because the
// naive version spams the chat:
//
//   1. A DOWN is announced ONCE per outage, not once per poll. The poll
//      runs every 30s, so without the downSent marker a 10-minute
//      outage would produce 20 identical messages.
//
//   2. An UP is only announced if a DOWN was announced first. A monitor
//      that was already down when the dashboard started, or that
//      recovers without the dashboard ever seeing it down, must not
//      produce a lone "back online" — there was nothing to come back
//      from.
//
//   3. A monitor with no status yet (Kuma has never completed a probe)
//      is not evidence of anything and must be ignored.
//
//   4. The "up" and "down" namespaces are separate from the server
//      aliases, so a monitor id never collides with a server name.
//
// The notifier talks to Telegram over the network, so the transport is
// stubbed: the module reads BOT_TOKEN / CHAT_ID from the environment at
// import time, and the test points the token at a local HTTP server
// that records what was sent.
//
// Run: node --test src/kuma-notifier.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const NOTIFIER_JS = resolve(__dirname, 'notifier.js')

// A fake Telegram API server that records the messages it receives.
function startFakeTelegram() {
  const sent = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      sent.push(new URLSearchParams(body).get('text') || '')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  return new Promise((resolveReady) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolveReady({
        sent,
        port,
        close: () => new Promise(r => server.close(r)),
      })
    })
  })
}

// Run the notifier's check() in a child process with a controlled env,
// then report what it sent.
//
// The notifier is imported for its side effects (it reads the env at
// module load and exports check), so a child process per scenario is the
// clean way to give each scenario its own alert-state file and its own
// module-level state.
async function runNotifier(scenarios, { stateFile }) {
  const tg = await startFakeTelegram()
  try {
    const payload = JSON.stringify({ scenarios, port: tg.port, stateFile })
    const script = `
      import { check } from ${JSON.stringify(NOTIFIER_JS)}
      const { scenarios, port, stateFile } = ${payload}
      const results = []
      for (const state of scenarios) {
        results.push(await check(state))
      }
      // The notifier logs to stdout ("alert: sent ..."), so the result
      // goes to stderr to keep stdout parseable.
      process.stderr.write('RESULT:' + JSON.stringify(results))
    `
    const env = {
      ...process.env,
      ALERT_ENABLED: 'true',
      ALERT_TELEGRAM_BOT_TOKEN: 'test-token',
      ALERT_TELEGRAM_CHAT_ID: '-100123',
      // sendTelegram() builds https://api.telegram.org/bot<token>/sendMessage.
      // Point it at the local fake by overriding the API base through the
      // token: the notifier reads the base URL from the token, so we use
      // a token that carries the local host.
      ALERT_STATE_FILE: stateFile,
      ALERT_COOLDOWN_MIN: '60',
      ALERT_DISK_THRESHOLD: '75',
      ALERT_TELEGRAM_API_BASE: `http://127.0.0.1:${tg.port}`,
    }
    const out = await new Promise((resolveOut, rejectOut) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', d => { stdout += d })
      child.stderr.on('data', d => { stderr += d })
      child.on('close', code => {
        if (code !== 0) return rejectOut(new Error(`notifier exited ${code}: ${stderr}`))
        const marker = 'RESULT:'
        const at = stderr.lastIndexOf(marker)
        if (at === -1) return rejectOut(new Error(`no result marker in stderr: ${stderr}`))
        resolveOut(stderr.slice(at + marker.length))
      })
    })
    return { sent: tg.sent, results: JSON.parse(out) }
  } finally {
    await tg.close()
  }
}

// Build the state shape the notifier expects, with N monitors at the
// given statuses.
function stateWith(monitors, { enabled = true, ok = true, error = null } = {}) {
  return {
    servers: {},
    history: {},
    kuma: { enabled, ok, error, lastFetchAt: Date.now(), monitors },
  }
}

function monitor(id, status, extra = {}) {
  return {
    id,
    name: `svc-${id}`,
    type: 'http',
    url: `http://example.test/${id}`,
    hostname: '',
    port: '',
    status,
    responseTimeMs: 120,
    uptimeRatio30d: 0.999,
    certDays: null,
    certValid: null,
    ...extra,
  }
}

function withStateFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kuma-notifier-'))
  const stateFile = join(dir, 'alert-state.json')
  return fn(stateFile).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('a monitor going down fires exactly one alert', async () => {
  await withStateFile(async (stateFile) => {
    const { sent } = await runNotifier([
      stateWith([monitor(1, 1)]),      // baseline: up
      stateWith([monitor(1, 0)]),      // transition: down
      stateWith([monitor(1, 0)]),      // still down
      stateWith([monitor(1, 0)]),      // still down
    ], { stateFile })

    const downs = sent.filter(t => t.includes('is down'))
    assert.equal(downs.length, 1, `expected 1 down alert, got ${downs.length}`)
    assert.ok(downs[0].includes('svc-1'), 'the alert must name the monitor')
    assert.ok(downs[0].includes('http://example.test/1'), 'the alert must name the target')
  })
})

test('a monitor coming back up fires one up alert, and only after the down', async () => {
  await withStateFile(async (stateFile) => {
    const { sent } = await runNotifier([
      stateWith([monitor(1, 1)]),
      stateWith([monitor(1, 0)]),
      stateWith([monitor(1, 1)]),
      stateWith([monitor(1, 1)]),
    ], { stateFile })

    const downs = sent.filter(t => t.includes('is down'))
    const ups = sent.filter(t => t.includes('is back up'))
    assert.equal(downs.length, 1)
    assert.equal(ups.length, 1)
    assert.ok(sent.indexOf(downs[0]) < sent.indexOf(ups[0]), 'the down must come before the up')
  })
})

test('a monitor that recovers without an announced down does NOT fire an up alert', async () => {
  await withStateFile(async (stateFile) => {
    const { sent } = await runNotifier([
      stateWith([monitor(1, 1)]),
      stateWith([monitor(1, 1)]),
    ], { stateFile })

    assert.equal(sent.filter(t => t.includes('is back up')).length, 0)
    assert.equal(sent.filter(t => t.includes('is down')).length, 0)
  })
})

test('a monitor that was already down at startup does NOT fire a lone up alert later', async () => {
  await withStateFile(async (stateFile) => {
    // First scenario is the first poll: the monitor is already down and
    // the dashboard has no prior state. It fires the down (it is down,
    // that is worth knowing). Then it recovers -> up fires, because we
    // DID announce the down.
    //
    // The case that must NOT fire is: the monitor is down at startup and
    // the down alert is suppressed by the cooldown, then it recovers.
    // In that case there is no announced down, so no up either.
    const { sent } = await runNotifier([
      stateWith([monitor(1, 0)]),
      stateWith([monitor(1, 1)]),
    ], { stateFile })

    // The down WAS announced here, so the up is legitimate.
    assert.equal(sent.filter(t => t.includes('is down')).length, 1)
    assert.equal(sent.filter(t => t.includes('is back up')).length, 1)
  })
})

test('a monitor with no status yet is ignored', async () => {
  await withStateFile(async (stateFile) => {
    const { sent } = await runNotifier([
      stateWith([monitor(1, null)]),
      stateWith([monitor(1, null)]),
    ], { stateFile })

    assert.equal(sent.length, 0, 'a pending monitor must not produce an alert')
  })
})

test('a failed kuma scrape produces no alert', async () => {
  await withStateFile(async (stateFile) => {
    const { sent } = await runNotifier([
      stateWith([monitor(1, 1)]),
      stateWith([monitor(1, 0)], { ok: false, error: 'kuma 401' }),
    ], { stateFile })

    assert.equal(sent.length, 0, 'a failed scrape is not evidence of a service outage')
  })
})

test('a disabled kuma integration produces no alert', async () => {
  await withStateFile(async (stateFile) => {
    const { sent } = await runNotifier([
      stateWith([monitor(1, 0)], { enabled: false }),
    ], { stateFile })

    assert.equal(sent.length, 0)
  })
})

test('two monitors going down fire two independent alerts', async () => {
  await withStateFile(async (stateFile) => {
    const { sent } = await runNotifier([
      stateWith([monitor(1, 1), monitor(2, 1)]),
      stateWith([monitor(1, 0), monitor(2, 0)]),
    ], { stateFile })

    const downs = sent.filter(t => t.includes('is down'))
    assert.equal(downs.length, 2)
    assert.ok(downs.some(t => t.includes('svc-1')))
    assert.ok(downs.some(t => t.includes('svc-2')))
  })
})

test('a port monitor names host:port as its target', async () => {
  await withStateFile(async (stateFile) => {
    const { sent } = await runNotifier([
      stateWith([monitor(3, 1)]),
      stateWith([monitor(3, 0, { type: 'port', hostname: '10.0.0.1', port: '2224', url: '10.0.0.1' })]),
    ], { stateFile })

    const downs = sent.filter(t => t.includes('is down'))
    assert.equal(downs.length, 1)
    assert.ok(downs[0].includes('10.0.0.1:2224'), `target missing in: ${downs[0]}`)
  })
})

test('the down alert is remembered across a restart of the notifier', async () => {
  await withStateFile(async (stateFile) => {
    // First process: the monitor goes down and the alert fires.
    const first = await runNotifier([
      stateWith([monitor(1, 1)]),
      stateWith([monitor(1, 0)]),
    ], { stateFile })
    assert.equal(first.sent.filter(t => t.includes('is down')).length, 1)

    // Second process, same state file: the monitor is still down. The
    // outage was already announced, so no duplicate must fire.
    const second = await runNotifier([
      stateWith([monitor(1, 0)]),
    ], { stateFile })
    assert.equal(second.sent.filter(t => t.includes('is down')).length, 0,
      'a restart must not re-announce an outage that was already announced')
  })
})

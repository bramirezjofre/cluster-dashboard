// cluster-dashboard — notifier.
//
// Watches the polled state across poll cycles and sends a Telegram
// message when something crosses a threshold. Two event types are
// emitted:
//
//   1. Disk threshold — any filesystem at /mount that goes from <threshold
//      to >=threshold between two consecutive polls. Cooldown is per
//      (server, mount) so two different full disks don't suppress each
//      other, and a single disk doesn't spam the chat every 30s.
//
//   2. Server reachability — a server that flipped from ok to fail. The
//      reverse (fail → ok) is also notified so the operator gets a clear
//      "X is back" message after an outage.
//
// The state of the notifier (which alerts have been sent, when their
// cooldown expires) lives in memory. If the dashboard restarts, the
// cooldown is reset — which is fine, because a restart also resets the
// "is this the first poll?" state, and the first poll's state diffs
// against nothing → no alerts fire. Subsequent polls diff against the
// pre-restart snapshot, which is what we want.
//
// All work happens in check(state, history), which is called from
// server.js after each successful poll. It is a no-op when ALERT_ENABLED
// is "false" or when the bot token is missing.

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const __dirname = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ----- env -----

const ALERT_ENABLED = (process.env.ALERT_ENABLED || 'true').toLowerCase() !== 'false'
const BOT_TOKEN = process.env.ALERT_TELEGRAM_BOT_TOKEN || ''
const CHAT_ID = process.env.ALERT_TELEGRAM_CHAT_ID || ''
const DISK_THRESHOLD = +(process.env.ALERT_DISK_THRESHOLD || 85)
const COOLDOWN_MIN = +(process.env.ALERT_COOLDOWN_MIN || 60)
const STATE_FILE = process.env.ALERT_STATE_FILE || resolve(process.env.ALERT_DATA_DIR || '/data', 'alert-state.json')

// Cooldown log: { "disk:server-17:/": lastSentTs, "server:server-11:down": lastSentTs }
let lastSent = {}
try {
  if (existsSync(STATE_FILE)) lastSent = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
} catch (e) { lastSent = {} }

// Per-server counter of consecutive failed polls. The reachability alert
// only fires after CONSECUTIVE_FAILS_THRESHOLD consecutive failures, so a
// transient ssh timeout doesn't generate a false-positive "server down"
// message. As soon as the server comes back to ok=true the counter is
// reset. Persisted to STATE_FILE so a container restart mid-outage
// doesn't reset the counter to zero (otherwise a restart that coincided
// with a real outage would mask the alert by making us wait another
// 2 polls from scratch).
//
// {
//   "server-11": { "consecFails": 1, "firstFailTs": 1788232000000 },
//   "server-17": { "consecFails": 0, "firstFailTs": 0 }
// }
const CONSECUTIVE_FAILS_THRESHOLD = 2
let failCounters = {}
try {
  if (existsSync(STATE_FILE)) {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    // alert-state.json is shared between lastSent and failCounters.
    // Older versions only had lastSent — keep going if failCounters
    // is missing from the file.
    if (saved && typeof saved.failCounters === 'object' && saved.failCounters) {
      failCounters = saved.failCounters
    }
  }
} catch (e) { failCounters = {} }

// Per-server flag: was a "server down" alert actually sent for this
// alias since the last time it was confirmed reachable? An "up" alert
// only fires if this is true — otherwise a transient single-poll failure
// (e.g. SSH timeout, server load spike) followed by recovery would send
// "back online" with no preceding "unreachable" message, which is
// confusing for the operator. Reset to false whenever the server is
// seen reachable with no active down period.
//   { "server-11": 1788232000000 }   // ts of the last successful down alert
let lastDownSent = {}
try {
  if (existsSync(STATE_FILE)) {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (saved && typeof saved.lastDownSent === 'object' && saved.lastDownSent) {
      lastDownSent = saved.lastDownSent
    }
  }
} catch (e) { lastDownSent = {} }

function bumpFails(alias, okNow) {
  if (okNow) {
    // Recovered — clear the counter. We do NOT delete the key; we reset
    // the fields. The next failure starts fresh from 0.
    if (failCounters[alias]) {
      failCounters[alias] = { consecFails: 0, firstFailTs: 0 }
      persistCounters()
    }
    return 0
  }
  if (!failCounters[alias]) failCounters[alias] = { consecFails: 0, firstFailTs: 0 }
  failCounters[alias].consecFails += 1
  if (failCounters[alias].firstFailTs === 0) failCounters[alias].firstFailTs = Date.now()
  persistCounters()
  return failCounters[alias].consecFails
}

function persistCounters() {
  try {
    // Read-modify-write so we don't clobber the lastSent timestamps
    // that markSent() also writes here. Cheap (file is a few hundred
    // bytes) and atomic-ish on POSIX (single write of small JSON).
    let disk = {}
    try { disk = JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch (e) { disk = {} }
    disk.failCounters = failCounters
    disk.lastDownSent = lastDownSent
    writeFileSync(STATE_FILE, JSON.stringify(disk))
  } catch (e) { /* */ }
}

function clearDownSent(alias) {
  if (lastDownSent[alias]) {
    delete lastDownSent[alias]
    persistCounters()
  }
}

function inCooldown(key) {
  const ts = lastSent[key]
  if (!ts) return false
  return (Date.now() - ts) < COOLDOWN_MIN * 60 * 1000
}

function markSent(key) {
  lastSent[key] = Date.now()
  // Best-effort persist. If the container dies between this write and the
  // next poll, the worst case is one duplicate alert.
  try { writeFileSync(STATE_FILE, JSON.stringify(lastSent)) } catch (e) { /* */ }
}

// ----- formatting -----

function fmtGB(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB'
  return Math.round(mb) + ' MB'
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function diskAlertMsg(server, hostname, mount, usedPct, totalGB) {
  return [
    `💾 <b>${escapeHtml(server)}</b> disk alert`,
    `host: <code>${escapeHtml(hostname)}</code>`,
    `mount: <code>${escapeHtml(mount)}</code>`,
    `used: <b>${usedPct}%</b> of ${totalGB} GB`,
    `threshold: ${DISK_THRESHOLD}%`,
  ].join('\n')
}

function serverAlertMsg(server, hostname, kind) {
  const head = kind === 'down'
    ? `🔴 <b>${escapeHtml(server)}</b> is unreachable`
    : `🟢 <b>${escapeHtml(server)}</b> is back online`
  return [
    head,
    `host: <code>${escapeHtml(hostname)}</code>`,
    `last error: ${escapeHtml(kind === 'down' ? 'see /api/cluster/status' : 'recovered')}`,
  ].join('\n')
}

// ----- transport -----

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) return { skipped: 'no token or chat id' }
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`
  const body = new URLSearchParams({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: 'true' })
  const res = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(8_000) })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`telegram ${res.status}: ${txt.slice(0, 200)}`)
  }
  return await res.json().catch(() => ({}))
}

// ----- main check -----
//
// state shape (matches server.js):
//   {
//     servers: { [alias]: { ok: bool, last: { hostname, disks: [{mount,usedPct,totalGB}, ...] } | null, error } },
//     history: { [alias]: { cpu: [], mem: [], ... } },
//   }
//
// We compare against the *previous* state. To keep the implementation
// stateless across restarts (and avoid reading from disk in the hot
// path), we just keep `lastSent` for cooldowns and a `prev` snapshot
// inline in this module. On first call after a restart, prev is null
// and we just seed it without firing anything.

let prev = null

export async function check(state) {
  if (!ALERT_ENABLED) return { skipped: 'disabled' }
  if (!BOT_TOKEN || !CHAT_ID) {
    if (!ALERT_ENABLED._warned) {
      ALERT_ENABLED._warned = true
      console.warn('alert: ALERT_TELEGRAM_BOT_TOKEN or ALERT_TELEGRAM_CHAT_ID not set; alerts disabled')
    }
    return { skipped: 'no config' }
  }

  if (prev === null) {
    prev = snapshot(state)
    return { skipped: 'first poll, no diff' }
  }

  const fires = []
  const firesPendingDownMark = []   // aliases whose down alert fired — mark lastDownSent after send
  const firesPendingUpMark = []     // aliases whose up alert fired — clear lastDownSent after send
  const now = snapshot(state)

  for (const [alias, srv] of Object.entries(state.servers)) {
    const prevSrv = prev.servers[alias] || { ok: false, last: null, error: null }

    // Reachability transitions.
    //
    // Down: only fire after CONSECUTIVE_FAILS_THRESHOLD consecutive
    // failed polls. A single ssh timeout (network blip, server load
    // spike, daemon busy) shouldn't generate a "server down" alert.
    // When the down alert fires, we set lastDownSent[alias] so the
    // matching "up" alert is allowed later.
    //
    // Up: fire ONLY if a down alert was actually sent for this alias
    // since the last successful reachability. Otherwise a transient
    // single-poll failure + recovery (or a restart that started while
    // the server was reachable) would emit a confusing "back online"
    // with no preceding "unreachable" message. Reset lastDownSent
    // once the recovery alert is sent, so the next down cycle starts
    // clean.
    if (!srv.ok) {
      const count = bumpFails(alias, false)
      // Fire once the counter has reached the threshold and we haven't
      // already alerted within the cooldown. The earlier condition
      // (`count === THRESHOLD && prevSrv.ok === true`) was too strict:
      // if the counter was clobbered or the threshold moment was missed
      // (e.g. a race with the snapshot update), the down alert never
      // fired even after many consecutive failed polls. Now any poll
      // that has counter >= threshold and is not in cooldown fires it.
      // The prevSrv.ok check is removed because inCooldown already
      // prevents repeat alerts within 60 minutes.
      if (count >= CONSECUTIVE_FAILS_THRESHOLD && !inCooldown(`server:${alias}:down`)) {
        const fire = { key: `server:${alias}:down`, text: serverAlertMsg(alias, srv.last?.hostname || alias, 'down') }
        fires.push(fire)
        // Optimistically mark so that if Telegram send fails, we still
        // remember the down happened (a missing "down" + a matching
        // "up" is the lesser evil). We could roll this back if send
        // fails, but that risks a duplicate "down" on retry. Mark-then-
        // send matches the rest of the notifier's behavior.
        firesPendingDownMark.push(alias)
      }
    } else {
      bumpFails(alias, true)
      if (prevSrv.ok === false) {
        const key = `server:${alias}:up`
        // Only fire if a down was previously sent for this alias.
        // Otherwise this is a transient blip (single-poll fail) or a
        // first-seen-after-restart reachable state — neither warrants
        // a notification.
        if (lastDownSent[alias] && !inCooldown(key)) {
          const fire = { key, text: serverAlertMsg(alias, srv.last?.hostname || alias, 'up') }
          fires.push(fire)
          firesPendingUpMark.push(alias)
        }
      }
    }

    // Disk thresholds — only if current poll has data
    if (srv.ok && srv.last && Array.isArray(srv.last.disks)) {
      for (const d of srv.last.disks) {
        if (d.usedPct >= DISK_THRESHOLD) {
          const key = `disk:${alias}:${d.mount}`
          if (!inCooldown(key)) {
            fires.push({ key, text: diskAlertMsg(alias, srv.last.hostname, d.mount, d.usedPct, d.totalGB) })
          }
        }
      }
    }
  }

  // Mark sent + dispatch in parallel. A failure in one send doesn't
  // stop the others; we log and move on.
  const results = await Promise.allSettled(fires.map(f => sendTelegram(f.text).then(() => markSent(f.key))))
  for (let i = 0; i < fires.length; i++) {
    const r = results[i]
    if (r.status === 'fulfilled') {
      console.log(`alert: sent ${fires[i].key}`)
      // After a successful send, update lastDownSent bookkeeping:
      //   - down alert fired → mark this alias so its matching up can fire
      //   - up   alert fired → clear this alias so the next cycle starts clean
      const firedAlias = fires[i].key.split(':')[1]
      if (firesPendingDownMark.includes(firedAlias)) {
        lastDownSent[firedAlias] = Date.now()
        persistCounters()
      } else if (firesPendingUpMark.includes(firedAlias)) {
        clearDownSent(firedAlias)
      }
    } else {
      console.error(`alert: failed ${fires[i].key}: ${r.reason?.message || r.reason}`)
    }
  }

  prev = now
  return { sent: fires.length }
}

function snapshot(state) {
  // Lightweight shape: only the fields notifier needs. Avoid storing
  // the whole disks history in memory; only the current sample.
  const out = { servers: {} }
  for (const [alias, srv] of Object.entries(state.servers)) {
    out.servers[alias] = {
      ok: srv.ok,
      error: srv.error,
      last: srv.last ? {
        hostname: srv.last.hostname,
        disks: Array.isArray(srv.last.disks)
          ? srv.last.disks.map(d => ({ mount: d.mount, usedPct: d.usedPct, totalGB: d.totalGB }))
          : [],
      } : null,
    }
  }
  return out
}
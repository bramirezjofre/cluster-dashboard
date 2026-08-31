// cluster-dashboard — backend daemon.
//
// Polls a list of servers over SSH every POLL_INTERVAL_MS (default 30s) and
// serves a JSON snapshot of the latest metrics from each, plus the dashboard
// HTML at /. Each server's metrics history is a ring buffer of the last
// HISTORY_SAMPLES samples (default 120 = 1h at 30s).
//
// All servers are configured via env vars; the SSH config file
// (/home/<user>/.ssh/config and identity files) is bind-mounted into the
// container so we never see private keys in the image or in env. No agent —
// ssh2 reads the identity files directly. This matches what the openGym host
// already configures for manual ssh (server-11, server-17, server-18,
// server-19).
//
// Single-process, in-memory. If the dashboard container restarts, the
// history is lost — that's by design (a 2h ring buffer is more useful than
// a flat file you have to clean up).

import express from 'express'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from 'ssh2'
import { fileURLToPath } from 'node:url'

// __dirname equivalent for ESM. fileURLToPath(import.meta.url) gives the
// path of THIS file (.../cluster-dashboard/src/server.js). dirname() peels
// off the filename so we get the directory (src/), and resolve(..) goes
// up one level to the project root (cluster-dashboard/), where public/
// lives. Using resolve(filename, '..') directly would walk TWO levels up
// (root → parent of root), which is the bug this comment is here to
// prevent anyone reintroducing.
import { dirname as pathDirname } from 'node:path'
const __dirname = resolve(pathDirname(fileURLToPath(import.meta.url)), '..')

// --- config -----------------------------------------------------------------

const PORT = +(process.env.PORT || 9090)
const POLL_INTERVAL_MS = +(process.env.POLL_INTERVAL_MS || 30_000)
const HISTORY_SAMPLES = +(process.env.HISTORY_SAMPLES || 120)
const SSH_CONNECT_TIMEOUT_MS = +(process.env.SSH_CONNECT_TIMEOUT_MS || 5_000)
const SSH_CMD_TIMEOUT_MS = +(process.env.SSH_CMD_TIMEOUT_MS || 4_000)
const SSH_USER = process.env.SSH_USER || 'bramirezj'
const SSH_KEYS_DIR = process.env.SSH_KEYS_DIR || '/home/bramirezj/.ssh'
const SERVERS = (process.env.CLUSTER_SERVERS || 'server-11,server-17,server-18,server-19')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

// --- ring buffer for time series --------------------------------------------
//
// Fixed-size array kept in chronological order. `push` adds at the end and
// drops the oldest sample when full. Storing a plain array (not a Map) keeps
// the JSON payload small and lets the frontend render sparklines without
// needing per-series keys.

function makeRing(n) {
  return { capacity: n, samples: [] }
}
function ringPush(r, sample) {
  r.samples.push(sample)
  if (r.samples.length > r.capacity) r.samples.shift()
}

// --- ssh + collect ----------------------------------------------------------
//
// One exec per server, per poll. The script below is intentionally portable
// across Debian/Ubuntu/Raspbian and has fallbacks for tools that may not be
// installed (e.g. a Raspberry Pi without docker). Output is plain key=value
// lines so the parser stays trivial and resilient to ordering changes.
//
// What we collect:
//   - identity: hostname, kernel, distro (from /etc/os-release)
//   - uptime in seconds (read /proc/uptime)
//   - load average 1m / 5m / 15m (read /proc/loadavg)
//   - cpu% sampled twice 200ms apart from /proc/stat
//   - memory total / used / available in kB (from /proc/meminfo)
//   - disks: filesystem usage for the partitions we care about
//   - network: rx/tx bytes from /proc/net/dev for the non-loopback iface
//     with the most bytes (the primary link)
//   - docker: container count if /var/run/docker.sock can be queried via
//     `docker ps -q` (cheap, doesn't need the API)
//
// The whole thing runs in one ssh exec — one auth roundtrip per poll per
// server, which is the cost floor.

// Template literals would avoid (the comment is a holdover from an earlier
// shape of the constant); the script has ${...} for shell parameter
// expansion. Use a plain string with explicit \\n escapes so neither layer
// gets confused.
//
// Two bugs the original had and this fixes:
//   1. CPU% was always 99-100 because the bash builtin printf drops
//      fractional input: "%.2f" given "0.57" prints "0,00" (locale bug)
//      or "0" (bash printf discards fractions). Switched to awk for
//      numeric formatting — awk handles decimals correctly.
//   2. load1/5/15 was missing on servers with locale es_ES (comma decimal
//      separator). Same root cause: bash printf rejects "0,57" as a
//      number. awk doesn't have the issue.
// Force C locale at the top of the remote script so awk and any other
// command print decimals with a dot, not a comma. Some of the polled
// servers (server-17, server-19) run with es_ES or similar locales that
// default to comma decimals, which breaks the JSON parse downstream.
const REMOTE_SCRIPT = [
'export LC_ALL=C',
'set -u',
'printf \'hostname=%s\\n\' "$(hostname)"',
'printf \'kernel=%s\\n\' "$(uname -r)"',
'. /etc/os-release 2>/dev/null || PRETTY_NAME=unknown',
'printf \'distro=%s\\n\' "${PRETTY_NAME:-unknown}"',
'',
'U=$(awk \'{print int($1)}\' /proc/uptime)',
'printf \'uptime=%s\\n\' "$U"',
'',
'read L1 L5 L15 _ < /proc/loadavg',
'awk -v l1="$L1" -v l5="$L5" -v l15="$L15" \'BEGIN{printf "load1=%.2f\\nload5=%.2f\\nload15=%.2f\\n", l1, l5, l15}\'',
'',
'# CPU: snapshot /proc/stat twice 1s apart.',
'# /proc/stat `cpu` line is: user nice system idle iowait irq softirq steal guest guest_nice',
'# CPU% = (1 - idle_diff / total_diff) * 100. The previous version',
'# summed busy columns and divided by busy+idle, but the math was off',
'# by a factor (missing columns) that made every server read 100%.',
'T1=$(awk \'/^cpu / {idle=$5; for(i=2;i<=NF;i++) t+=$i; print idle"/"t}\' /proc/stat)',
'sleep 1',
'T2=$(awk \'/^cpu / {idle=$5; for(i=2;i<=NF;i++) t+=$i; print idle"/"t}\' /proc/stat)',
'awk -F/ -v a="$T1" -v b="$T2" \'BEGIN{split(a,a2,"/"); split(b,b2,"/"); idle=b2[1]-a2[1]; tot=b2[2]-a2[2]; if(tot>0) printf "cpu=%.1f\\n", (1-idle/tot)*100; else printf "cpu=0\\n"}\' 2>/dev/null || echo "cpu=0"',
'',
'MT=$(awk \'/^MemTotal:/ {print $2}\' /proc/meminfo)',
'MA=$(awk \'/^MemAvailable:/ {print $2}\' /proc/meminfo)',
'MU=$((MT - MA))',
'printf \'mem_total=%s\\nmem_used=%s\\nmem_avail=%s\\n\' "$MT" "$MU" "$MA"',
'',
'# Disks: show every real filesystem (mount starts with /dev or is on a',
'# real block device), excluding virtual filesystems and snap loops.',
'# The head -10 + sort -k2 is to keep the dashboard from being dominated',
'# by tiny mounts; on a Raspberry Pi the root partition is the biggest',
'# so it shows up first.',
'df -PB1 -x tmpfs -x devtmpfs -x squashfs 2>/dev/null | awk \'$1 ~ /^\\/dev\\// {gsub("%","",$5); printf "disk=%s,%s,%s\\n", $6, $3, $5}\' | sort -t, -k2 -nr | head -5',
'',
'NET=$(awk \'NR>2 && $1!~/:lo/ && $1!~/^Inter-/ {rx+=$2; tx+=$10} END {printf "%s %s", rx, tx}\' /proc/net/dev)',
'printf \'net_rx=%s\\nnet_tx=%s\\n\' $(echo $NET | cut -d\' \' -f1) $(echo $NET | cut -d\' \' -f2)',
'',
'if command -v docker >/dev/null 2>&1; then',
'  C=$(docker ps -q 2>/dev/null | wc -l)',
'  printf \'containers=%s\\n\' "$C"',
'else',
'  printf \'containers=0\\n\'',
'fi',
].join('\n')

// Parse the k=v lines the script emits. Single-value keys (cpu, mem_used,
// etc.) overwrite as before; multi-value keys (disk, network) accumulate
// into arrays so we don't drop partitions just because the kernel printed
// them in an order that overwrote the first one. The DISK_PREFIX list
// tells the parser which keys to treat as multi-value — extend it here if
// you add a new repeating metric to REMOTE_SCRIPT.
const MULTI_VALUE_PREFIXES = ['disk']

function parseScriptOutput(stdout) {
  const out = {}
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=')
    if (i < 0) continue
    const k = line.slice(0, i).trim()
    const v = line.slice(i + 1).trim()
    if (!k || v === '') continue
    if (MULTI_VALUE_PREFIXES.includes(k)) {
      if (!Array.isArray(out[k])) out[k] = []
      out[k].push(v)
    } else {
      out[k] = v
    }
  }
  return out
}

// Read the identity file path from the ssh config for a given Host alias.
// Parses ~/.ssh/config with a minimal grammar (Host / HostName / User /
// IdentityFile / IdentitiesOnly) — enough for the configs we use in this
// repo. Falls back to defaults if a key is missing.
function loadSshConfig(alias) {
  const path = resolve(SSH_KEYS_DIR, 'config')
  if (!existsSync(path)) return { host: alias, user: SSH_USER, identity: null }
  const cfg = { host: alias, user: SSH_USER, identity: null }
  let inBlock = false
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const lower = line.toLowerCase()
    if (lower.startsWith('host ')) {
      const patterns = line.slice(5).trim().split(/\s+/)
      inBlock = patterns.some(p => p === alias || (p.includes('*') && matchWildcard(p, alias)))
      continue
    }
    if (!inBlock) continue
    const m = line.match(/^(\S+)\s+(.+)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2]
    if (key === 'hostname') cfg.host = value
    else if (key === 'user') cfg.user = value
    else if (key === 'identityfile') cfg.identity = value.replace(/^~/, SSH_KEYS_DIR)
  }
  return cfg
}

// Tiny glob matcher so "Host server-*" patterns work if anyone ever adds them.
function matchWildcard(pattern, str) {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  return re.test(str)
}

// Run a single SSH exec and return parsed metrics or null on failure.
function pollServer(alias) {
  return new Promise(resolve => {
    const cfg = loadSshConfig(alias)
    if (!cfg.identity || !existsSync(cfg.identity)) {
      return resolve({ alias, ok: false, error: `no identity for ${alias}` })
    }
    const conn = new Client()
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      try { conn.end() } catch {}
      try { conn.destroy() } catch {}
      resolve(result)
    }
    const t = setTimeout(() => done({ alias, ok: false, error: 'connect timeout' }), SSH_CONNECT_TIMEOUT_MS)
    conn.on('ready', () => {
      clearTimeout(t)
      conn.exec(REMOTE_SCRIPT, { pty: false }, (err, stream) => {
        if (err) return done({ alias, ok: false, error: err.message })
        let out = '', errOut = ''
        const cmdT = setTimeout(() => {
          stream.close()
          done({ alias, ok: false, error: 'command timeout', partial: out })
        }, SSH_CMD_TIMEOUT_MS)
        stream.on('data', d => { out += d.toString('utf8') })
        stream.stderr.on('data', d => { errOut += d.toString('utf8') })
        stream.on('close', (code) => {
          clearTimeout(cmdT)
          if (code !== 0) return done({ alias, ok: false, error: `exit ${code}`, stderr: errOut.slice(0, 500), partial: out })
          const parsed = parseScriptOutput(out)
          done({ alias, ok: true, ts: Date.now(), cfg, ...parsed })
        })
      })
    })
    conn.on('error', (err) => { clearTimeout(t); done({ alias, ok: false, error: err.message }) })
    conn.on('timeout', () => { clearTimeout(t); done({ alias, ok: false, error: 'handshake timeout' }) })
    conn.connect({
      host: cfg.host,
      port: 22,
      username: cfg.user,
      privateKey: readFileSync(cfg.identity),
      readyTimeout: SSH_CONNECT_TIMEOUT_MS,
    })
  })
}

// --- state + scheduler ------------------------------------------------------

const state = {
  servers: {},
  history: {},
  lastPollAt: 0,
  pollErrors: 0,
}

for (const alias of SERVERS) {
  state.servers[alias] = { last: null, ok: false }
  state.history[alias] = {
    ts: makeRing(HISTORY_SAMPLES),
    cpu: makeRing(HISTORY_SAMPLES),
    mem: makeRing(HISTORY_SAMPLES),
    load1: makeRing(HISTORY_SAMPLES),
    net_rx: makeRing(HISTORY_SAMPLES),
    net_tx: makeRing(HISTORY_SAMPLES),
  }
}

async function pollAll() {
  const t0 = Date.now()
  const results = await Promise.all(SERVERS.map(pollServer))
  let okCount = 0
  for (const r of results) {
    const hist = state.history[r.alias]
    if (r.ok) {
      okCount++
      const cpu = +(r.cpu || 0)
      const memTotal = +(r.mem_total || 0)
      const memUsed = +(r.mem_used || 0)
      const memPct = memTotal > 0 ? +((memUsed / memTotal) * 100).toFixed(1) : 0
      const load1 = +(r.load1 || 0)
      const net_rx = +(r.net_rx || 0)
      const net_tx = +(r.net_tx || 0)
      // r.disk is an array of "mount,totalBytes,usedPct" strings (see
      // parseScriptOutput). Empty when df returned no real mounts.
      const diskLines = Array.isArray(r.disk) ? r.disk : (r.disk ? [r.disk] : [])
      const disks = diskLines.map(line => {
        const [mount, total, usedPct] = line.split(',')
        return { mount, totalGB: +(+(total || 0) / 1024 / 1024 / 1024).toFixed(1), usedPct: +(usedPct || 0) }
      })
      const sample = {
        ts: r.ts,
        cpu, memPct, memUsedMB: +(memUsed / 1024).toFixed(0), memTotalMB: +(memTotal / 1024).toFixed(0),
        load1, uptime: +(r.uptime || 0), distro: r.distro || 'unknown', kernel: r.kernel || '',
        hostname: r.hostname || '', containers: +(r.containers || 0), disks,
        net_rx_kbps: 0, net_tx_kbps: 0,
      }
      state.servers[r.alias] = { last: sample, ok: true }
      ringPush(hist.ts, sample.ts)
      ringPush(hist.cpu, cpu)
      ringPush(hist.mem, memPct)
      ringPush(hist.load1, load1)
      ringPush(hist.net_rx, net_rx)
      ringPush(hist.net_tx, net_tx)
      // Derive a per-sample kbps from the delta vs the previous sample, so the
      // dashboard shows throughput rather than a monotonically-growing counter.
      const prevNet = state.history[r.alias].net_rx.samples
      if (prevNet.length >= 2) {
        const dt = (sample.ts - hist.ts.samples[hist.ts.samples.length - 2]) / 1000
        if (dt > 0) {
          sample.net_rx_kbps = +(((net_rx - prevNet[prevNet.length - 2]) / dt) / 1024).toFixed(1)
          sample.net_tx_kbps = +(((net_tx - state.history[r.alias].net_tx.samples[state.history[r.alias].net_tx.samples.length - 2]) / dt) / 1024).toFixed(1)
        }
      }
    } else {
      state.servers[r.alias] = { last: state.servers[r.alias].last, ok: false, error: r.error }
    }
  }
  state.lastPollAt = Date.now()
  state.pollErrors = SERVERS.length - okCount
  if (okCount > 0) console.log(`[poll] ${okCount}/${SERVERS.length} ok in ${Date.now() - t0}ms`)
  if (state.pollErrors > 0) console.warn(`[poll] ${state.pollErrors} server(s) failed`)
}

setInterval(() => { pollAll().catch(e => console.error('poll error', e)) }, POLL_INTERVAL_MS)
pollAll()

// --- http --------------------------------------------------------------------

const app = express()
app.get('/api/cluster/status', (_req, res) => {
  res.json({
    pollIntervalMs: POLL_INTERVAL_MS,
    lastPollAt: state.lastPollAt,
    servers: Object.fromEntries(Object.entries(state.servers).map(([alias, s]) => [alias, s])),
    history: Object.fromEntries(Object.entries(state.history).map(([alias, h]) => [alias, {
      ts: h.ts.samples, cpu: h.cpu.samples, mem: h.mem.samples,
      load1: h.load1.samples, net_rx: h.net_rx.samples, net_tx: h.net_tx.samples,
    }])),
  })
})
app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }))
app.use(express.static(resolve(__dirname, 'public')))

app.listen(PORT, () => {
  const publicDir = resolve(__dirname, 'public')
  console.log(`cluster-dashboard listening on :${PORT}`)
  console.log(`polling ${SERVERS.length} server(s) every ${POLL_INTERVAL_MS}ms`)
  console.log(`serving static from ${publicDir} (exists: ${existsSync(publicDir)})`)
})
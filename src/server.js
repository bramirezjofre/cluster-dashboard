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
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from 'ssh2'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { check as checkAlerts } from './notifier.js'

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

// Long-term history lives in SQLite. Default path is inside the
// `cluster-dashboard-data` Docker volume mounted at /data so a container
// recreate doesn't wipe it. Retention is configurable via
// HISTORY_DAYS (default 30). PRAGMA journal_mode=WAL makes concurrent
// reads from the API endpoint safe with the writer from pollAll().
const DATA_DIR = process.env.ALERT_DATA_DIR || '/data'
const DB_PATH = process.env.DASHBOARD_DB || resolve(DATA_DIR, 'history.db')
const HISTORY_DAYS = +(process.env.HISTORY_DAYS || 30)

// /data is created and chowned to the daemon user by entrypoint.sh at
// container start (Docker creates the volume root-owned by default).
// Defensive mkdir here in case the daemon is ever run outside Docker
// (e.g. local dev) where there's no entrypoint.
try { mkdirSync(DATA_DIR, { recursive: true }) } catch (e) { /* */ }

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS samples (
    alias TEXT NOT NULL,
    ts INTEGER NOT NULL,
    cpu REAL, mem_pct REAL, mem_used_mb INTEGER, mem_total_mb INTEGER,
    load1 REAL, net_rx_kbps REAL, net_tx_kbps REAL,
    containers INTEGER, hostname TEXT,
    PRIMARY KEY (alias, ts)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_samples_alias_ts ON samples(alias, ts);

  CREATE TABLE IF NOT EXISTS container_snapshots (
    alias TEXT NOT NULL,
    ts INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (alias, ts)
  ) WITHOUT ROWID;
`)
const insertSample = db.prepare(`
  INSERT OR REPLACE INTO samples
    (alias, ts, cpu, mem_pct, mem_used_mb, mem_total_mb, load1, net_rx_kbps, net_tx_kbps, containers, hostname)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const insertContainerSnapshot = db.prepare(`
  INSERT OR REPLACE INTO container_snapshots (alias, ts, payload) VALUES (?, ?, ?)
`)
// Runs once on startup and then after every poll. Trims anything older
// than HISTORY_DAYS so the file doesn't grow unbounded.
function pruneOldSamples() {
  const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000
  db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff)
  db.prepare('DELETE FROM container_snapshots WHERE ts < ?').run(cutoff)
}
pruneOldSamples()
setInterval(pruneOldSamples, 60 * 60 * 1000)

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

// Run a single SSH exec against an alias. Returns a Promise<{ok, stdout,
// stderr, error}> — never throws. Used by pollServer (metrics) and the
// two on-demand endpoints below (containers list, container logs).
//
// The shape mirrors pollServer so callers can branch on ok/error
// uniformly. The script is passed as-is and exec'd via conn.exec.
function runSshCommand(alias, script, timeoutMs = SSH_CMD_TIMEOUT_MS) {
  return new Promise(resolve => {
    const cfg = loadSshConfig(alias)
    if (!cfg.identity || !existsSync(cfg.identity)) {
      return resolve({ ok: false, error: `no identity for ${alias}` })
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
    const t = setTimeout(() => done({ ok: false, error: 'connect timeout' }), SSH_CONNECT_TIMEOUT_MS)
    conn.on('ready', () => {
      clearTimeout(t)
      conn.exec(script, { pty: false }, (err, stream) => {
        if (err) return done({ ok: false, error: err.message })
        let out = '', errOut = ''
        const cmdT = setTimeout(() => {
          stream.close()
          done({ ok: false, error: 'command timeout', partial: out })
        }, timeoutMs)
        stream.on('data', d => { out += d.toString('utf8') })
        stream.stderr.on('data', d => { errOut += d.toString('utf8') })
        stream.on('close', (code) => {
          clearTimeout(cmdT)
          if (code !== 0) return done({ ok: false, error: `exit ${code}`, stderr: errOut.slice(0, 500), partial: out })
          done({ ok: true, stdout: out, stderr: errOut })
        })
      })
    })
    conn.on('error', (err) => { clearTimeout(t); done({ ok: false, error: err.message }) })
    conn.on('timeout', () => { clearTimeout(t); done({ ok: false, error: 'handshake timeout' }) })
    conn.connect({
      host: cfg.host,
      port: 22,
      username: cfg.user,
      privateKey: readFileSync(cfg.identity),
      readyTimeout: SSH_CONNECT_TIMEOUT_MS,
    })
  })
}

// Run a single SSH exec and return parsed metrics or null on failure.
function pollServer(alias) {
  return new Promise(resolve => {
    runSshCommand(alias, REMOTE_SCRIPT).then(r => {
      if (!r.ok) return resolve({ alias, ok: false, error: r.error })
      resolve({ alias, ok: true, ts: Date.now(), ...parseScriptOutput(r.stdout) })
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
      // Persist to SQLite for long-term history (survives restarts).
      // Worst-case disk growth: 5 servers × 1 sample/30s × ~80 bytes/row
      // × 30 days = ~3.5 MB. Trimming at HISTORY_DAYS caps it.
      insertSample.run(
        r.alias, sample.ts,
        sample.cpu, sample.memPct, sample.memUsedMB, sample.memTotalMB,
        sample.load1, sample.net_rx_kbps, sample.net_tx_kbps,
        sample.containers, sample.hostname
      )
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

// After every successful poll, look for things that crossed a threshold
// and fire a Telegram alert. The notifier is no-op when ALERT_ENABLED
// is false or when the bot token is unset, so this is safe to call
// unconditionally. We wrap the original pollAll so every caller (the
// initial startup poll and the interval tick) goes through the alert
// check too.
const _origPollAll = pollAll
pollAll = async function() {
  await _origPollAll()
  checkAlerts(state).catch(e => console.error('notifier error', e))
}

setInterval(pollAll, POLL_INTERVAL_MS)
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

// Long-term history query. Returns rows from SQLite for the given alias
// in a time window. Used by the dashboard when the user wants to see
// more than the in-memory ring buffer (which holds only the last 120
// samples = 1 hour). Defaults to "last 24 hours" when no window given.
// Caps response at 5000 rows so a wide window doesn't OOM the server.
app.get('/api/cluster/history', (req, res) => {
  const alias = String(req.query.alias || '')
  if (!alias) return res.status(400).json({ ok: false, error: 'alias required' })
  if (!SERVERS.includes(alias)) return res.status(404).json({ ok: false, error: `unknown server ${alias}` })
  const now = Date.now()
  const to = Math.max(0, Math.min(now, +(req.query.to || now)))
  const from = Math.max(0, Math.min(to, +(req.query.from || (to - 24 * 60 * 60 * 1000))))
  const limit = Math.max(1, Math.min(5000, +(req.query.limit || 5000)))
  const rows = db.prepare(`
    SELECT ts, cpu, mem_pct, mem_used_mb, mem_total_mb, load1,
           net_rx_kbps, net_tx_kbps, containers, hostname
    FROM samples
    WHERE alias = ? AND ts BETWEEN ? AND ?
    ORDER BY ts ASC
    LIMIT ?
  `).all(alias, from, to, limit)
  res.json({ ok: true, alias, from, to, count: rows.length, samples: rows })
})

// --- docker container inspection --------------------------------------------
//
// Two on-demand endpoints. Both SSH into the requested server and exec
// docker commands. We don't cache — the dashboard is meant to reflect
// the live state when the user clicks, not a 30s-stale snapshot.
//
// Containers list uses `docker ps -a` so stopped/exited containers are
// also visible (useful for spotting something that crashed in a poll
// interval). Each row has name, status (the short human string Docker
// shows), image, and uptime-from-created.
//
// Logs endpoint passes --tail=N to docker logs, which is cheap. We cap
// the response at 50 KB to avoid pathological cases (containers that
// emit huge single lines — webpack dev servers, JSON.stringify of
// large blobs — can produce many MB of stdout per "10 lines").

const LOG_TAIL_DEFAULT = 10
const LOG_TAIL_MAX = 200
const LOG_RESPONSE_CAP_BYTES = 50 * 1024

app.get('/api/server/:alias/containers', async (req, res) => {
  const alias = req.params.alias
  if (!SERVERS.includes(alias)) {
    return res.status(404).json({ ok: false, error: `unknown server ${alias}` })
  }
  // Use --format to get one record per line, pipe-separated. Names can
  // repeat on duplicate-container names but `docker ps` de-dupes by
  // default. `{{.Names}}` returns the first name if there are multiple.
  const script = `docker ps -a --no-trunc --format '{{.Names}}\\t{{.Status}}\\t{{.Image}}\\t{{.CreatedAt}}\\t{{.Ports}}' 2>&1`
  const r = await runSshCommand(alias, script, SSH_CMD_TIMEOUT_MS)
  if (!r.ok) {
    // If the server doesn't have docker at all, `docker ps` exits 1
    // with "command not found". Treat that as "no containers" rather
    // than an error so the modal can show a friendly message.
    if (/command not found|Cannot connect to the Docker daemon|no such file/i.test(r.error + (r.stderr || ''))) {
      return res.json({ ok: true, alias, containers: [], dockerAvailable: false })
    }
    return res.json({ ok: false, alias, error: r.error, stderr: (r.stderr || '').slice(0, 500) })
  }
  const containers = r.stdout
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const [name, status, image, createdAt, ports] = line.split('\t')
      return { name, status, image, createdAt, ports }
    })
  res.json({ ok: true, alias, containers, dockerAvailable: true })
})

app.get('/api/server/:alias/container/:name/logs', async (req, res) => {
  const alias = req.params.alias
  const name = req.params.name
  if (!SERVERS.includes(alias)) {
    return res.status(404).json({ ok: false, error: `unknown server ${alias}` })
  }
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    // Defensive: docker container names are restricted to this charset.
    // Reject anything else so a typo or path-traversal doesn't reach ssh.
    return res.status(400).json({ ok: false, error: 'invalid container name' })
  }
  const requested = Math.max(1, Math.min(LOG_TAIL_MAX, +(req.query.lines || LOG_TAIL_DEFAULT)))
  // 2>&1 merges stderr so we capture crash dumps from crashed containers.
  // We do NOT use -t (timestamps) here — the dashboard prepends the
  // fetch time to the response instead. `docker logs --timestamps`
  // would give us per-line timestamps but at the cost of an extra
  // second of parsing per line; we don't need that for a 10-line view.
  const script = `docker logs --tail=${requested} '${name.replace(/'/g, "'\\''")}' 2>&1`
  const r = await runSshCommand(alias, script, SSH_CMD_TIMEOUT_MS)
  if (!r.ok) {
    // `docker logs` returns exit 1 if the container doesn't exist.
    // Distinguish that from a real ssh failure so the UI can say
    // "container not found" vs "couldn't reach the server".
    if (/No such container|requires argument/i.test((r.stderr || '') + r.partial)) {
      return res.json({ ok: false, alias, name, error: `container "${name}" not found on ${alias}` })
    }
    return res.json({ ok: false, alias, name, error: r.error, stderr: (r.stderr || '').slice(0, 500) })
  }
  let logs = r.stdout || ''
  if (logs.length > LOG_RESPONSE_CAP_BYTES) {
    logs = logs.slice(0, LOG_RESPONSE_CAP_BYTES) + `\n\n… [truncated at ${LOG_RESPONSE_CAP_BYTES / 1024} KB]`
  }
  res.json({
    ok: true,
    alias,
    name,
    lines: requested,
    fetchedAt: Date.now(),
    logs,
  })
})

app.use(express.static(resolve(__dirname, 'public')))

app.listen(PORT, () => {
  const publicDir = resolve(__dirname, 'public')
  console.log(`cluster-dashboard listening on :${PORT}`)
  console.log(`polling ${SERVERS.length} server(s) every ${POLL_INTERVAL_MS}ms`)
  console.log(`serving static from ${publicDir} (exists: ${existsSync(publicDir)})`)
})
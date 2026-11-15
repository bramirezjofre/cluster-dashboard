// cluster-dashboard — Uptime Kuma integration (read side).
//
// Kuma is the service-level monitor: it probes the HTTP/TCP endpoints
// (the web endpoints you care about) and exposes the verdict as
// Prometheus metrics at GET /metrics. This module scrapes that endpoint
// and turns it into the shape the dashboard renders.
//
// Two Kuma-specific facts drive the design:
//
//   1. The API key is an HTTP Basic credential with an EMPTY username:
//      the key goes in the *password* field. Kuma parses the id out of
//      the key itself ("uk1_..." -> id 1) and bcrypt-verifies the rest
//      against the api_key table. `curl -u ":$KEY" ...` is the whole
//      contract.
//
//   2. There are TWO response-time metrics and they differ in unit AND
//      in shape:
//        monitor_response_time         -> milliseconds, NO window label
//        monitor_response_time_seconds -> seconds,     HAS window label
//      Reading the wrong one is a factor-1000 bug, so the parser matches
//      the exact metric name and only reads the window label off the
//      _seconds variant.
//
// The scrape is deliberately read-only: Kuma owns the monitor list, the
// dashboard owns the alerting. Nothing here creates, edits or deletes a
// monitor.

const METRIC_HEAD = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(.*)$/
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g

function unescapeLabelValue(v) {
  return v
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function parseLabels(raw) {
  const labels = {}
  if (!raw) return labels
  LABEL.lastIndex = 0
  let m
  while ((m = LABEL.exec(raw)) !== null) {
    labels[m[1]] = unescapeLabelValue(m[2])
  }
  return labels
}

// Parse one Prometheus exposition line:
//
//   name{label="value",...} 123
//
// Returns { name, labels, value } or null when the line is not a metric.
// The label block is scanned with a quote-aware brace matcher instead of
// a regex, because a label value may legitimately contain a `}` (a URL
// with a brace in it) and a greedy regex would truncate the label set.
function parseMetricLine(line) {
  const head = METRIC_HEAD.exec(line)
  if (!head) return null
  const name = head[1]
  let rest = head[2].trim()
  let labels = {}

  if (rest.startsWith('{')) {
    let inQuote = false
    let escaped = false
    let end = -1
    for (let i = 1; i < rest.length; i++) {
      const ch = rest[i]
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') { inQuote = !inQuote; continue }
      if (ch === '}' && !inQuote) { end = i; break }
    }
    if (end === -1) return null
    labels = parseLabels(rest.slice(1, end))
    rest = rest.slice(end + 1).trim()
  }

  const token = rest.split(/\s+/)[0]
  if (!token) return null
  const value = Number(token)
  return { name, labels, value: Number.isFinite(value) ? value : null }
}

// Parse a whole /metrics body into the list of monitors.
//
// Every monitor is keyed by its Kuma id, so the metrics that describe the
// same monitor (status, response time, uptime, certificate) merge into
// one entry regardless of the order Kuma emits them in.
export function parseKumaMetrics(text) {
  const monitors = new Map()

  const get = (labels) => {
    const id = labels.monitor_id
    if (id === undefined) return null
    let m = monitors.get(id)
    if (!m) {
      m = {
        id: Number(id),
        name: labels.monitor_name || `monitor ${id}`,
        type: labels.monitor_type || '',
        url: labels.monitor_url || '',
        hostname: labels.monitor_hostname || '',
        // Kuma labels the port as the literal string "null" for
        // non-port monitors; normalise it away.
        port: labels.monitor_port && labels.monitor_port !== 'null' ? labels.monitor_port : '',
        status: null,
        responseTimeMs: null,
        uptimeRatio30d: null,
        certDays: null,
        certValid: null,
      }
      monitors.set(id, m)
    }
    return m
  }

  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const p = parseMetricLine(line)
    if (!p || p.value === null) continue
    const { name, labels, value } = p

    switch (name) {
      case 'monitor_status': {
        const m = get(labels)
        if (m) m.status = value
        break
      }
      case 'monitor_response_time': {
        // Milliseconds, current probe. Distinct from the _seconds variant.
        const m = get(labels)
        if (m) m.responseTimeMs = value
        break
      }
      case 'monitor_uptime_ratio': {
        // The card shows the 30d window; 1d and 365d are emitted too.
        if (labels.window !== '30d') break
        const m = get(labels)
        if (m) m.uptimeRatio30d = value
        break
      }
      case 'monitor_cert_days_remaining': {
        const m = get(labels)
        if (m) m.certDays = value
        break
      }
      case 'monitor_cert_is_valid': {
        const m = get(labels)
        if (m) m.certValid = value === 1
        break
      }
    }
  }

  return [...monitors.values()].sort((a, b) => a.id - b.id)
}

// Normalise the configured URL to the metrics endpoint.
//
// Accepts either the base URL ("http://host:3002") or the full metrics
// URL ("http://host:3002/metrics"). Getting this wrong is easy and the
// symptom (a JSON 404 from whatever else answers on that port) is very
// misleading, so the input is normalised here instead of in the caller.
export function metricsUrl(url) {
  const base = String(url || '').trim().replace(/\/+$/, '')
  if (!base) return ''
  return /\/metrics$/.test(base) ? base : `${base}/metrics`
}

// Scrape Kuma's /metrics endpoint.
//
// Never throws: a failed scrape returns { ok: false, error } so a Kuma
// outage costs the dashboard one card, not the whole poll cycle.
export async function fetchKumaStatus({ url, apiKey, timeoutMs = 8000 } = {}) {
  const fetchedAt = Date.now()
  const target = metricsUrl(url)
  if (!target) return { ok: false, error: 'KUMA_URL not configured', monitors: [], fetchedAt }
  if (!apiKey) return { ok: false, error: 'KUMA_API_KEY not configured', monitors: [], fetchedAt }

  const auth = 'Basic ' + Buffer.from(':' + apiKey).toString('base64')
  try {
    const res = await fetch(target, {
      headers: { Authorization: auth, Accept: 'text/plain' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return {
        ok: false,
        error: `kuma ${res.status}: ${body.slice(0, 200).trim()}`,
        monitors: [],
        fetchedAt,
      }
    }
    const body = await res.text()
    return { ok: true, error: null, monitors: parseKumaMetrics(body), fetchedAt }
  } catch (e) {
    return { ok: false, error: e.message, monitors: [], fetchedAt }
  }
}

// Unit tests for the Uptime Kuma /metrics parser.
//
// Background — why this test exists
// ---------------------------------
// The dashboard renders service availability from Kuma's Prometheus
// endpoint. Two traps in that endpoint are invisible until they produce
// a wrong number on screen:
//
//   1. Kuma exports TWO response-time metrics with different units:
//        monitor_response_time         -> milliseconds
//        monitor_response_time_seconds -> seconds
//      Picking the wrong one shows "0.26 ms" for a service that actually
//      answered in 260 ms — or, with the _seconds value scaled up, a
//      service that answered in 4 ms showing as "4000 ms".
//
//   2. The uptime ratio comes in three windows (1d, 30d, 365d) as three
//      separate lines with the SAME metric name. A parser that keeps the
//      last one it saw ends up showing the 365d figure wherever 30d was
//      intended.
//
// The parser is also the thing that has to survive labels containing
// characters that would break a naive split — a URL with a query string,
// a monitor name with a comma.
//
// Run: node --test src/kuma.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseKumaMetrics, metricsUrl } from './kuma.js'

// A realistic slice of Kuma's /metrics output: two monitors, one http
// with a TLS certificate and one tcp port, both with the three uptime
// windows.
const SAMPLE = `
# HELP monitor_status Monitor status
# TYPE monitor_status gauge
monitor_status{monitor_id="1",monitor_name="Service A",monitor_type="http",monitor_url="http://10.0.0.1:8081/",monitor_hostname="",monitor_port="null"} 1
monitor_response_time{monitor_id="1",monitor_name="Service A",monitor_type="http",monitor_url="http://10.0.0.1:8081/",monitor_hostname="",monitor_port="null"} 379
monitor_response_time_seconds{monitor_id="1",monitor_name="Service A",monitor_type="http",monitor_url="http://10.0.0.1:8081/",monitor_hostname="",monitor_port="null",window="1d"} 0.24427569444444444
monitor_response_time_seconds{monitor_id="1",monitor_name="Service A",monitor_type="http",monitor_url="http://10.0.0.1:8081/",monitor_hostname="",monitor_port="null",window="30d"} 0.26011576265016373
monitor_uptime_ratio{monitor_id="1",monitor_name="Service A",monitor_type="http",monitor_url="http://10.0.0.1:8081/",monitor_hostname="",monitor_port="null",window="1d"} 1
monitor_uptime_ratio{monitor_id="1",monitor_name="Service A",monitor_type="http",monitor_url="http://10.0.0.1:8081/",monitor_hostname="",monitor_port="null",window="30d"} 0.9985
monitor_uptime_ratio{monitor_id="1",monitor_name="Service A",monitor_type="http",monitor_url="http://10.0.0.1:8081/",monitor_hostname="",monitor_port="null",window="365d"} 0.9
monitor_cert_days_remaining{monitor_id="1",monitor_name="Service A",monitor_type="http",monitor_url="http://10.0.0.1:8081/",monitor_hostname="",monitor_port="null"} 51
monitor_cert_is_valid{monitor_id="1",monitor_name="Service A",monitor_type="http",monitor_url="http://10.0.0.1:8081/",monitor_hostname="",monitor_port="null"} 1
monitor_status{monitor_id="2",monitor_name="Service B",monitor_type="port",monitor_url="10.0.0.1",monitor_hostname="10.0.0.1",monitor_port="2224"} 0
monitor_response_time{monitor_id="2",monitor_name="Service B",monitor_type="port",monitor_url="10.0.0.1",monitor_hostname="10.0.0.1",monitor_port="2224"} 25
monitor_uptime_ratio{monitor_id="2",monitor_name="Service B",monitor_type="port",monitor_url="10.0.0.1",monitor_hostname="10.0.0.1",monitor_port="2224",window="30d"} 0.99
`

test('parseKumaMetrics: returns one entry per monitor', () => {
  const monitors = parseKumaMetrics(SAMPLE)
  assert.equal(monitors.length, 2)
})

test('parseKumaMetrics: status 1 is up and 0 is down', () => {
  const [http, port] = parseKumaMetrics(SAMPLE)
  assert.equal(http.status, 1)
  assert.equal(port.status, 0)
})

test('parseKumaMetrics: response time comes from the MILLISECOND metric', () => {
  const [http] = parseKumaMetrics(SAMPLE)
  // monitor_response_time is 379; monitor_response_time_seconds is
  // 0.26. Reading the seconds one would report a 0 ms service.
  assert.equal(http.responseTimeMs, 379)
})

test('parseKumaMetrics: uptime ratio uses the 30d window, not 1d or 365d', () => {
  const [http] = parseKumaMetrics(SAMPLE)
  // 1d = 1, 30d = 0.9985, 365d = 0.9 — three different values for the
  // same metric name.
  assert.equal(http.uptimeRatio30d, 0.9985)
})

test('parseKumaMetrics: carries the monitor identity labels', () => {
  const [http, port] = parseKumaMetrics(SAMPLE)
  assert.equal(http.id, 1)
  assert.equal(http.name, 'Service A')
  assert.equal(http.type, 'http')
  assert.equal(http.url, 'http://10.0.0.1:8081/')
  assert.equal(port.type, 'port')
  assert.equal(port.hostname, '10.0.0.1')
  assert.equal(port.port, '2224')
})

test('parseKumaMetrics: the literal "null" port becomes an empty string', () => {
  const [http] = parseKumaMetrics(SAMPLE)
  assert.equal(http.port, '')
})

test('parseKumaMetrics: reads the certificate metrics', () => {
  const [http] = parseKumaMetrics(SAMPLE)
  assert.equal(http.certDays, 51)
  assert.equal(http.certValid, true)
})

test('parseKumaMetrics: sorts monitors by id', () => {
  const monitors = parseKumaMetrics(SAMPLE)
  assert.deepEqual(monitors.map(m => m.id), [1, 2])
})

test('parseKumaMetrics: skips comments and blank lines', () => {
  const body = '# HELP x x\n# TYPE x gauge\n\n   \nmonitor_status{monitor_id="9",monitor_name="a",monitor_type="http",monitor_url="u",monitor_hostname="",monitor_port="null"} 1\n'
  const monitors = parseKumaMetrics(body)
  assert.equal(monitors.length, 1)
  assert.equal(monitors[0].id, 9)
})

test('parseKumaMetrics: a monitor with no status line still appears', () => {
  const body = 'monitor_uptime_ratio{monitor_id="7",monitor_name="solo",monitor_type="http",monitor_url="u",monitor_hostname="",monitor_port="null",window="30d"} 0.5\n'
  const monitors = parseKumaMetrics(body)
  assert.equal(monitors.length, 1)
  assert.equal(monitors[0].status, null)
  assert.equal(monitors[0].uptimeRatio30d, 0.5)
})

test('parseKumaMetrics: empty input yields an empty list', () => {
  assert.deepEqual(parseKumaMetrics(''), [])
  assert.deepEqual(parseKumaMetrics('\n\n'), [])
})

test('parseKumaMetrics: a label value containing a brace does not truncate the parse', () => {
  // A monitor url with a JSON-ish query string. A greedy `.*}` label
  // matcher would swallow the trailing labels and lose the window.
  const body = 'monitor_uptime_ratio{monitor_id="3",monitor_name="weird",monitor_type="http",monitor_url="http://x/?a={b}",monitor_hostname="",monitor_port="null",window="30d"} 0.75\n'
  const monitors = parseKumaMetrics(body)
  assert.equal(monitors.length, 1)
  assert.equal(monitors[0].uptimeRatio30d, 0.75)
  assert.equal(monitors[0].url, 'http://x/?a={b}')
})

test('parseKumaMetrics: a monitor name with a comma and quotes survives', () => {
  const body = 'monitor_status{monitor_id="4",monitor_name="a, b \\"c\\"",monitor_type="http",monitor_url="u",monitor_hostname="",monitor_port="null"} 1\n'
  const monitors = parseKumaMetrics(body)
  assert.equal(monitors[0].name, 'a, b "c"')
})

test('parseKumaMetrics: unrelated metrics are ignored', () => {
  const body = 'process_cpu_seconds_total 42\nmonitor_status{monitor_id="5",monitor_name="x",monitor_type="http",monitor_url="u",monitor_hostname="",monitor_port="null"} 1\n'
  const monitors = parseKumaMetrics(body)
  assert.equal(monitors.length, 1)
  assert.equal(monitors[0].id, 5)
})

test('metricsUrl: appends /metrics to a base URL', () => {
  assert.equal(metricsUrl('http://10.0.0.2:3002'), 'http://10.0.0.2:3002/metrics')
})

test('metricsUrl: leaves an explicit /metrics URL alone', () => {
  assert.equal(metricsUrl('http://10.0.0.2:3002/metrics'), 'http://10.0.0.2:3002/metrics')
})

test('metricsUrl: tolerates a trailing slash', () => {
  assert.equal(metricsUrl('http://10.0.0.2:3002/'), 'http://10.0.0.2:3002/metrics')
})

test('metricsUrl: an empty URL stays empty', () => {
  assert.equal(metricsUrl(''), '')
  assert.equal(metricsUrl(undefined), '')
})

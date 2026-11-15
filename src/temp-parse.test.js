// Tests for the CPU temperature collection.
//
// Background — why this exists
// -----------------------------
// The dashboard collects CPU/memory/disk over SSH with one remote script.
// Temperature was added on request: "is it possible to show the CPU
// temperature of each server?"
//
// The answer is yes on every monitored host, but NOT with the same
// mechanism, and that is where the bugs live:
//
//  1. `sensors` is not installed on most hosts. Only server-19 and
//     server-agentes have it. Reading /sys/class/... needs no package
//     and works everywhere, so the remote script reads /sys directly.
//
//  2. The source differs per machine:
//       server-11       (Raspberry Pi)  hwmon "cpu_thermal"
//       server-17       (x86)          thermal_zone type=x86_pkg_temp
//       server-18       (x86)          thermal_zone type=x86_pkg_temp
//       server-19       (AMD)          hwmon "k8temp"
//       server-agentes  (x86)          hwmon "coretemp"
//     So the script tries them in order of reliability and falls back.
//
//  3. Some drivers report a bogus value for unused channels: server-19
//     reports 4294918296 for k8temp/temp3_input (an unsigned overflow,
//     i.e. 4294°C). Reading that without a range check would show
//     "4294°C" in the UI and break the sparkline. Anything outside
//     0..200000 is discarded.
//
//  4. "No sensor at all" is null, NOT 0. A host with no thermal sensor
//     must render as "—", because 0°C is a legitimate (if absurd)
//     reading and a sentinel number would be a lie.
//
// Run: node --test src/temp-parse.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_JS = resolve(__dirname, 'server.js')
const INDEX_HTML = resolve(__dirname, '..', 'public', 'index.html')
const src = readFileSync(SERVER_JS, 'utf8')
const html = readFileSync(INDEX_HTML, 'utf8')

test('the remote script reads the temperature from /sys', () => {
  assert.ok(
    src.includes('temp_c='),
    'the remote script must emit a temp_c key',
  )
  assert.ok(
    src.includes('x86_pkg_temp'),
    'the script must prefer the x86 CPU package sensor',
  )
  assert.ok(
    src.includes('coretemp|k8temp|cpu_thermal'),
    'the script must know the per-vendor hwmon sensor names',
  )
})

test('the remote script does not depend on the sensors package', () => {
  // `sensors` is only installed on 2 of the 5 hosts. A script that calls
  // it would report no temperature on the other three.
  assert.ok(
    !/\bsensors\b\s*\|/.test(src),
    'the remote script must not shell out to sensors (not installed everywhere)',
  )
  assert.ok(
    src.includes('/sys/class/thermal/thermal_zone'),
    'the script must read the thermal zones',
  )
})

test('out-of-range readings are discarded', () => {
  // server-19/k8temp/temp3_input reports 4294918296 (unsigned overflow).
  // The guard is a range check on the raw millidegree value.
  assert.ok(
    src.includes('200000'),
    'the script must bound the accepted temperature range (200000 = 200°C)',
  )
  assert.ok(
    src.includes('-le 200000'),
    'the script must discard readings above the range check',
  )
  assert.ok(
    src.includes('-ge 0'),
    'the script must discard negative readings',
  )
})

test('a missing sensor is null, not 0', () => {
  // The backend distinguishes "no sensor" (null) from a real 0°C reading.
  assert.ok(
    src.includes('tempC, tempLabel'),
    'the sample must carry tempC and tempLabel',
  )
  assert.ok(
    /tempRaw = r\.temp_c === undefined \|\| r\.temp_c === '' \? null : Number\(r\.temp_c\)/.test(src),
    'an absent temp_c must become null, not 0',
  )
  assert.ok(
    src.includes('Number.isFinite(tempRaw) ? tempRaw : null'),
    'a non-numeric temp_c must become null',
  )
})

test('the frontend renders the temperature', () => {
  assert.ok(
    html.includes('Temp CPU'),
    'the server card must show a CPU temperature stat',
  )
  assert.ok(
    html.includes('tempC === null'),
    'the frontend must handle a missing temperature',
  )
  assert.ok(
    html.includes('°C'),
    'the temperature must be labelled with its unit',
  )
})

test('the temperature has its own color thresholds', () => {
  // Reusing the CPU-percentage thresholds would flag a server at 75°C as
  // "warn" on a percentage scale and mis-colour the bar.
  assert.ok(
    html.includes("kind === 'temp'"),
    'colorFor must handle the temp kind',
  )
  assert.ok(
    /kind === 'temp'\) return pct >= 90 \? 'bad' : pct >= 75 \? 'warn' : ''/.test(html),
    'thermal thresholds must be temperature-based (warn at 75°C, bad at 90°C)',
  )
})

test('the temperature is persisted in the history database', () => {
  assert.ok(
    src.includes('ALTER TABLE samples ADD COLUMN temp_c'),
    'the schema migration must add the temp_c column',
  )
  assert.ok(
    src.includes('temp_c REAL'),
    'the samples table must store the temperature',
  )
  assert.ok(
    /SELECT ts, cpu,[\s\S]*temp_c\s*\n\s*FROM samples/.test(src),
    'the history query must select temp_c',
  )
})

test('the temperature series is exposed to the frontend', () => {
  assert.ok(
    src.includes('temp: h.temp.samples'),
    'the status payload must expose the temp series',
  )
  assert.ok(
    html.includes('temp: mergeOne(live.temp'),
    'the frontend must merge the historical temp series',
  )
  assert.ok(
    html.includes('s.temp_c'),
    'the frontend must read temp_c from the history API',
  )
})

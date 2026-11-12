// Regression tests for the disk-line parser.
//
// Background — why this test exists
// ----------------------------------
// The dashboard's disk alert used to read:
//
//   💾 server-agentes disk alert
//   used: 65% of 70.4 GB
//
// on a disk whose real capacity was 115 GB.
//
// The remote script ran `df -PB1` and the JS parser took the third column
// ($3), which in `df -PB1` output is **Used** — not the size. It then
// divided that by 1024^3 and labelled the result "totalGB". So the
// "total" in the alert was really the used space, and the percentage (65%)
// came from df's Capacity column, which is Used/(Used+Available) rather
// than Used/Size.
//
// The result was a message whose percentage and volume described two
// different quantities, and the free space was never shown at all — so
// there was no way to tell whether the disk actually needed attention.
//
// The parser now carries all three byte counters (size, used, available)
// and the alert shows them together.
//
// Run: node --test src/disk-parse.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_JS = resolve(__dirname, 'server.js')
const src = readFileSync(SERVER_JS, 'utf8')

// server.js calls app.listen() at import time, so it cannot be imported by
// a test without opening a port. Extract the parser function from the
// source and evaluate it standalone — the same technique the other
// regression tests in this repo use.
function loadParseDiskLine() {
  const start = src.indexOf('export function parseDiskLine')
  assert.ok(start !== -1, 'server.js must export parseDiskLine')
  const end = src.indexOf('\n}', start)
  assert.ok(end !== -1, 'parseDiskLine must have a closing brace')
  const body = src.slice(start, end + 2).replace('export function', 'function')
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return parseDiskLine`)()
}

const parseDiskLine = loadParseDiskLine()

const GB = 1024 * 1024 * 1024

test('parseDiskLine returns the real total, not the used column', () => {
  // A real line from `df -PB1` on ubuntu-vane:
  // /dev/mapper/ubuntu--vg-ubuntu--lv 123576930304 74072838144 43822972928 63% /
  const line = `/,${123576930304},${74072838144},${43822972928},63`
  const d = parseDiskLine(line)
  assert.ok(d, 'a well-formed line must parse')
  assert.equal(d.mount, '/')
  assert.equal(d.totalGB, 115.1)          // the real Size column
  assert.equal(d.usedGB, 69.0)            // the Used column
  assert.equal(d.availGB, 40.8)           // the Available column
  assert.equal(d.usedPct, 63)
})

test('totalGB is not the usedGB value', () => {
  // The exact regression: the old parser reported 69.0 GB as "totalGB"
  // for a 115 GB disk. Guard against the two collapsing again.
  const d = parseDiskLine(`/,${123576930304},${74072838144},${43822972928},63`)
  assert.notEqual(d.totalGB, d.usedGB)
  assert.ok(
    d.totalGB > d.usedGB,
    'total must be greater than used — otherwise the columns are swapped again',
  )
})

test('the alert shows used, free and total together', () => {
  const notifier = readFileSync(resolve(__dirname, 'notifier.js'), 'utf8')
  assert.ok(
    notifier.includes('usedGB') && notifier.includes('availGB'),
    'the disk alert must carry the used and free volumes, not just a percentage',
  )
  assert.ok(
    notifier.includes('GB free'),
    'the disk alert must state how much space is free',
  )
})

test('the remote script emits all three byte counters unscaled', () => {
  // $2 = Size, $3 = Used, $4 = Available. If any of them is dropped from
  // the awk pipeline the parser can no longer distinguish them.
  //
  // -B1 sets df's block size to 1 byte, so the counters are ALREADY bytes.
  // Multiplying them again (a `*512` was tried and shipped briefly) inflates
  // every volume by 512x: a 115 GB disk showed up as 58 926 GB.
  assert.ok(
    src.includes('$6, $2, $3, $4, $5'),
    'the df pipeline must pass Size, Used and Available through unscaled',
  )
  assert.ok(
    !/\$[234]\s*\*\s*512/.test(src),
    'the df counters are already bytes with -B1; multiplying by 512 inflates them 512x',
  )
})

test('volumes are in GB, not in 512x-inflated bytes', () => {
  // The exact regression of the *512 bug: 123576930304 bytes is 115.1 GB.
  const d = parseDiskLine(`/,${123576930304},${74072838144},${43822972928},63`)
  assert.equal(d.totalGB, 115.1)
  assert.ok(
    d.totalGB < 1000,
    `a 115 GB disk must not report as ${d.totalGB} GB`,
  )
})

test('malformed lines are rejected instead of producing bogus numbers', () => {
  for (const bad of ['', 'garbage', '/,123', '/,abc,def,ghi,jkl', 'null', 'undefined']) {
    assert.equal(parseDiskLine(bad), null, `must reject: ${JSON.stringify(bad)}`)
  }
})

test('a zero-size filesystem is rejected', () => {
  // Some pseudo-mounts report Size 0; dividing by it would produce NaN.
  assert.equal(parseDiskLine(`/proc,0,0,0,0`), null)
})

test('a mount with no capacity is not silently reported as 0 GB', () => {
  const d = parseDiskLine(`/mnt/data,${458 * GB},${189 * GB},${246 * GB},44`)
  assert.equal(d.totalGB, 458)
  assert.equal(d.usedGB, 189)
  assert.equal(d.availGB, 246)
  assert.equal(d.usedPct, 44)
})

// src/iface_traffic.test.js
//
// Unit tests for src/iface_traffic.js. Uses node:fs.mkdtempSync to
// create a fake /sys/class/net tree; no real interfaces are touched.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  parseByteCounter,
  deriveKbps,
  readCounters,
  sampleIface,
  formatRate,
} from './iface_traffic.js'

function makeFakeSys() {
  const base = mkdtempSync(join(tmpdir(), 'iface-traffic-'))
  return { base, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

function makeIface(base, name, rx, tx) {
  const dir = join(base, name, 'statistics')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'rx_bytes'), String(rx) + '\n')
  writeFileSync(join(dir, 'tx_bytes'), String(tx) + '\n')
}

// ─── parseByteCounter ────────────────────────────────────────────────────

test('parseByteCounter: standard decimal', () => {
  assert.equal(parseByteCounter('12345\n'), 12345n)
})

test('parseByteCounter: large number (BigInt)', () => {
  const big = '18446744073709551615' // 2^64 - 1
  assert.equal(parseByteCounter(big + '\n'), BigInt(big))
})

test('parseByteCounter: rejects empty', () => {
  assert.throws(() => parseByteCounter(''), /empty/)
})

test('parseByteCounter: rejects non-numeric', () => {
  assert.throws(() => parseByteCounter('not a number\n'), /non-numeric/)
})

// ─── deriveKbps ──────────────────────────────────────────────────────────

test('deriveKbps: 1MB in 1s = 8000 Kbps', () => {
  // 1_000_000 bytes * 8 = 8_000_000 bits / 1000 ms = 8000 Kbps
  assert.equal(deriveKbps(0, 1_000_000n, 1000), 8000)
})

test('deriveKbps: zero delta = 0 Kbps', () => {
  assert.equal(deriveKbps(1000n, 1000n, 1000), 0)
})

test('deriveKbps: backwards delta (counter reset) = 0', () => {
  // Counter went from 1_000_000 down to 100 → NIC reset. Don't extrapolate.
  assert.equal(deriveKbps(1_000_000n, 100n, 1000), 0)
})

test('deriveKbps: elapsed = 0 returns 0 (defensive)', () => {
  assert.equal(deriveKbps(0, 1000n, 0), 0)
})

test('deriveKbps: accepts Number for bytes too', () => {
  // Convenience for callers that don't want BigInt ceremony.
  assert.equal(deriveKbps(0, 125000, 1000), 1000) // 1Mbps
})

// ─── readCounters ────────────────────────────────────────────────────────

test('readCounters: reads rx and tx from injected base', () => {
  const { base, cleanup } = makeFakeSys()
  try {
    makeIface(base, 'eth0', 100, 200)
    const r = readCounters('eth0', base)
    assert.equal(r.ok, true)
    assert.equal(r.rx, 100n)
    assert.equal(r.tx, 200n)
  } finally { cleanup() }
})

test('readCounters: missing iface returns ok=false with error', () => {
  const { base, cleanup } = makeFakeSys()
  try {
    const r = readCounters('nonexistent', base)
    assert.equal(r.ok, false)
    assert.match(r.error, /ENOENT|not found/i)
  } finally { cleanup() }
})

test('readCounters: non-numeric content returns ok=false', () => {
  const { base, cleanup } = makeFakeSys()
  try {
    const dir = join(base, 'eth0', 'statistics')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'rx_bytes'), '???\n')
    writeFileSync(join(dir, 'tx_bytes'), '500\n')
    const r = readCounters('eth0', base)
    assert.equal(r.ok, false)
    assert.match(r.error, /non-numeric/)
  } finally { cleanup() }
})

// ─── sampleIface ─────────────────────────────────────────────────────────

test('sampleIface: first sample returns 0 Kbps', () => {
  const { base, cleanup } = makeFakeSys()
  try {
    makeIface(base, 'eth0', 1000, 2000)
    const snap = sampleIface('eth0', null, 1000, base)
    assert.equal(snap.ok, true)
    assert.equal(snap.rx, 1000n)
    assert.equal(snap.tx, 2000n)
    assert.equal(snap.ts, 1000)
    assert.equal(snap.rxKbps, 0) // first sample, no prev
    assert.equal(snap.txKbps, 0)
  } finally { cleanup() }
})

test('sampleIface: second sample derives Kbps from delta', () => {
  const { base, cleanup } = makeFakeSys()
  try {
    makeIface(base, 'eth0', 0, 0)
    const first = sampleIface('eth0', null, 1000, base)
    // 1 second later, 1MB RX and 2MB TX accumulated
    makeIface(base, 'eth0', 1_000_000, 2_000_000)
    const second = sampleIface('eth0', first, 2000, base)
    assert.equal(second.rxKbps, 8000)  // 1MB/s RX = 8000 Kbps
    assert.equal(second.txKbps, 16000) // 2MB/s TX = 16000 Kbps
  } finally { cleanup() }
})

test('sampleIface: missing iface returns ok=false but preserves shape', () => {
  const { base, cleanup } = makeFakeSys()
  try {
    const snap = sampleIface('ghost', null, 1000, base)
    assert.equal(snap.ok, false)
    assert.equal(snap.rx, 0n)
    assert.equal(snap.tx, 0n)
    assert.equal(snap.rxKbps, 0)
    assert.match(snap.error, /ENOENT|no such file/i)
  } finally { cleanup() }
})

// ─── formatRate ──────────────────────────────────────────────────────────

test('formatRate: under 1000 Kbps shows as Kbps', () => {
  assert.equal(formatRate(500), '500 Kbps')
})

test('formatRate: 1000+ shows as Mbps with 1 decimal', () => {
  assert.equal(formatRate(1500), '1.5 Mbps')
})

test('formatRate: 1_000_000+ shows as Gbps', () => {
  assert.equal(formatRate(1_500_000), '1.50 Gbps')
})

test('formatRate: 0 / negative / NaN → "0 Kbps"', () => {
  assert.equal(formatRate(0), '0 Kbps')
  assert.equal(formatRate(-5), '0 Kbps')
  assert.equal(formatRate(NaN), '0 Kbps')
})

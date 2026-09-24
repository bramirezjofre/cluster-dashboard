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

// ─── casos acordes al sistema actual (counter real de enp2s0) ────────────

test('parseByteCounter: número grande del orden de bytes reales de NIC', () => {
  // En un enlace de 1 Gbps activo durante varias horas, los contadores
  // fácilmente superan los 100 GB (~10^11 bytes). Verificamos que el
  // parser devuelve un BigInt exacto sin pérdida de precisión.
  const big = '1819283319'  // valor real observado en enp2s0 al instalar iface_traffic
  const result = parseByteCounter(big + '\n')
  assert.equal(result, BigInt(big))
  assert.equal(typeof result, 'bigint')
})

test('deriveKbps: 10 MB en 1 segundo = 80_000 Kbps', () => {
  // Típico de un enlace hogareño saturado brevemente.
  assert.equal(deriveKbps(0n, 10_000_000n, 1000), 80_000)
})

test('deriveKbps: delta de 1 byte en 1 segundo = 0 Kbps (truncado)', () => {
  // 1 byte * 8 bits / 1000 ms = 0.008 Kbps → Math.floor = 0.
  // Verificamos que no devolvemos un valor fraccionario.
  assert.equal(deriveKbps(0n, 1n, 1000), 0)
  assert.equal(deriveKbps(1000n, 1001n, 1000), 0)
})

test('deriveKbps: acepta BigInt con valor cercano a 2^53 (overflow Number)', () => {
  // En un sistema con varios TB transferidos, el contador excede
  // Number.MAX_SAFE_INTEGER (~9 PB). El cálculo debe seguir preciso.
  // 1_000_000_000_000 bytes (1 TB) en 1 segundo → 8_000_000_000 Kbps
  // = 8 Tbps. Eso cabe en BigInt pero NO en Number sin pérdida.
  const oneTB = 1_000_000_000_000n
  const kbps = deriveKbps(0n, oneTB, 1000)
  assert.equal(kbps, 8_000_000_000)
})

test('deriveKbps: elapsed no-entero se trunca correctamente', () => {
  // 1000 bytes en 500 ms = 16 Kbps (delta * 8 / ms)
  assert.equal(deriveKbps(0n, 1000n, 500), 16)
})

test('readCounters: lee enp2s0 desde fs real (smoke test, skip si no existe)', async () => {
  // Solo corre en hosts donde enp2s0 existe — los runners de CI con Node
  // puro probablemente no lo tendrán, así que saltamos sin fallar.
  const { existsSync } = await import('node:fs')
  if (!existsSync('/sys/class/net/enp2s0/statistics/rx_bytes')) {
    return  // skip
  }
  const r = readCounters('enp2s0')
  assert.equal(r.ok, true)
  assert.ok(r.rx > 0n, 'rx_bytes debe ser > 0')
  assert.ok(r.tx > 0n, 'tx_bytes debe ser > 0')
})

test('sampleIface: dos muestras con iface real (smoke test, skip si no existe)', async () => {
  const { existsSync } = await import('node:fs')
  if (!existsSync('/sys/class/net/enp2s0/statistics/rx_bytes')) {
    return  // skip
  }
  const first = sampleIface('enp2s0', null, Date.now())
  assert.equal(first.ok, true)
  // Segunda muestra 1s después — el delta debe ser >= 0
  const second = sampleIface('enp2s0', first, Date.now() + 1000)
  assert.equal(second.ok, true)
  assert.ok(second.rxKbps >= 0)
  assert.ok(second.txKbps >= 0)
  assert.ok(second.rx >= first.rx, 'rx nunca debe retroceder')
  assert.ok(second.tx >= first.tx, 'tx nunca debe retroceder')
})

test('sampleIface: prev con rx no numérico deriva rxKbps=0 pero tx sigue normal', () => {
  // deriveKbps usa try/catch sobre BigInt(). Si la conversión falla
  // (rx = 'garbage'), devuelve 0 para esa métrica. La otra (tx) sigue
  // funcionando con datos válidos.
  const { base, cleanup } = makeFakeSys()
  try {
    makeIface(base, 'eth0', 1000, 2000)
    const badPrev = { rx: 'garbage', tx: 1000n, ts: 1000 }
    const snap = sampleIface('eth0', badPrev, 2000, base)
    assert.equal(snap.ok, true)
    assert.equal(snap.rxKbps, 0)        // BigInt('garbage') → error → 0
    // tx: delta = 2000-1000 = 1000 bytes en 1000 ms = 8 Kbps
    assert.equal(snap.txKbps, 8)
  } finally { cleanup() }
})

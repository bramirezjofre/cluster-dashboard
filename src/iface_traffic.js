// src/iface_traffic.js
//
// Reads byte counters from /sys/class/net/<iface>/statistics/{rx,tx}_bytes
// and derives Kbps between samples. Used by the LAN card in the dashboard
// to show real-time traffic on the host's LAN interface (enp2s0 by
// default) when SNMP to the ISP router is not available.
//
// All filesystem paths are injectable so tests can run without root.

import { readFileSync } from 'node:fs'

const SYS_BASE_DEFAULT = '/sys/class/net'

/**
 * Parse the content of rx_bytes or tx_bytes — a single decimal number
 * followed by newline. Returns the number as a BigInt. BigInt because
 * counters on a busy gigabit link overflow Number within hours.
 *
 * Throws on non-numeric content or empty input — those indicate a real
 * problem (interface removed, permission denied) and should surface.
 */
export function parseByteCounter(content) {
  if (content == null || content === '') {
    throw new Error('empty counter file')
  }
  // Trim trailing newline + whitespace; reject anything else non-digit.
  const trimmed = content.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`non-numeric counter: ${JSON.stringify(content)}`)
  }
  return BigInt(trimmed)
}

/**
 * Compute the rate in Kbps (kilobits per second, where 1 KB = 1000 bits)
 * given two byte counter samples and the time between them in ms.
 *
 * - bytesA, bytesB: BigInt or number
 * - elapsedMs: number > 0
 *
 * Returns 0 if the counter went backwards (NIC reset, link flap) — we
 * don't try to extrapolate, the next poll will produce a valid rate.
 * Returns 0 if elapsedMs is 0 (defensive; shouldn't happen in practice).
 */
export function deriveKbps(bytesA, bytesB, elapsedMs) {
  if (elapsedMs <= 0) return 0
  let delta
  try {
    delta = BigInt(bytesB) - BigInt(bytesA)
  } catch {
    return 0
  }
  if (delta < 0n) return 0
  // Kbps = (deltaBytes * 8 / 1000) * (1000 / elapsedMs)
  //        = deltaBytes * 8 / elapsedMs   (kbps = kilobits per second)
  // We do this in integer math and round down to whole Kbps.
  const kbps = (delta * 8n) / BigInt(elapsedMs)
  // Convert to number with a sanity cap: anything above Number.MAX_SAFE_INTEGER
  // is almost certainly a counter overflow we should treat as 0.
  const kbpsNum = Number(kbps)
  if (!Number.isFinite(kbpsNum) || kbpsNum > Number.MAX_SAFE_INTEGER) {
    return 0
  }
  return Math.floor(kbpsNum)
}

/**
 * Read both rx and tx bytes for an interface in a single snapshot.
 *
 * @param iface  e.g. 'enp2s0'
 * @param base   filesystem base; defaults to /sys/class/net
 * @returns      { rx: bigint, tx: bigint, ok: true } on success,
 *               { ok: false, error } on any failure
 */
export function readCounters(iface, base = SYS_BASE_DEFAULT) {
  const rxPath = `${base}/${iface}/statistics/rx_bytes`
  const txPath = `${base}/${iface}/statistics/tx_bytes`
  try {
    const rx = parseByteCounter(readFileSync(rxPath, 'utf8'))
    const tx = parseByteCounter(readFileSync(txPath, 'utf8'))
    return { ok: true, rx, tx }
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) }
  }
}

/**
 * Polling function: returns a snapshot suitable for both display and
 * persistence. Caller is expected to keep the previous snapshot in
 * memory to derive a rate; this module returns the raw counters plus
 * the derived Kbps (using the prev snapshot passed in).
 *
 * @param iface    e.g. 'enp2s0'
 * @param prev     { rx, tx, ts } from the previous poll (omit on first call)
 * @param now      Date.now() value; injectable for tests
 * @param base     filesystem base; defaults to /sys/class/net
 * @returns        {
 *                   iface, rx, tx, ts,
 *                   rxKbps: number, txKbps: number,  // 0 on first sample
 *                   ok: boolean,
 *                   error?: string
 *                 }
 */
export function sampleIface(iface, prev, now = Date.now(), base = SYS_BASE_DEFAULT) {
  const counters = readCounters(iface, base)
  if (!counters.ok) {
    return {
      iface,
      rx: 0n, tx: 0n,
      ts: now,
      rxKbps: 0, txKbps: 0,
      ok: false,
      error: counters.error,
    }
  }

  let rxKbps = 0, txKbps = 0
  if (prev && Number.isFinite(prev.ts)) {
    const elapsed = now - prev.ts
    rxKbps = deriveKbps(prev.rx, counters.rx, elapsed)
    txKbps = deriveKbps(prev.tx, counters.tx, elapsed)
  }

  return {
    iface,
    rx: counters.rx,
    tx: counters.tx,
    ts: now,
    rxKbps,
    txKbps,
    ok: true,
  }
}

/**
 * Format a Kbps number for display: 999 → "999 Kbps", 1234 → "1.2 Mbps".
 * Returns the input unchanged on 0/NaN/negative.
 */
export function formatRate(kbps) {
  if (!Number.isFinite(kbps) || kbps <= 0) return '0 Kbps'
  if (kbps < 1000) return `${Math.round(kbps)} Kbps`
  if (kbps < 1_000_000) return `${(kbps / 1000).toFixed(1)} Mbps`
  return `${(kbps / 1_000_000).toFixed(2)} Gbps`
}

// ARP scanner. Pings every host in the given subnet in parallel batches,
// then reads the kernel ARP cache to collect IP/MAC pairs.
//
// Exports:
//   arpScan({ subnet, timeoutMs, batchSize }) -> Promise<Array<{ip, mac}>>
//   parseNeighOutput(text) -> Array<{ip, mac}>  (pure, for tests)

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

// Convert "192.168.0.0/24" -> [{start: 1, end: 254}] (we always exclude .0 and .255)
function subnetToRange(subnet) {
  const m = subnet.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:\/(\d+))?$/)
  if (!m) throw new Error(`bad subnet: ${subnet}`)
  const [, a, b, c, d] = m.map(Number)
  return { base: `${a}.${b}.${c}`, start: 1, end: 254 }
}

export function parseNeighOutput(text) {
  const out = []
  const seen = new Set()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+dev\s+\S+\s+lladdr\s+([0-9a-fA-F:]{17})\s/)
    if (!m) continue // skip FAILED / incomplete / no-lladdr entries
    const ip = m[1]
    const mac = m[2].toLowerCase()
    if (seen.has(ip)) continue
    seen.add(ip)
    out.push({ ip, mac })
  }
  return out
}

async function pingOne(base, last, timeoutMs) {
  try {
    await execFileP('ping', ['-c', '1', '-W', String(Math.max(1, Math.floor(timeoutMs / 1000))), `${base}.${last}`])
  } catch { /* ping returns non-zero when host is down; that's fine */ }
}

export async function arpScan({ subnet = '192.168.0.0/24', timeoutMs = 3000, batchSize = 32 } = {}) {
  const { base, start, end } = subnetToRange(subnet)
  // Best-effort flush; ignore failure (needs root or net_admin).
  await execFileP('ip', ['neigh', 'flush', 'all']).catch(() => {})

  for (let i = start; i <= end; i += batchSize) {
    const batch = []
    for (let j = i; j < Math.min(i + batchSize, end + 1); j++) {
      batch.push(pingOne(base, j, timeoutMs))
    }
    await Promise.all(batch)
  }

  const { stdout } = await execFileP('ip', ['neigh', 'show']).catch(() => ({ stdout: '' }))
  return parseNeighOutput(stdout || '')
}

// Device vendor enrichment for the LAN module.
//
// enrichDevices(devices, opts) annotates an array of {ip, mac} entries with
// vendor / hostname / hostname fields. All three are optional and degrade
// independently if the lookup doesn't return anything (timeout, private name,
// unknown vendor). Vendor is computed locally from the MAC prefix (OUI);
// name resolution runs in parallel via mDNS + reverse DNS.
//
// Exports:
//   parseNeighOutput(text) -> [{ip, mac}]               (re-exported from arp.js)
//   enrichDevices(devices, {vendorCache: string[],
//                           mdnsTimeoutMs: number,
//                           dnsTimeoutMs: number})
//                          -> Promise<Array<{ip, mac, vendor, hostname}>>
//
//   lookupVendor(mac, vendorCache: Set<string>) -> string
//     Pure OUI lookup. mac is "aa:bb:cc:dd:ee:ff"; returns the registered
//     vendor for the 24-bit prefix, or "" if unknown.
//
//   parseOuioui(text) -> Map<prefix, vendor>
//     Parses the IEEE OUI block I file (one record per line,
//     "(hex prefix) — agency.organization"). Returns a Map from prefix
//     (lower-case, no separators, 6 hex chars) to vendor name.
//
//   resolveName(ip, {mdnsTimeoutMs, dnsTimeoutMs}) -> Promise<string>
//     Parallel mDNS + reverse DNS lookup. First non-empty answer wins.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

const execFileP = promisify(execFile)

// Re-export so callers can keep their existing import path.
export { parseNeighOutput } from './arp.js'

// --- OUI vendor lookup ----------------------------------------------------

// OUI file location. We try the Wireshark manuf file first (compact
// and trimmed), then the IEEE oui.txt files that ship with the
// ieee-data package on Debian/Ubuntu (heavier, but ubiquitous). If
// none is found, vendor resolution silently returns "" — the rest
// of the data still works (hostnames via mDNS/reverse DNS).
const OUI_PATHS = [
  '/usr/share/wireshark/manuf',
  '/usr/share/ieee-data/oui.txt',
  '/var/lib/ieee-data/oui.txt',
  '/usr/share/ieee-data/oui36.txt',
  '/var/lib/ieee-data/oui36.txt',
]

/**
 * Parse the IEEE OUI file. Two formats are seen in the wild:
 *
 *   Wireshark manuf (from /usr/share/wireshark/manuf):
 *     "AA:BB:CC\tBase/24\tVendor\n"
 *     e.g. "00:1A:2B\tBase/24\tApple, Inc.\n"
 *
 *   IEEE oui.txt (from /usr/share/ieee-data/oui.txt or oui36.txt):
 *     "10-E9-92   (hex)\t\tINGRAM MICRO SERVICES\n"
 *     "10E992     (base 16)\t\tINGRAM MICRO SERVICES\n"
 *     followed by address lines that start with whitespace.
 *
 * In both cases, the vendor name is in the THIRD tab-separated column.
 * We extract the first 6 hex chars (24-bit OUI) and the vendor string,
 * stripping trailing "(Private)" / "(test)" annotations.
 */
export function parseOuioui(text) {
  const out = new Map()
  const seen = new Set()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // Skip the address lines that follow a vendor entry — they always
    // start with whitespace in the raw file, but after trim they look
    // like normal lines. The tell: they don't start with a MAC prefix.
    // The header lines (3 columns, no leading hex) are also skipped.
    const m = line.match(/^([0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2})/)
    if (!m) continue
    const prefix = m[1].replace(/[-:]/g, '').toLowerCase()
    if (seen.has(prefix)) continue
    const parts = line.split(/\t/)
    // The IEEE file uses multiple tabs between columns; we want the
    // first non-empty chunk after the prefix column. We skip values
    // that look like metadata: "(hex)", "(base 16)", "Base/24",
    // "Base/28", "MA-L", "MA-M", "MA-S" — those aren't vendor names.
    let vendor = null
    const META = /^(?:\(.*\)|Base\/\d+|MA-[LMS])$/
    for (let i = 1; i < parts.length; i++) {
      const v = parts[i].trim()
      if (v && !META.test(v)) { vendor = v; break }
    }
    if (!vendor) continue
    // Strip trailing parentheticals like "(Private)" / "(test)".
    vendor = vendor.replace(/\s*\([^)]*\)\s*$/, '')
    seen.add(prefix)
    out.set(prefix, vendor)
  }
  return out
}

/**
 * Build the OUI vendor cache. Returns Map<macPrefix, vendorName>.
 * Tries each known path in order; first file that exists is used.
 */
export function loadVendorCache() {
  for (const p of OUI_PATHS) {
    if (!existsSync(p)) continue
    try {
      const text = readFileSync(p, 'utf8')
      const cache = parseOuioui(text)
      if (cache.size > 0) return { path: p, cache }
    } catch { /* try next */ }
  }
  return { path: null, cache: new Map() }
}

/**
 * Lookup vendor for a MAC address using a preloaded cache.
 * Looks up the 24-bit OUI (first 3 bytes = first 6 hex digits).
 * Returns null when no vendor is known.
 */
export function lookupVendor(mac, cache) {
  if (!mac || !cache || cache.size === 0) return null
  const prefix = mac.replace(/[\\/:-]/g, '').toLowerCase().slice(0, 6)
  return cache.get(prefix) || null
}

// --- mDNS / reverse DNS hostname lookup ------------------------------------

/**
 * Run `avahi-resolve -a <ip>` to resolve an mDNS name. Returns the bare
 * hostname (e.g. "samsung-impresora.local") or null when the lookup times
 * out / the host has no mDNS service.
 */
async function mdnsResolve(ip, timeoutMs = 800) {
  // avahi-resolve -a <ip> prints "<name>\t<ip>\n" on success and exits 1
  // on failure (no such host). Even on failure, stdout is empty, which is
  // what we want.
  const { stdout } = await execFileP(
    'avahi-resolve',
    ['-a', ip],
    { timeout: timeoutMs, killSignal: 'SIGKILL' }
  ).catch(() => ({ stdout: '' }))
  if (!stdout) return null
  const m = stdout.match(/(\S+)\s+\d+\.\d+\.\d+\.\d+/)
  return m ? m[1] : null
}

/**
 * Reverse-DNS lookup a single IP. Tries getent hosts (works without
 * `host` / `dig`), then nslookup as fallback. Returns null when no
 * reverse DNS is set up for the address.
 */
async function dnsResolve(ip, timeoutMs = 1000) {
  const { stdout } = await execFileP(
    'getent',
    ['hosts', ip],
    { timeout: timeoutMs, killSignal: 'SIGKILL' }
  ).catch(() => ({ stdout: '' }))
  if (stdout) {
    // getent hosts lines: "<ip> <hostname>\n".
    const parts = stdout.trim().split(/\s+/)
    if (parts.length >= 2) return parts[1]
  }
  // Fallback: nslookup.
  const r2 = await execFileP(
    'nslookup',
    [ip],
    { timeout: timeoutMs, killSignal: 'SIGKILL' }
  ).catch(() => ({ stdout: '' }))
  const m = r2.out && r2.out.match(/name\s*=\s*(\S+)\./)
  return m ? m[1] : null
}

/**
 * Resolve a human-friendly hostname for an IP. Tries mDNS first
 * (because LAN devices advertise names there even when their DHCP
 * reverse DNS is empty), then falls back to reverse DNS. Returns
 * null when no name can be found.
 *
 * Both lookups run in parallel and the first non-empty answer wins,
 * so the typical case (mDNS hit) costs the mdnsTimeoutMs budget, not
 * mdnsTimeoutMs + dnsTimeoutMs.
 */
export async function resolveName(ip, { mdnsTimeoutMs = 800, dnsTimeoutMs = 1000 } = {}) {
  if (!ip) return null
  // Run both in parallel; first non-null wins. We don't use Promise.race
  // because we'd lose the slower answer — instead we await both and pick.
  const [mdns, dns] = await Promise.all([
    mdnsResolve(ip, mdnsTimeoutMs),
    dnsResolve(ip, dnsTimeoutMs),
  ])
  // Prefer mDNS result when it has a `.local` suffix (it's always
  // local-scope, so it's correct). Otherwise prefer reverse DNS when
  // it's a real FQDN (longer, has dots) and fall back to mDNS.
  if (mdns && /\.local$/i.test(mdns)) return mdns
  if (dns && dns.length > mdns?.length) return dns
  return mdns || dns || null
}

// --- Enrichment -----------------------------------------------------------

/**
 * Annotate a list of devices with vendor + hostname. Returns a new
 * array; does not mutate the input. Devices are sorted by IP
 * (lexicographic on the dotted-quad string, which matches numeric
 * order for /24 subnets and is close enough for anything < /16).
 *
 * Name resolution runs in parallel for all devices with a per-batch
 * concurrency limit so we don't 500 fork() at the same time.
 */
export async function enrichDevices(
  devices,
  { mdnsTimeoutMs = 800, dnsTimeoutMs = 1000, concurrency = 16 } = {}
) {
  if (!devices || !devices.length) return []
  const { cache: vendorCache } = loadVendorCache()

  // Resolve names in parallel with a bounded concurrency. We use a
  // simple chunked approach — split into N chunks of size ceil(total/N).
  const enriched = await mapWithConcurrency(devices, concurrency, async (d) => {
    const vendor = lookupVendor(d.mac, vendorCache)
    const hostname = await resolveName(d.ip, { mdnsTimeoutMs, dnsTimeoutMs })
    return {
      ip: d.ip,
      mac: d.mac,
      vendor: vendor || null,
      hostname: hostname || null,
    }
  })

  // Stable sort by IP (lexicographic on the dotted-quad is fine for
  // /24 — split on '.' to int-compare each octet so 192.168.1.10 sorts
  // before 192.168.1.100).
  enriched.sort((a, b) => {
    const pa = a.ip.split('.').map(Number)
    const pb = b.ip.split('.').map(Number)
    for (let i = 0; i < 4; i++) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i]
    }
    return 0
  })

  return enriched
}

/**
 * Run an async mapper with bounded concurrency. Returns a new array
 * preserving the original order.
 */
async function mapWithConcurrency(items, concurrency, fn) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  }
  const workers = []
  const n = Math.min(concurrency, items.length)
  for (let i = 0; i < n; i++) workers.push(worker())
  await Promise.all(workers)
  return out
}
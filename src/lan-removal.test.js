// Regression test: the LAN monitoring subsystem must stay out of the daemon.
//
// Background — why this test exists
// ----------------------------------
// Until 2026-10-26 the daemon ran a second workload next to its SSH
// polling: an ARP sweep of the LAN (254 `ping` forks), reverse-DNS / mDNS
// lookups for every device found (`avahi-resolve`, `getent`, `nslookup`),
// and a 5.6 MB IEEE OUI table re-parsed into a 35 813-entry Map + Set on
// *every* poll (lan_enrich.js -> loadVendorCache() -> parseOuioui()).
//
// That workload triggered a crash that cost the service ~20 restarts a day:
// SIGSEGV / "general protection fault" (exit 139) with a corrupted pointer,
// always inside V8's hash-table / GC internals —
//
//   Object::GetSimpleHash              (node 26 and node 22)
//   Builtins_MapPrototypeSet           (Map.prototype.set)
//   Builtins_FindOrderedHashSetEntry   (Set lookup)
//   Scavenger::ScavengePage            (young-generation GC)
//
// Those are precisely the builtins the per-poll OUI Map/Set rebuild
// hammers, and the scavenger walks the pages it produces. It reproduced on
// node 22, 24 and 26, on musl and glibc, in the container and natively on
// the host, so it was not a runtime-version bug and not a musl bug.
//
// The owner authorised dropping the network functionality outright, so the
// daemon is now SSH-only: the five servers over SSH are the core feature.
// This test locks that shape in so the LAN workload cannot creep back in
// unnoticed — particularly the per-poll OUI Map/Set rebuild, which is the
// part that actually crashed.
//
// It also locks in the second half of the fix: the daemon no longer loads
// any native addon. better-sqlite3 was replaced by node:sqlite (built into
// the runtime), so there is no longer a compiled .node extension that could
// scribble on V8's heap from the outside.
//
// Run: node --test src/lan-removal.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_JS = resolve(__dirname, 'server.js')
const src = readFileSync(SERVER_JS, 'utf8')

test('the daemon does not import the LAN modules', () => {
  for (const mod of ['./arp.js', './lan_enrich.js', './iface_traffic.js']) {
    assert.ok(
      !src.includes(`from '${mod}'`),
      `server.js must not import ${mod}: the LAN workload triggered the SIGSEGV`,
    )
  }
})

test('the LAN source modules are gone from the repository', () => {
  for (const f of ['arp.js', 'lan_enrich.js', 'iface_traffic.js']) {
    assert.ok(
      !existsSync(resolve(__dirname, f)),
      `src/${f} must be deleted; re-adding it would re-add the crash trigger`,
    )
  }
})

test('the daemon does not shell out to the LAN helper binaries', () => {
  // ping (ARP sweep), avahi-resolve + getent/nslookup (name lookups) and
  // `ip neigh` were all exec'd as child processes.
  //
  // These are matched as quoted string literals, not bare words: the
  // header comment mentions `ping` in prose when explaining what was
  // removed, and a bare substring match would flag that.
  for (const bin of ['ping', 'avahi-resolve', 'nslookup', 'getent', 'ip']) {
    assert.ok(
      !src.includes(`'${bin}'`),
      `server.js must not exec '${bin}': the fork storm was a crash trigger`,
    )
  }
})

test('the daemon does not spawn child processes at all', () => {
  assert.ok(
    !src.includes('child_process'),
    'server.js must not import child_process; the daemon is now SSH-only',
  )
})

test('the daemon does not reference the LAN configuration or state', () => {
  for (const token of [
    'LAN_SUBNET', 'LAN_POLL_INTERVAL_MS', 'IFACE_POLL_INTERVAL_MS',
    'IFACE_HISTORY_SAMPLES', 'lan_samples', 'iface_samples',
    'lanState', 'ifaceState', 'pollLan', 'pollIfaceTraffic',
  ]) {
    assert.ok(
      !src.includes(token),
      `server.js must not reference ${token} after the LAN removal`,
    )
  }
})

test('the LAN API endpoints are gone', () => {
  for (const ep of ['/api/lan/status', '/api/lan/history', '/api/iface/status', '/api/iface/history']) {
    assert.ok(!src.includes(ep), `the ${ep} endpoint must be removed`)
  }
})

test('the daemon uses the built-in node:sqlite, not a native addon', () => {
  assert.ok(
    src.includes("from 'node:sqlite'"),
    'server.js must use node:sqlite',
  )
  assert.ok(
    !src.includes('better-sqlite3'),
    'server.js must not use better-sqlite3: it was the only native addon in the process',
  )
})

test('the OUI database is no longer shipped or parsed', () => {
  assert.ok(
    !existsSync(resolve(__dirname, '..', 'assets', 'oui.txt')),
    'assets/oui.txt must be deleted; the 5.6 MB table was re-parsed every poll',
  )
  assert.ok(!src.includes('oui'), 'server.js must not reference the OUI database')
})

test('the SSH server polling that the dashboard exists for is still there', () => {
  // The point of the change is stability of the SSH path, not its removal.
  assert.ok(src.includes("from 'ssh2'"), 'ssh2 must still be imported')
  assert.ok(src.includes('runSshCommand'), 'the SSH exec path must still exist')
  assert.ok(src.includes("app.get('/api/cluster/status'"), 'the status endpoint must remain')
  assert.ok(src.includes("app.get('/api/cluster/history'"), 'the history endpoint must remain')
})

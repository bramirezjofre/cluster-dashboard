// Unit tests for src/arp.js (parser only — arpScan itself requires root+network).
// Run with: node --test src/arp.test.js

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNeighOutput } from './arp.js'

test('parsea salida estándar de ip neigh', () => {
  const out = [
    '192.168.0.1 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE',
    '192.168.0.5 dev eth0 lladdr 11:22:33:44:55:66 STALE',
  ].join('\n')
  const r = parseNeighOutput(out)
  assert.equal(r.length, 2)
  assert.deepEqual(r[0], { ip: '192.168.0.1', mac: 'aa:bb:cc:dd:ee:ff' })
  assert.deepEqual(r[1], { ip: '192.168.0.5', mac: '11:22:33:44:55:66' })
})

test('ignora entradas FAILED y sin MAC', () => {
  const out = [
    '192.168.0.1 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE',
    '192.168.0.2 dev eth0  FAILED',
    '192.168.0.3 dev eth0 lladdr  incomplete',
  ].join('\n')
  const r = parseNeighOutput(out)
  assert.equal(r.length, 1)
  assert.equal(r[0].ip, '192.168.0.1')
})

test('deduplica por IP', () => {
  const out = [
    '192.168.0.1 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE',
    '192.168.0.1 dev eth0 lladdr 11:22:33:44:55:66 STALE',
  ].join('\n')
  const r = parseNeighOutput(out)
  assert.equal(r.length, 1)
  assert.equal(r[0].mac, 'aa:bb:cc:dd:ee:ff')
})

test('MAC se normaliza a minúsculas', () => {
  const out = '192.168.0.1 dev eth0 lladdr AA:BB:CC:DD:EE:FF REACHABLE'
  const r = parseNeighOutput(out)
  assert.equal(r[0].mac, 'aa:bb:cc:dd:ee:ff')
})

test('texto vacío devuelve []', () => {
  assert.deepEqual(parseNeighOutput(''), [])
  assert.deepEqual(parseNeighOutput('\n\n\n'), [])
})

// ─── casos extra acordes al sistema actual (192.168.1.0/24) ─────────────

test('parsea subred actual 192.168.1.x', () => {
  const out = [
    '192.168.1.1 dev enp2s0 lladdr 10:62:eb:10:e0:6f REACHABLE',
    '192.168.1.4 dev enp2s0 lladdr b8:27:eb:ea:41:f8 REACHABLE',
    '192.168.1.5 dev enp2s0 lladdr 58:2f:40:7b:0e:c3 STALE',
    '192.168.1.13 dev enp2s0 lladdr 5e:9c:dd:cc:c7:8f REACHABLE',
    '192.168.1.15 dev enp2s0 lladdr 70:89:76:95:be:aa DELAY',
  ].join('\n')
  const r = parseNeighOutput(out)
  assert.equal(r.length, 5)
  assert.equal(r[0].ip, '192.168.1.1')
  assert.equal(r[4].ip, '192.168.1.15')
  // All MACs lowercased even though they came in mixed case.
  for (const dev of r) {
    assert.match(dev.mac, /^[0-9a-f:]+$/)
  }
})

test('ignora entradas IPv6 link-local (FE80::) que no son IPv4', () => {
  // ip neigh show on dual-stack hosts includes IPv6 neighbors. Our parser
  // is IPv4-only; verify it doesn't crash and skips them silently.
  const out = [
    'fe80::1234:abcd dev enp2s0 lladdr aa:bb:cc:dd:ee:ff REACHABLE',
    '192.168.1.4 dev enp2s0 lladdr b8:27:eb:ea:41:f8 REACHABLE',
  ].join('\n')
  const r = parseNeighOutput(out)
  assert.equal(r.length, 1)
  assert.equal(r[0].ip, '192.168.1.4')
})

test('ignora líneas que no son IP+dev (cabecera, espacios raros)', () => {
  const out = [
    '',                                                    // blank line
    'Device           lladdr                          state',  // header
    '192.168.1.1 dev enp2s0 lladdr aa:bb:cc:dd:ee:ff REACHABLE',
    '   ',                                                 // whitespace only
    'no-ip-here dev enp2s0 lladdr aa:bb:cc:dd:ee:ff REACHABLE',
  ].join('\n')
  const r = parseNeighOutput(out)
  assert.equal(r.length, 1)
  assert.equal(r[0].ip, '192.168.1.1')
})

test('MAC con separadores distintos a : no se acepta', () => {
  // Some kernel variants use '-' or '.', but our regex requires ':'.
  // This is intentional — verify the parser rejects those entries
  // rather than accepting them with the wrong format.
  const out = [
    '192.168.1.1 dev enp2s0 lladdr aa-bb-cc-dd-ee-ff REACHABLE',
    '192.168.1.2 dev enp2s0 lladdr aabb.ccdd.eeff REACHABLE',
    '192.168.1.3 dev enp2s0 lladdr aa:bb:cc:dd:ee:ff REACHABLE',
  ].join('\n')
  const r = parseNeighOutput(out)
  assert.equal(r.length, 1)
  assert.equal(r[0].ip, '192.168.1.3')
})

test('mezcla case-insensitive en MAC produce una sola entrada minúscula', () => {
  const out = [
    '192.168.1.1 dev enp2s0 lladdr AA:bb:CC:dd:EE:ff REACHABLE',
  ].join('\n')
  const r = parseNeighOutput(out)
  assert.equal(r.length, 1)
  assert.equal(r[0].mac, 'aa:bb:cc:dd:ee:ff')
})

test('preserva orden de aparición en stdout (no ordena)', () => {
  const out = [
    '192.168.1.10 dev enp2s0 lladdr 00:00:00:00:00:0a REACHABLE',
    '192.168.1.2  dev enp2s0 lladdr 00:00:00:00:00:02 REACHABLE',
    '192.168.1.5  dev enp2s0 lladdr 00:00:00:00:00:05 REACHABLE',
  ].join('\n')
  const r = parseNeighOutput(out)
  assert.deepEqual(r.map(d => d.ip), ['192.168.1.10', '192.168.1.2', '192.168.1.5'])
})

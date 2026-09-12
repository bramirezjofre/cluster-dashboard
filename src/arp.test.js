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

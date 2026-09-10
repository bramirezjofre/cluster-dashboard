// Unit tests for src/pihole.js. Uses node:test (built-in).
// Run with: node --test src/pihole.test.js

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pollPihole, _internal } from './pihole.js'

// _internal.sidCache must be cleared between tests so cached SIDs
// from a previous run don't leak into new test runs.
function clearSidCache() {
  for (const k of _internal.sidCache.keys()) _internal.sidCache.delete(k)
}

function makeFetchMock(responses) {
  let i = 0
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts })
    const r = responses[i++]
    if (!r) throw new Error(`no mock for call ${i - 1}`)
    if (r.reject) throw r.reject
    return {
      ok: r.ok !== false,
      status: r.status ?? 200,
      json: async () => r.json,
      text: async () => JSON.stringify(r.json),
    }
  }
  return { fetchImpl, calls }
}

test('login + stats OK', async () => {
  clearSidCache()
  const { fetchImpl, calls } = makeFetchMock([
    { json: { session: { valid: true, sid: 'sid-A', validity: 1800 } } },
    { json: { queries: { total: 100, blocked: 20, percent_blocked: 20.0, unique_domains: 50 } } },
    { json: { clients: [{ ip: '1.2.3.4', name: '', count: 50 }, { ip: '5.6.7.8', name: 'phone', count: 30 }], total_queries: 100 } },
  ])
  const r = await pollPihole({ host: 'h', port: 80, password: 'p', fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.totalQueries, 100)
  assert.equal(r.blockedQueries, 20)
  assert.equal(r.percentBlocked, 20.0)
  assert.equal(r.topClients.length, 2)
  assert.equal(r.topClients[0].ip, '1.2.3.4')
  assert.equal(r.topClients[1].name, 'phone')
  // login + summary + top_clients
  assert.equal(calls.length, 3)
})

test('login fallido devuelve ok=false', async () => {
  clearSidCache()
  const { fetchImpl } = makeFetchMock([
    { json: { session: { valid: false } } },
  ])
  const r = await pollPihole({ host: 'h', port: 80, password: 'wrong', fetchImpl })
  assert.equal(r.ok, false)
  assert.match(r.error, /password|invalid|login/i)
})

test('401 en summary → relogin automático', async () => {
  clearSidCache()
  const { fetchImpl, calls } = makeFetchMock([
    { json: { session: { valid: true, sid: 'old', validity: 1800 } } },  // login
    { ok: false, status: 401, json: { error: 'unauthorized' } },         // summary 401
    { json: { session: { valid: true, sid: 'new', validity: 1800 } } },  // relogin
    { json: { queries: { total: 5, blocked: 0, percent_blocked: 0, unique_domains: 5 } } }, // summary retry
    { json: { clients: [{ ip: '9.9.9.9', name: '', count: 5 }], total_queries: 5 } },
  ])
  const r = await pollPihole({ host: 'h', port: 80, password: 'p', fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.totalQueries, 5)
  assert.equal(r.topClients.length, 1)
  assert.ok(calls.length >= 4, `expected >=4 fetch calls, got ${calls.length}`)
})

test('network error → ok=false con mensaje', async () => {
  clearSidCache()
  const { fetchImpl } = makeFetchMock([{ reject: Object.assign(new Error('ECONNREFUSED'), { name: 'Error' }) }])
  const r = await pollPihole({ host: 'h', port: 80, password: 'p', fetchImpl })
  assert.equal(r.ok, false)
  assert.match(r.error, /ECONNREFUSED/)
})

test('abort (timeout) → ok=false', async () => {
  clearSidCache()
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
  const { fetchImpl } = makeFetchMock([{ reject: abortErr }])
  const r = await pollPihole({ host: 'h', port: 80, password: 'p', fetchImpl })
  assert.equal(r.ok, false)
  assert.match(r.error, /timeout|abort/i)
})

test('parametros faltantes → ok=false', async () => {
  clearSidCache()
  const r = await pollPihole({ host: '', port: 0, password: '' })
  assert.equal(r.ok, false)
  assert.match(r.error, /missing/i)
})

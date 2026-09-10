// Pi-hole v6 API client. Logs in once, reuses the session id until the
// server returns 401 (sid expired or invalid), then re-authenticates.
//
// Exports pollPihole({ host, port, password, fetchImpl }) which returns
//   { ok: true, totalQueries, blockedQueries, percentBlocked, topClients: [{ip, name, count}], error? }
//   or
//   { ok: false, error: '...' }
//
// fetchImpl is injectable so tests can run without network access.

const sidCache = new Map() // key: `${host}:${port}` -> { sid, expiresAt }

function cacheKey(host, port) { return `${host}:${port}` }

async function login(host, port, password, fetchImpl, timeoutMs = 5000) {
  const url = `http://${host}:${port}/api/auth`
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      signal: ac.signal,
    })
    const body = await r.json().catch(() => ({}))
    const session = body.session || {}
    if (!session.valid || !session.sid) {
      return { ok: false, error: 'login failed: password incorrect or session invalid' }
    }
    sidCache.set(cacheKey(host, port), {
      sid: session.sid,
      expiresAt: Date.now() + (session.validity || 1800) * 1000,
    })
    return { ok: true, sid: session.sid }
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, error: 'timeout' }
    return { ok: false, error: e.message || String(e) }
  } finally {
    clearTimeout(t)
  }
}

async function authedGet(host, port, path, fetchImpl, timeoutMs = 5000) {
  const cached = sidCache.get(cacheKey(host, port))
  if (!cached) {
    return { ok: false, needRelogin: true }
  }
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetchImpl(`http://${host}:${port}${path}`, {
      headers: { 'X-FTL-SID': cached.sid },
      signal: ac.signal,
    })
    if (r.status === 401) {
      sidCache.delete(cacheKey(host, port))
      return { ok: false, needRelogin: true }
    }
    if (!r.ok) {
      return { ok: false, error: `http ${r.status}` }
    }
    const body = await r.json()
    return { ok: true, body }
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, error: 'timeout' }
    return { ok: false, error: e.message || String(e) }
  } finally {
    clearTimeout(t)
  }
}

export async function pollPihole({ host, port, password, fetchImpl = globalThis.fetch }) {
  if (!host || !port || !password) {
    return { ok: false, error: 'missing host/port/password' }
  }

  // 1. Ensure we have a valid sid (try login first, then reuse).
  let loginResult = await login(host, port, password, fetchImpl)
  if (!loginResult.ok) return loginResult

  // 2. Try summary + top_clients with current sid. If 401, relogin once.
  let summaryR = await authedGet(host, port, '/api/stats/summary', fetchImpl)
  if (summaryR.needRelogin) {
    loginResult = await login(host, port, password, fetchImpl)
    if (!loginResult.ok) return loginResult
    summaryR = await authedGet(host, port, '/api/stats/summary', fetchImpl)
  }
  if (!summaryR.ok) return { ok: false, error: summaryR.error || 'summary failed' }

  const clientsR = await authedGet(host, port, '/api/stats/top_clients?count=20', fetchImpl)
  // If 401 here, try one more relogin
  let topClients = []
  if (clientsR.needRelogin) {
    loginResult = await login(host, port, password, fetchImpl)
    if (loginResult.ok) {
      const retry = await authedGet(host, port, '/api/stats/top_clients?count=20', fetchImpl)
      if (retry.ok) topClients = (retry.body.clients || []).map(c => ({
        ip: c.ip, name: c.name || '', count: c.count,
      }))
    }
  } else if (clientsR.ok) {
    topClients = (clientsR.body.clients || []).map(c => ({
      ip: c.ip, name: c.name || '', count: c.count,
    }))
  }

  const q = summaryR.body.queries || {}
  return {
    ok: true,
    totalQueries: q.total || 0,
    blockedQueries: q.blocked || 0,
    percentBlocked: q.percent_blocked || 0,
    uniqueDomains: q.unique_domains || 0,
    topClients,
  }
}

// Exposed for tests.
export const _internal = { login, authedGet, sidCache }

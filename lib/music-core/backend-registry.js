const crypto = require('crypto')

const MAX_TRACES = 2_000
const TRACE_TTL_MS = 30_000
const MAX_INFLIGHT = 500
const INFLIGHT_TTL_MS = 120_000
const BAD_LANE_TTL_MS = 300_000
const MAX_LANE_STATS = 500
const LANE_STATS_TTL_MS = 10 * 60_000
const traces = new Map()
const inflight = new Map()
const badLanes = new Map()
const laneStats = new Map()
let traceSeq = 0

const CREDENTIAL_NAME = /(?:api.?key|app.?key|access.?token|auth.?token|client.?secret|credential|authorization|vkey|token|secret|^key$)/i
const CREDENTIAL_HEADER = /(?:authorization|x-api-key|api-key|x-auth-token|cookie|token)/i

function sha256(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  return crypto.createHash('sha256').update(serialized).digest('hex')
}

function shortHash(value) {
  return sha256(value).slice(0, 24)
}

function cleanEndpoint(rawUrl) {
  try {
    const u = new URL(String(rawUrl))
    return `${u.origin}${u.pathname.replace(/\/$/, '')}`
  } catch {
    return String(rawUrl || '')
  }
}

function flattenPairs(value, prefix = '') {
  if (!value || typeof value !== 'object') return []
  const pairs = []
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      pairs.push(...flattenPairs(item, name))
    } else if (item !== undefined && item !== null) {
      pairs.push([name, String(item)])
    }
  }
  return pairs
}

function credentialHash(url, options = {}) {
  const pairs = []
  try {
    const u = new URL(String(url))
    for (const [key, value] of u.searchParams) {
      if (CREDENTIAL_NAME.test(key)) pairs.push([`query:${key.toLowerCase()}`, value])
    }
  } catch {}

  for (const [key, value] of Object.entries(options.headers || {})) {
    if (CREDENTIAL_HEADER.test(key)) pairs.push([`header:${key.toLowerCase()}`, String(value)])
  }
  for (const field of ['body', 'form', 'formData']) {
    for (const [key, value] of flattenPairs(options[field])) {
      if (CREDENTIAL_NAME.test(key)) pairs.push([`${field}:${key.toLowerCase()}`, value])
    }
  }

  if (!pairs.length) return null
  pairs.sort((a, b) => a[0].localeCompare(b[0]))
  return shortHash(pairs.map(([key, value]) => `${key}=${value}`).join('\n'))
}

function requestShape(url, options = {}) {
  let queryKeys = []
  try {
    queryKeys = [...new URL(String(url)).searchParams.keys()].sort()
  } catch {}
  const shapeValue = value => {
    if (value === null) return 'null'
    if (Array.isArray(value)) return { type: 'array', items: value.slice(0, 8).map(shapeValue) }
    if (value && typeof value === 'object') {
      const out = {}
      for (const key of Object.keys(value).sort()) out[key] = shapeValue(value[key])
      return out
    }
    return typeof value
  }
  return shortHash(stableValue({
    queryKeys,
    headers: Object.keys(options.headers || {}).map(key => key.toLowerCase()).sort(),
    body: shapeValue(options.body),
    form: shapeValue(options.form),
    formData: shapeValue(options.formData),
  }))
}

function describeRequest(rawUrl, options = {}, method = 'get') {
  const endpoint = cleanEndpoint(rawUrl)
  const keyHash = credentialHash(rawUrl, options)
  const requestMethod = String(method || 'get').toUpperCase()
  const requestShapeHash = requestShape(rawUrl, options)
  return {
    endpoint,
    method: requestMethod,
    requestShapeHash,
    keyHash,
    laneId: shortHash(`${endpoint}\n${keyHash || ''}`),
    interfaceId: shortHash(`${endpoint}\n${requestMethod}\n${requestShapeHash}\n${keyHash || ''}`),
  }
}

function buildInterfaceId(platform, request) {
  return shortHash(`${platform || ''}\n${request.interfaceId}`)
}

function pruneExpired(now = Date.now()) {
  for (const [id, trace] of traces) {
    if (now - trace.createdAt > TRACE_TTL_MS) traces.delete(id)
  }
  while (traces.size > MAX_TRACES) traces.delete(traces.keys().next().value)
}

function beginTrace(context = {}) {
  pruneExpired()
  const traceId = `trace_${Date.now().toString(36)}_${(++traceSeq).toString(36)}`
  traces.set(traceId, {
    traceId,
    createdAt: Date.now(),
    platform: context.platform || null,
    action: context.action || null,
    quality: context.quality || null,
    songId: context.songId || null,
    sourceName: context.sourceName || null,
    lanes: [],
  })
  return traceId
}

function recordLane(traceId, request) {
  const trace = traces.get(traceId)
  if (!trace) return
  const lane = {
    laneId: request.laneId,
    interfaceId: buildInterfaceId(trace.platform, request),
    dedupeKey: request.interfaceId,
    endpoint: request.endpoint,
    method: request.method || 'GET',
    requestShapeHash: request.requestShapeHash || '',
    keyHash: request.keyHash,
    platform: trace.platform,
    action: trace.action,
    quality: trace.quality,
    songId: trace.songId,
    sourceName: trace.sourceName,
    callCount: 1,
    networkCount: 0,
    responseCount: 0,
  }
  const existing = trace.lanes.find(item => item.interfaceId === lane.interfaceId)
  if (!existing) trace.lanes.push(lane)
  else existing.callCount++
}

function recordLaneResponseMeta(traceId, request, response = {}, networkCount = 0) {
  const trace = traces.get(traceId)
  if (!trace) return
  const lane = trace.lanes.find(item => item.dedupeKey === request.interfaceId)
  if (!lane) return
  lane.networkCount += Number(networkCount) || 0
  lane.responseCount++
  lane.statusCode = Number.isInteger(response.statusCode) ? response.statusCode : null
  lane.contentType = String(response.contentType || '').slice(0, 120)
  lane.bodyType = String(response.bodyType || '').slice(0, 24)
  lane.code = response.code == null ? null : String(response.code).slice(0, 80)
  lane.msg = response.msg == null ? null : String(response.msg).slice(0, 240)
  lane.urlExists = typeof response.urlExists === 'boolean' ? response.urlExists : null
  lane.bytes = Number.isFinite(response.bytes) ? response.bytes : null
}

function safeText(value) {
  return String(value)
    .replace(/https?:\/\/[^\s]+/gi, raw => {
      try {
        const url = new URL(raw)
        return `${url.origin}${url.pathname}`
      } catch {
        return '[url]'
      }
    })
    .replace(/(\b(?:api.?key|app.?key|access.?token|auth.?token|client.?secret|credential|authorization|vkey|token|secret|key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
}

function responseMeta(resp, bodyData) {
  const body = bodyData && typeof bodyData === 'object' ? bodyData : null
  const data = body?.data && typeof body.data === 'object' ? body.data : null
  const nested = data?.song && typeof data.song === 'object' ? data.song : null
  const candidates = [body?.url, body?.playUrl, data?.url, data?.playUrl, nested?.url, body?.result?.url]
  const contentType = Object.entries(resp?.headers || {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1]
  return {
    statusCode: resp?.statusCode,
    contentType: Array.isArray(contentType) ? contentType[0] : contentType,
    bodyType: Array.isArray(bodyData) ? 'array' : bodyData === null ? 'null' : typeof bodyData,
    code: body?.code,
    msg: body?.msg || body?.message ? safeText(body.msg || body.message) : undefined,
    urlExists: candidates.some(value => typeof value === 'string' && value.length > 0),
    bytes: resp?.bytes,
  }
}

function finishTrace(traceId) {
  const trace = traces.get(traceId)
  if (!trace) return { traceId, lanes: [] }
  traces.delete(traceId)
  return {
    traceId,
    platform: trace.platform,
    action: trace.action,
    quality: trace.quality,
    songId: trace.songId,
    sourceName: trace.sourceName,
    lanes: trace.lanes,
  }
}

function getTraceContext(traceId) {
  const trace = traces.get(traceId)
  if (!trace) return null
  return {
    platform: trace.platform,
    action: trace.action,
    quality: trace.quality,
    songId: trace.songId,
    sourceName: trace.sourceName,
  }
}

function resetForTest() {
  traces.clear()
  inflight.clear()
  badLanes.clear()
  laneStats.clear()
  traceSeq = 0
}

function stableValue(value) {
  if (Buffer.isBuffer(value)) return { __buffer: value.toString('base64') }
  if (ArrayBuffer.isView(value)) return { __bytes: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) }
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key])
    return out
  }
  return value
}

function buildRequestKey(method, url, options = {}) {
  const headers = Object.entries(options.headers || {})
    .map(([key, value]) => [String(key).toLowerCase(), String(value)])
    .sort((a, b) => a[0].localeCompare(b[0]))
  return shortHash(stableValue({
    method: String(method || 'get').toUpperCase(),
    url: String(url),
    headers,
    body: options.body,
    form: options.form,
    formData: options.formData,
  }))
}

function pruneInflight(now = Date.now()) {
  for (const [key, promise] of inflight) {
    if (now - promise.createdAt > INFLIGHT_TTL_MS) inflight.delete(key)
  }
  while (inflight.size > MAX_INFLIGHT) inflight.delete(inflight.keys().next().value)
}

function coalesceRequest(key, starter, onNetworkStart) {
  pruneInflight()
  const existing = inflight.get(key)
  if (existing) return existing.promise
  if (typeof onNetworkStart === 'function') onNetworkStart()
  const entry = { createdAt: Date.now(), promise: null }
  entry.promise = Promise.resolve()
    .then(starter)
    .then(
      value => { inflight.delete(key); return value },
      error => { inflight.delete(key); throw error },
    )
  inflight.set(key, entry)
  return entry.promise
}

function laneScopeKey(lane) {
  return [lane.platform || '', lane.songId || '', lane.quality || '', lane.laneId].join('|')
}

function touchLaneStat(lane) {
  if (!lane || !lane.laneId) return null
  let stat = laneStats.get(lane.laneId)
  if (!stat) {
    stat = {
      laneId: lane.laneId,
      endpoint: lane.endpoint || '',
      keyHash: lane.keyHash || null,
      sourceName: lane.sourceName || null,
      platform: lane.platform || null,
      quality: lane.quality || null,
      attempts: 0,
      httpOk: 0,
      httpBad: 0,
      payloadBad: 0,
      lastUsedAt: Date.now(),
      lastError: null,
      badUntil: 0,
    }
    laneStats.set(lane.laneId, stat)
  }
  stat.lastUsedAt = Date.now()
  if (lane.sourceName) stat.sourceName = lane.sourceName
  if (lane.platform) stat.platform = lane.platform
  if (lane.quality) stat.quality = lane.quality
  return stat
}

function recordLaneResult(lane, ok, reason = '') {
  const stat = touchLaneStat(lane)
  if (!stat) return
  stat.attempts++
  if (ok) {
    stat.httpOk++
  } else {
    stat.httpBad++
    stat.lastError = String(reason || 'HTTP 请求失败').slice(0, 160)
  }
}

function listLaneStats() {
  const now = Date.now()
  for (const [id, stat] of laneStats) {
    if (now - stat.lastUsedAt > LANE_STATS_TTL_MS) laneStats.delete(id)
  }
  while (laneStats.size > MAX_LANE_STATS) {
    const oldest = [...laneStats.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0]
    if (!oldest) break
    laneStats.delete(oldest[0])
  }
  return [...laneStats.values()]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .map(stat => ({
      ...stat,
      successRate: stat.attempts > 0 ? stat.httpOk / stat.attempts : null,
      cooling: stat.badUntil > now,
      retryAfterMs: stat.badUntil > now ? stat.badUntil - now : 0,
    }))
}

function markLaneBad(lane, reason = 'bad payload', ttlMs = BAD_LANE_TTL_MS) {
  if (!lane || !lane.laneId) return
  const until = Date.now() + ttlMs
  badLanes.set(laneScopeKey(lane), { until, reason: String(reason).slice(0, 160) })
  const stat = touchLaneStat(lane)
  if (stat) {
    stat.payloadBad++
    stat.lastError = String(reason).slice(0, 160)
    stat.badUntil = until
  }
}

function isLaneBad(lane) {
  if (!lane || !lane.laneId) return false
  const key = laneScopeKey(lane)
  const hit = badLanes.get(key)
  if (!hit) return false
  if (hit.until <= Date.now()) {
    badLanes.delete(key)
    return false
  }
  return true
}

module.exports = {
  beginTrace,
  recordLane,
  recordLaneResponseMeta,
  responseMeta,
  finishTrace,
  getTraceContext,
  describeRequest,
  buildInterfaceId,
  cleanEndpoint,
  credentialHash,
  buildRequestKey,
  coalesceRequest,
  markLaneBad,
  isLaneBad,
  recordLaneResult,
  listLaneStats,
  resetForTest,
}

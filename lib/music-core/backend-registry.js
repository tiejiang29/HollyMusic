const crypto = require('crypto')

const MAX_TRACES = 2_000
const TRACE_TTL_MS = 30_000
const MAX_INFLIGHT = 500
const INFLIGHT_TTL_MS = 120_000
const BAD_LANE_TTL_MS = 300_000
const traces = new Map()
const inflight = new Map()
const badLanes = new Map()
let traceSeq = 0

const CREDENTIAL_NAME = /(?:api.?key|app.?key|access.?token|auth.?token|client.?secret|credential|authorization|vkey|token|secret|^key$)/i
const CREDENTIAL_HEADER = /(?:authorization|x-api-key|api-key|x-auth-token|cookie|token)/i

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
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

function describeRequest(rawUrl, options = {}) {
  const endpoint = cleanEndpoint(rawUrl)
  const keyHash = credentialHash(rawUrl, options)
  return {
    endpoint,
    keyHash,
    laneId: shortHash(`${endpoint}\n${keyHash || ''}`),
  }
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
    endpoint: request.endpoint,
    keyHash: request.keyHash,
    platform: trace.platform,
    action: trace.action,
    quality: trace.quality,
    songId: trace.songId,
    sourceName: trace.sourceName,
  }
  const existing = trace.lanes.find(item => item.laneId === lane.laneId)
  if (!existing) trace.lanes.push(lane)
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

function coalesceRequest(key, starter) {
  pruneInflight()
  const existing = inflight.get(key)
  if (existing) return existing.promise
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

function markLaneBad(lane, reason = 'bad payload', ttlMs = BAD_LANE_TTL_MS) {
  if (!lane || !lane.laneId) return
  badLanes.set(laneScopeKey(lane), { until: Date.now() + ttlMs, reason: String(reason).slice(0, 160) })
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
  finishTrace,
  getTraceContext,
  describeRequest,
  cleanEndpoint,
  credentialHash,
  buildRequestKey,
  coalesceRequest,
  markLaneBad,
  isLaneBad,
  resetForTest,
}

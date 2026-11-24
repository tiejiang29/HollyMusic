const crypto = require('crypto')

const MAX_TRACES = 2_000
const TRACE_TTL_MS = 30_000
const traces = new Map()
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

function resetForTest() {
  traces.clear()
  traceSeq = 0
}

module.exports = {
  beginTrace,
  recordLane,
  finishTrace,
  describeRequest,
  cleanEndpoint,
  credentialHash,
  resetForTest,
}

import { prisma } from '../db'
import { logger } from '../logger'

export interface ApiRequestPolicy {
  disabledInterfaceIds: string[]
  onlyInterfaceId?: string
}

export interface RuntimeApiLane {
  laneId: string
  interfaceId: string
  dedupeKey?: string
  endpoint: string
  method?: string
  requestShapeHash?: string
  keyHash: string | null
  platform?: string | null
  sourceName?: string | null
  callCount?: number
  networkCount?: number
  responseCount?: number
  statusCode?: number | null
  contentType?: string | null
  bodyType?: string | null
  code?: string | null
  msg?: string | null
  urlExists?: boolean | null
  bytes?: number | null
}

export interface RuntimeApiTrace {
  lanes: RuntimeApiLane[]
}

function safeSources(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function validLane(lane: RuntimeApiLane): boolean {
  return /^[a-f0-9]{24}$/.test(lane.interfaceId || '')
    && /^https?:\/\//i.test(lane.endpoint || '')
    && typeof lane.requestShapeHash === 'string'
    && lane.requestShapeHash.length > 0
}

let writeQueue: Promise<void> = Promise.resolve()
let policyCache: { at: number; value: ApiRequestPolicy } | null = null
let policyPending: Promise<ApiRequestPolicy> | null = null
let policyGeneration = 0

export function invalidateApiInterfacePolicy(): void {
  policyCache = null
  policyPending = null
  policyGeneration++
}

export async function getApiRequestPolicy(): Promise<ApiRequestPolicy> {
  if (policyCache && Date.now() - policyCache.at < 5_000) return policyCache.value
  if (policyPending) return policyPending
  const generation = policyGeneration
  policyPending = prisma.apiInterface.findMany({
    where: { enabled: false },
    select: { id: true },
    take: 5_000,
  }).then(rows => {
    const value = { disabledInterfaceIds: rows.map(row => row.id) }
    if (generation === policyGeneration) policyCache = { at: Date.now(), value }
    return value
  }).catch(error => {
    logger.warn('[api-catalog] 读取接口白名单失败，本次按未停用放行:', error)
    const value = { disabledInterfaceIds: [] }
    if (generation === policyGeneration) policyCache = { at: Date.now(), value }
    return value
  }).finally(() => { if (generation === policyGeneration) policyPending = null })
  return policyPending
}

async function persistTrace(trace: RuntimeApiTrace, configuredSource?: string): Promise<void> {
  const lanes = [...new Map((trace.lanes || []).filter(validLane).map(lane => [lane.interfaceId, lane])).values()]
  for (const lane of lanes) {
    const sourceName = configuredSource || lane.sourceName || ''
    const existing = await prisma.apiInterface.findUnique({ where: { id: lane.interfaceId } })
    const sources = [...new Set([...safeSources(existing?.sourcesJson || '[]'), ...(sourceName ? [sourceName] : [])])]
      .sort((a, b) => a.localeCompare(b))
    const responses = Math.max(0, Number(lane.responseCount) || 0)
    const statusCode = Number.isInteger(lane.statusCode) ? lane.statusCode! : null
    const data = {
      platform: String(lane.platform || 'unknown').slice(0, 24),
      endpoint: lane.endpoint.slice(0, 2_000),
      method: String(lane.method || 'GET').toUpperCase().slice(0, 16),
      requestShapeHash: lane.requestShapeHash!.slice(0, 64),
      dedupeKey: String(lane.dedupeKey || '').slice(0, 64),
      keyHash: lane.keyHash || null,
      sourcesJson: JSON.stringify(sources),
      callCount: Math.max(0, Number(lane.callCount) || 0),
      networkCount: Math.max(0, Number(lane.networkCount) || 0),
      responseCount: responses,
      httpOkCount: responses > 0 && statusCode !== null && statusCode >= 200 && statusCode < 400 ? responses : 0,
      addressCount: lane.urlExists === true && statusCode !== null && statusCode >= 200 && statusCode < 300 ? responses : 0,
      lastSeenAt: new Date(),
      ...(responses > 0 ? {
        lastStatusCode: statusCode,
        lastContentType: lane.contentType ? String(lane.contentType).slice(0, 120) : null,
        lastBodyType: lane.bodyType ? String(lane.bodyType).slice(0, 24) : null,
        lastCode: lane.code == null ? null : String(lane.code).slice(0, 80),
        lastMsg: lane.msg == null ? null : String(lane.msg).slice(0, 240),
        lastUrlExists: typeof lane.urlExists === 'boolean' ? lane.urlExists : null,
      } : {}),
    }
    await prisma.apiInterface.upsert({
      where: { id: lane.interfaceId },
      create: { id: lane.interfaceId, ...data },
      update: {
        ...data,
        callCount: { increment: data.callCount },
        networkCount: { increment: data.networkCount },
        responseCount: { increment: data.responseCount },
        httpOkCount: { increment: data.httpOkCount },
        addressCount: { increment: data.addressCount },
      },
    })
  }
}

export function recordRuntimeTrace(trace: RuntimeApiTrace, configuredSource?: string): Promise<void> {
  if (!trace?.lanes?.some(validLane)) return Promise.resolve()
  const task = writeQueue.then(() => persistTrace(trace, configuredSource))
  writeQueue = task.catch(() => {})
  return task
}

export async function getApiCatalog(): Promise<{
  interfaces: Array<Record<string, unknown> & { id: string; sources: string[]; dedupeKey: string }>
  duplicateGroups: Array<{ dedupeKey: string; interfaceIds: string[]; sources: string[] }>
  latestProbes: Record<string, Record<string, unknown>>
}> {
  const [rows, probes] = await Promise.all([
    prisma.apiInterface.findMany({ orderBy: { lastSeenAt: 'desc' }, take: 5_000 }),
    prisma.apiInterfaceProbe.findMany({ orderBy: { createdAt: 'desc' }, take: 1_000 }),
  ])
  const latestProbes: Record<string, Record<string, unknown>> = {}
  for (const probe of probes) {
    if (!latestProbes[probe.interfaceId]) latestProbes[probe.interfaceId] = probe
  }
  const interfaces = rows.map(row => ({
    ...row,
    sources: safeSources(row.sourcesJson),
    dedupeKey: row.dedupeKey || '',
  }))
  const groups = new Map<string, { interfaceIds: string[]; sources: Set<string>; dedupeKey: string }>()
  for (const row of interfaces) {
    const dedupeKey = row.dedupeKey || [row.endpoint, row.method, row.requestShapeHash, row.keyHash || ''].join('\n')
    const key = `${row.platform}\n${dedupeKey}`
    const group = groups.get(key) || { interfaceIds: [], sources: new Set<string>(), dedupeKey }
    group.interfaceIds.push(row.id)
    for (const source of row.sources) group.sources.add(source)
    groups.set(key, group)
  }
  return {
    interfaces,
    duplicateGroups: [...groups.values()]
      .filter(group => group.interfaceIds.length > 1)
      .map(group => ({
        dedupeKey: group.dedupeKey,
        interfaceIds: group.interfaceIds.sort(),
        sources: [...group.sources].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => b.interfaceIds.length - a.interfaceIds.length),
    latestProbes,
  }
}

export async function setApiInterfaceSelection(updates: Array<{ id: string; enabled: boolean }>): Promise<number> {
  const unique = [...new Map(updates.map(item => [item.id, item.enabled])).entries()]
  const results = await prisma.$transaction([
    prisma.apiInterface.updateMany({ where: { id: { in: unique.filter(([, enabled]) => !enabled).map(([id]) => id) } }, data: { enabled: false } }),
    prisma.apiInterface.updateMany({ where: { id: { in: unique.filter(([, enabled]) => enabled).map(([id]) => id) } }, data: { enabled: true } }),
  ])
  invalidateApiInterfacePolicy()
  return results.reduce((sum, result) => sum + result.count, 0)
}

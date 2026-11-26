import { apiGet, apiPost, apiPut } from './client'
import type { MusicInfo } from '@/lib/types/music'

export interface ApiCatalogInterface {
  id: string
  platform: string
  endpoint: string
  method: string
  requestShapeHash: string
  dedupeKey: string
  keyHash: string | null
  sources: string[]
  enabled: boolean
  callCount: number
  networkCount: number
  responseCount: number
  httpOkCount: number
  addressCount: number
  lastStatusCode: number | null
  lastContentType: string | null
  lastBodyType: string | null
  lastCode: string | null
  lastMsg: string | null
  lastUrlExists: boolean | null
  firstSeenAt: string
  lastSeenAt: string
}

export interface ApiCatalogDuplicateGroup {
  dedupeKey: string
  interfaceIds: string[]
  sources: string[]
}

export interface ApiInterfaceProbeResult {
  id: string
  interfaceId: string
  source: string
  platform: string
  quality: string
  songmid: string
  outcome: string
  latencyMs: number | null
  statusCode: number | null
  code: string | null
  msg: string | null
  urlExists: boolean | null
  urlHost: string | null
  container: string | null
  detail: string | null
  createdAt: string
}

export interface ApiCatalogView {
  interfaces: ApiCatalogInterface[]
  duplicateGroups: ApiCatalogDuplicateGroup[]
  latestProbes: Record<string, ApiInterfaceProbeResult>
  updated?: number
}

export function getApiCatalog(): Promise<ApiCatalogView> {
  return apiGet<ApiCatalogView>('admin/api-catalog')
}

export function saveApiCatalog(updates: Array<{ id: string; enabled: boolean }>): Promise<ApiCatalogView> {
  return apiPut<ApiCatalogView>('admin/api-catalog', { updates })
}

export function getApiProbeSamples(): Promise<{ samples: Record<string, MusicInfo[]> }> {
  return apiGet<{ samples: Record<string, MusicInfo[]> }>('admin/api-catalog/probe')
}

export function probeApiInterface(interfaceId: string, source: string, quality = '320k', musicInfo?: MusicInfo): Promise<ApiInterfaceProbeResult> {
  return apiPost<ApiInterfaceProbeResult>('admin/api-catalog/probe', { interfaceId, source, quality, musicInfo })
}

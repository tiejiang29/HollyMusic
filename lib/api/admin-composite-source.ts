import { apiGet, apiPut } from './client'
import type { SourceType } from '@/lib/types/music'

export interface CompositeMember {
  sourceName: string
  platform: SourceType
}

export interface CompositeSettings {
  enabled: boolean
  members: CompositeMember[]
  width: number
  holdMs: number
  resolveMs: number
  headerMs: number
  chainMs: number
}

export interface CompositeLaneStat {
  laneId: string
  endpoint: string
  keyHash: string | null
  sourceName: string | null
  platform: string | null
  quality: string | null
  attempts: number
  httpOk: number
  httpBad: number
  payloadBad: number
  successRate: number | null
  lastUsedAt: number
  lastError: string | null
  badUntil: number
  cooling: boolean
  retryAfterMs: number
}

export interface CompositeView {
  settings: CompositeSettings
  lanes: CompositeLaneStat[]
}

export function getCompositeSource(): Promise<CompositeView> {
  return apiGet<CompositeView>('admin/composite-source')
}

export function saveCompositeSource(settings: CompositeSettings): Promise<CompositeView> {
  return apiPut<CompositeView>('admin/composite-source', settings)
}

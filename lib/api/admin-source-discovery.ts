/**
 * 音源发现 API 客户端（admin 面板用）
 */

import { apiGet, apiPost, apiPut } from './client'

export interface DiscoverySettingsView {
  enabled: boolean
  repos: string[]
  maxCandidatesPerRepo: number
  maxDownloadsPerRound: number
  /** token 永不出网：只给"配没配"和脱敏尾巴 */
  hasToken: boolean
  tokenTail: string
}

export interface DiscoveryStatus {
  running: boolean
  phase: string
  reposDone: number
  reposTotal: number
  downloaded: number
  startedAt: string | null
  last: {
    reposScanned: number
    seen: number
    created: number
    refreshed: number
    downloaded: number
    suspect: number
    notSource: number
    stale: number
    note: string | null
    /** 树被 GitHub 截断的仓库：这仓的结果是不完整的，不能当"就这些" */
    truncatedRepos: string[]
    /** 本轮跳过的仓库及原因（404 / 配额 / HTTP 错误…） */
    reposSkipped: string[]
    quota: { remaining: number; limit: number; resetAt: number } | null
  } | null
  lastError: string | null
}

export interface DiscoveryCandidate {
  id: number
  repo: string
  path: string
  rawUrl: string
  scriptName: string
  score: number
  verdict: 'pending' | 'suspect' | 'not-source' | string
  state: 'new' | 'stale' | string
  reason: string | null
  sizeBytes: number
  checkedAt: string | null
}

export interface DiscoveryView {
  settings: DiscoverySettingsView
  status: DiscoveryStatus
  counts: Record<string, number>
  candidates: DiscoveryCandidate[]
}

export function getDiscovery(filter: { verdict?: string; state?: string } = {}): Promise<DiscoveryView> {
  const query = new URLSearchParams()
  if (filter.verdict) query.set('verdict', filter.verdict)
  if (filter.state) query.set('state', filter.state)
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return apiGet<DiscoveryView>(`admin/source-discovery${suffix}`)
}

export function startDiscoveryCrawl(): Promise<{ started: boolean; reason?: string }> {
  return apiPost<{ started: boolean; reason?: string }>('admin/source-discovery', { action: 'crawl' })
}

export function dismissDiscoveryCandidate(id: number): Promise<{ dismissed: number }> {
  return apiPost<{ dismissed: number }>('admin/source-discovery', { action: 'dismiss', id })
}

export function saveDiscoverySettings(payload: {
  enabled?: boolean
  repos?: string[]
  maxCandidatesPerRepo?: number
  maxDownloadsPerRound?: number
  githubToken?: string
  clearToken?: boolean
}): Promise<{ settings: DiscoverySettingsView; rejected: string[] }> {
  return apiPut<{ settings: DiscoverySettingsView; rejected: string[] }>('admin/source-discovery', payload)
}

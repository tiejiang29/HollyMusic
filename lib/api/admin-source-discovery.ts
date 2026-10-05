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
  /** 正在判级的候选 id；null = 没有（判级一次只允许一个） */
  probingId: number | null
  lastProbeNote: string | null
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

export interface ProbeCellView {
  outcome: string
  latencyMs: number | null
  container: string | null
  reason: string | null
}

export interface CandidateProbeView {
  cells: Record<string, ProbeCellView>
  /** null = tree 里本来没给 blob sha（无从校验） */
  shaVerified: boolean | null
  note: string | null
}

export interface DiscoveryCandidate {
  id: number
  repo: string
  path: string
  rawUrl: string
  scriptName: string
  score: number
  verdict: 'pending' | 'suspect' | 'not-source' | string
  state: 'new' | 'stale' | 'imported' | string
  reason: string | null
  sizeBytes: number
  checkedAt: string | null
  /** P0-b 判级结果；null = 还没判过 */
  probe: CandidateProbeView | null
  probedAt: string | null
  /** P0-c：已导入时它在 custom-sources 下的路径；空串 = 没导入过 */
  importedPath: string
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

/** 起一次判级（服务端异步执行，结果靠 getDiscovery 轮询） */
export function startCandidateProbe(id: number): Promise<{ started: boolean; reason?: string }> {
  return apiPost<{ started: boolean; reason?: string }>('admin/source-discovery', { action: 'probe', id })
}

export function dismissDiscoveryCandidate(id: number): Promise<{ dismissed: number }> {
  return apiPost<{ dismissed: number }>('admin/source-discovery', { action: 'dismiss', id })
}

/**
 * 把候选导入成正式音源。只传 id：服务端按自己那行记录重下载并复验 blob sha，
 * 判级没有一个平台出货时会被 409 挡回来，`force` 是给管理员"看着红绿灯坚持装"的那一档。
 */
export function importDiscoveryCandidate(id: number, force = false): Promise<{ imported: { id: number; path: string; name: string } }> {
  return apiPost<{ imported: { id: number; path: string; name: string } }>('admin/source-discovery', { action: 'import', id, force })
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

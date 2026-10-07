/**
 * 音源发现 API 客户端（admin 面板用）
 */

import { apiGet, apiPost, apiPut } from './client'

export interface DiscoverySettingsView {
  enabled: boolean
  repos: string[]
  maxCandidatesPerRepo: number
  maxDownloadsPerRound: number
  /** 有 release 的仓只取最新一次发布的 .js 资产（默认开） */
  preferLatestRelease: boolean
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
  /** 连轮里的第几轮；单轮恒为 1 */
  round: number
  /** 连轮（清完待判定）在跑 */
  draining: boolean
  /** 按过停止，等它在下一个仓/下一轮生效 */
  stopRequested: boolean
  /** 上一次连轮的总账 */
  drainLast: {
    rounds: number
    downloaded: number
    suspect: number
    notSource: number
    stale: number
    pendingLeft: number
    stopped: boolean
    note: string | null
  } | null
  /** 正在跑的批量判级（一批 ≤limit 条，串行逐条，真打第三方取址）；null = 没有 */
  probeBatch: {
    total: number
    done: number
    withAddress: number
    failed: number
    stopped: boolean
    note: string | null
    running: boolean
    limit: number
  } | null
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
    /** 被手动停止中断的这一轮（连轮据此不再接着跑） */
    stopped: boolean
    /** 树被 GitHub 截断的仓库：这仓的结果是不完整的，不能当"就这些" */
    truncatedRepos: string[]
    /** 本轮跳过的仓库及原因（404 / 配额 / HTTP 错误…） */
    reposSkipped: string[]
    /** 本轮走"最新 release 资产"采集的仓（面板要说，否则候选数突然塌下去没人能解释） */
    releaseRepos: string[]
    /** 查了 release 但回落 tree 的仓与原因（没发过 / 不是 .js 资产 / 这次没查到） */
    releaseFallbacks: string[]
    /** zip 包的处置：为什么没收、跳过的条目、每包上限没登记多少条、包没换跳过重下 */
    zipNotes: string[]
    /** 因为改走 release 采集而被标成"已被顶掉"的 tree 历史行数 */
    releaseSuperseded: number
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
  /** P0-c：撞上了**已经装着的源**（content=字节相同 / name=同名不同内容）；null = 没撞 */
  duplicateOf: { kind: 'content' | 'name'; path: string; name: string } | null
  /** 只提示不拦：库里有条源名字与它近似（作者后缀不同，归一后不相等），可能是同一个源的另一个版本 */
  similarTo: { path: string; name: string } | null
  /** 非空 = 这条来自某个 release 的资产（此时 path 是资产文件名，不是仓库内路径） */
  releaseTag: string
  /** 非空 = 正文在 rawUrl 那个 zip 里，这是包内条目名 */
  zipMember: string
  /** GitHub 记录的资产 sha256（`sha256:<hex>`）；空 = tree 采集或它没给 */
  assetDigest: string
  /** 上游时间：release 采集是发布时间；tree 采集通常为空（raw 的 HEAD 路径不回 Last-Modified） */
  upstreamAt: string
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

export function startDiscoveryCrawl(onlyRepos?: string[]): Promise<{ started: boolean; reason?: string }> {
  return apiPost<{ started: boolean; reason?: string }>('admin/source-discovery', {
    action: 'crawl',
    // 空数组与不给是同一件事（扫全清单），别把 [] 传上去让人以为"扫 0 个仓"
    ...(onlyRepos && onlyRepos.length ? { repos: onlyRepos } : {}),
  })
}

/** 搜索结果里的一行：只有元数据，正文一个字节都不落地 */
export interface RepoSearchItemView {
  repo: string
  description: string
  stars: number
  lastPushAt: string
  language: string
  fork: boolean
  archived: boolean
  /** 已经在扫描清单里 —— 面板据此置灰，避免重复勾选 */
  alreadyListed: boolean
}

export interface RepoSearchResultView {
  total: number
  page: number
  pageSize: number
  sort: 'best' | 'updated' | 'stars'
  incomplete: boolean
  /** 搜索接口自己的配额档，与爬仓库树的 core 额度分开算 */
  quota: { remaining: number; limit: number; resetAt: number } | null
  items: RepoSearchItemView[]
}

/** 按关键词搜 GitHub 仓库。**只返回候选清单**，不会改配置、不会扫描、不会下载正文 */
export function searchDiscoveryRepos(
  query: string,
  opts: { page?: number; sort?: 'best' | 'updated' | 'stars'; pageSize?: number } = {},
): Promise<RepoSearchResultView> {
  return apiPost<RepoSearchResultView>('admin/source-discovery', { action: 'search', query, ...opts })
}

/** 体检结果里的一行：一个仓多久没动、归档了没、还在不在 */
export interface RepoFreshnessItem {
  repo: string
  lastPushAt: string
  /** null = GitHub 没给可读的时间，此时不判停更 */
  daysSince: number | null
  stars: number
  archived: boolean
  missing: boolean
  /** 改名/转移 owner 后的规范名；空串 = 没挪 */
  movedTo: string
  candidates: number
  stale: boolean
}

export interface RepoFreshnessReport {
  checked: number
  maxAgeDays: number
  quota: { remaining: number; limit: number; resetAt: number } | null
  items: RepoFreshnessItem[]
  /** 查不动的仓（超时/5xx）：它们**不**被判成停更 */
  failed: string[]
}

/** 体检扫描清单里的仓库多久没更新（只读；剔不剔由随后那次保存清单决定） */
export function auditRepoFreshness(maxAgeDays?: number): Promise<RepoFreshnessReport> {
  return apiPost<RepoFreshnessReport>('admin/source-discovery', { action: 'freshness', maxAgeDays })
}

/** 连轮清完待判定（一轮吃满下载额度就自动接下一轮） */
export function startDiscoveryDrain(): Promise<{ started: boolean; reason?: string }> {
  return apiPost<{ started: boolean; reason?: string }>('admin/source-discovery', { action: 'drain' })
}

/** 请求停止：当前这一轮扫完手上的仓就收，连轮不再起下一轮 */
export function stopDiscovery(): Promise<{ stopping: boolean }> {
  return apiPost<{ stopping: boolean }>('admin/source-discovery', { action: 'stop' })
}

/** 起一次判级（服务端异步执行，结果靠 getDiscovery 轮询）。force = 「仍然判级」那一档 */
export function startCandidateProbe(id: number, force = false): Promise<{ started: boolean; reason?: string }> {
  return apiPost<{ started: boolean; reason?: string }>('admin/source-discovery', { action: 'probe', id, force })
}

/** 批量判级：把"在册且没判过"的候选排队逐条判，一批最多 50 条（服务端定死，不在 UI 里另抄） */
export function startCandidateProbeBatch(): Promise<{ started: boolean; reason?: string }> {
  return apiPost<{ started: boolean; reason?: string }>('admin/source-discovery', { action: 'probe-batch' })
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

/** 清掉已从扫描列表里移除的仓留下的候选行（已导入成音源的保留） */
export function pruneOrphanCandidates(): Promise<{ removed: number; keptImported: string[] }> {
  return apiPost<{ removed: number; keptImported: string[] }>('admin/source-discovery', { action: 'prune' })
}

export function saveDiscoverySettings(payload: {
  enabled?: boolean
  repos?: string[]
  maxCandidatesPerRepo?: number
  maxDownloadsPerRound?: number
  preferLatestRelease?: boolean
  githubToken?: string
  clearToken?: boolean
}): Promise<{ settings: DiscoverySettingsView; rejected: string[] }> {
  return apiPut<{ settings: DiscoverySettingsView; rejected: string[] }>('admin/source-discovery', payload)
}

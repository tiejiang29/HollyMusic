/**
 * 音源发现 P0-a：从 GitHub 仓库树里挑出"疑似洛雪音源脚本"的候选，静态打分 + 去重后落库供面板查看。
 *
 * 三条边界是这一期存在的理由，改动前先看清：
 * 1. **只发现，不执行、不入库正文**。候选表里只有元数据（地址、blob sha、内容哈希、打分、判定）；
 *    脚本文本抓来做打分就丢，既不占库也不把第三方代码留在我们服务器上。真要导入（P0-c）时再按
 *    rawUrl 重新下载并复验。
 * 2. **不改生产取址路径**：不写 config/music-sources.json、不碰健康账本、不调用沙箱。
 * 3. **GitHub 仓库地址是唯一可由管理员输入的自由文本**，所以它同时也是本模块的 SSRF 面：
 *    先按 `owner/repo` 白名单形状校验，再逐段 encodeURIComponent，host 恒定两个，最后仍走
 *    safePublicFetch 的 DNS 级闸门。三道里拆掉任一道都不该变成裸请求。
 *
 * 参考对象是 zlyon/lx-hunter（GPL-3.0）的流程，本文件为独立实现，未复制其代码。
 */

import { createHash } from 'node:crypto'
import { logger } from '@/lib/logger'
import { prisma } from '@/lib/db'
import { readSetting, writeSetting } from '@/lib/services/app-setting'
import { safePublicFetch } from '@/lib/server/url-guard'
import { parseScriptMeta } from '@/lib/services/source-manager-service'

export const DISCOVERY_SETTING_KEY = 'sourceDiscovery'

export interface DiscoverySettings {
  /** 总开关：默认关。发现出来的是第三方脚本，不给"装好就自己跑"的默认值 */
  enabled: boolean
  repos: string[]
  /** 单仓一次最多收多少个 .js 候选（防止把整个仓库的 js 都当音源） */
  maxCandidatesPerRepo: number
  /** 单轮最多下多少个正文做打分（GitHub raw 不限流但我们的时间限流） */
  maxDownloadsPerRound: number
  /** 只用于提升 API 限额的 token，可以没有任何 scope；出网一律脱敏 */
  githubToken: string
}

/**
 * 起步清单：社区里长期流传的公开音源仓库（事实性的仓库名，不含任何脚本内容）。
 * 用户可以增删；默认关着，所以这份清单本身不产生任何出网行为。
 */
export const DEFAULT_DISCOVERY_SETTINGS: DiscoverySettings = {
  enabled: false,
  repos: [
    'pdone/lx-music-source',
    'Huibq/keep-alive',
    'xzh767/lxmusic-source-all',
    'liuyangh/yuting',
    'jeffernn/music-source',
    'Qian-Ning/LX-Music-Source',
  ],
  maxCandidatesPerRepo: 300,
  maxDownloadsPerRound: 80,
  githubToken: '',
}

export class SourceDiscoveryError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'SourceDiscoveryError'
    this.status = status
  }
}

const API_HOST = 'https://api.github.com'
const RAW_HOST = 'https://raw.githubusercontent.com'
const REQUEST_TIMEOUT_MS = 15_000
/** 单个脚本正文的上限：实测真音源都在几十到几百 KB，超过这个数基本是打包产物或别的东西 */
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024
/** 打分阈值：只靠"文件名像"不够，必须有脚本自身特征才能进 suspect */
const SUSPECT_THRESHOLD = 5
const GAP_BETWEEN_REPOS_MS = 400

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 仓库名的形状校验：只接受 `owner/repo`，别的（含 URL、含路径穿越）一律拒 */
export function normalizeRepo(input: string): string | null {
  const trimmed = input.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '')
  const match = trimmed.match(/^([\w.-]{1,100})\/([\w.-]{1,100})$/)
  if (!match) return null
  return `${match[1]}/${match[2]}`
}

/**
 * 路径过滤：只要 .js，排掉构建产物与测试目录。
 * 这条口径的理由是"少下东西"，不是"识别音源"——识别在打分那一步。
 */
export function isPlausibleScriptPath(path: string): boolean {
  if (!/\.js$/i.test(path)) return false
  if (/(^|\/)(node_modules|test|tests|__tests__|dist|build|assets|vendor)(\/|$)/i.test(path)) return false
  return !/^(webpack|vite|rollup|babel|jest|eslint|tsconfig|karma|gulp|grunt)[.-]/i.test(path.split('/').pop() || '')
}

/**
 * 静态特征打分（不执行脚本）。文件名类信号给分低、脚本自身 API 信号给分高，
 * 合起来过阈值才算疑似：只匹配"source"字样的 README 附带的 js 会被压在阈值下。
 */
export function scoreCandidate(path: string, content: string): { score: number; hits: string[] } {
  const filename = path.split('/').pop() || ''
  const hits: string[] = []
  let score = 0

  const add = (points: number, label: string) => {
    score += points
    hits.push(label)
  }

  if (/音源|源/.test(filename)) add(2, '文件名含「音源」')
  else if (/lx[-_.]?music|lx[-_.]?source|music[-_.]?source/i.test(filename)) add(2, '文件名含 lx/source')
  if (/^(lx|src|source|music)[-_ .]/i.test(filename)) add(1, '文件名前缀')

  // 洛雪脚本的运行期特征：这些只在真脚本里成组出现
  if (content.includes('globalThis.lx')) add(3, 'globalThis.lx')
  if (content.includes('EVENT_NAMES')) add(2, 'EVENT_NAMES')
  if (/\blx\.on\s*\(/.test(content)) add(2, 'lx.on(')
  if (/\b(registerMultimodel|registerSearch|musicUrl|multimodel)\b/.test(content)) add(2, '取址接口')
  if (/@name\s+\S/.test(content)) add(1, '@name 元数据')

  return { score, hits }
}

/** `@name` 归一键：剥掉尾部版本号与括号注记、去空白标点，用来认"同一个源换了名重发" */
export function toNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[（(][^）)]*[)）]/g, ' ')
    .replace(/\bv?\d+(?:[._-]\d+)*\b/g, ' ')
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * 同名/同内容择优。排序口径按可靠性从高到低：
 * 上游更新时间新 → 版本号大 → 打分高 → id 小（稳定 tiebreak）。
 */
export function betterKeeper(a: { lastModified: string; scriptVersion: string; score: number; id: number }, b: { lastModified: string; scriptVersion: string; score: number; id: number }): -1 | 1 {
  if (a.lastModified !== b.lastModified) return a.lastModified > b.lastModified ? -1 : 1
  const versionA = compareVersion(a.scriptVersion)
  const versionB = compareVersion(b.scriptVersion)
  if (versionA !== versionB) return versionA > versionB ? -1 : 1
  if (a.score !== b.score) return a.score > b.score ? -1 : 1
  return a.id < b.id ? -1 : 1
}

function compareVersion(value: string): bigint {
  const parts = (value || '0').split(/[._-]/).map(part => (/^\d+$/.test(part) ? part : '0'))
  const padded = [parts[0] || '0', parts[1] || '0', parts[2] || '0', parts[3] || '0']
  return BigInt(padded.map(part => part.padStart(6, '0')).join(''))
}

interface TreeEntry {
  path?: unknown
  type?: unknown
  sha?: unknown
  size?: unknown
}

interface RateLimitInfo {
  remaining: number
  limit: number
  resetAt: number
}

async function githubFetch(url: string, token: string, init: Omit<RequestInit, 'redirect'> = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    // 仍然走 safePublicFetch：host 虽然是常量，但 DNS 会重绑，闸门不因为"是我拼的地址"就跳过
    return await safePublicFetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'HollyMusic-source-discovery',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

/** `/rate_limit` 不计入配额，所以每轮开头免费拿一次真相 */
async function readRateLimit(token: string): Promise<RateLimitInfo | null> {
  try {
    const response = await githubFetch(`${API_HOST}/rate_limit`, token)
    if (!response.ok) return null
    const payload = await response.json() as { resources?: { core?: { remaining?: unknown; limit?: unknown; reset?: unknown } } }
    const core = payload.resources?.core
    if (!core) return null
    return { remaining: Number(core.remaining) || 0, limit: Number(core.limit) || 0, resetAt: Number(core.reset) || 0 }
  } catch (err) {
    logger.debug('[discovery] 配额预检失败（按无配额信息继续）:', err)
    return null
  }
}

export interface CrawlSummary {
  reposScanned: number
  reposSkipped: string[]
  truncatedRepos: string[]
  seen: number
  created: number
  refreshed: number
  downloaded: number
  suspect: number
  notSource: number
  stale: number
  quota: RateLimitInfo | null
  note: string | null
}

interface ProgressState {
  running: boolean
  phase: string
  reposDone: number
  reposTotal: number
  downloaded: number
  startedAt: string | null
  last: CrawlSummary | null
  lastError: string | null
}

let runningTask: Promise<CrawlSummary> | null = null
const progress: ProgressState = {
  running: false,
  phase: 'idle',
  reposDone: 0,
  reposTotal: 0,
  downloaded: 0,
  startedAt: null,
  last: null,
  lastError: null,
}

export function discoveryStatus(): ProgressState {
  return { ...progress }
}

export async function getDiscoverySettings(): Promise<DiscoverySettings> {
  return readSetting<DiscoverySettings>(DISCOVERY_SETTING_KEY, DEFAULT_DISCOVERY_SETTINGS)
}

/** 校验并归一化后落库；返回的是**已生效**的配置（含被丢掉非法仓库的说明） */
export async function saveDiscoverySettings(patch: Partial<DiscoverySettings>): Promise<{ settings: DiscoverySettings; rejected: string[] }> {
  const current = await getDiscoverySettings()
  const rejected: string[] = []

  const reposInput = Array.isArray(patch.repos) ? patch.repos : current.repos
  const repos: string[] = []
  for (const raw of reposInput) {
    if (typeof raw !== 'string') { rejected.push(String(raw)); continue }
    const normalized = normalizeRepo(raw)
    if (!normalized) { rejected.push(raw); continue }
    if (!repos.includes(normalized)) repos.push(normalized)
  }

  const next: DiscoverySettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    repos,
    maxCandidatesPerRepo: clampInt(patch.maxCandidatesPerRepo, current.maxCandidatesPerRepo, 1, 300),
    maxDownloadsPerRound: clampInt(patch.maxDownloadsPerRound, current.maxDownloadsPerRound, 0, 500),
    // 空串视为"不改动"，清空要走显式的 clearToken，避免面板回显时把 token 抹掉
    githubToken: typeof patch.githubToken === 'string' && patch.githubToken.trim() ? patch.githubToken.trim() : current.githubToken,
  }

  await writeSetting(DISCOVERY_SETTING_KEY, next)
  if (rejected.length) logger.info('[discovery] 忽略掉的仓库写法不合法', { rejected: rejected.slice(0, 5) })
  return { settings: next, rejected }
}

export async function clearDiscoveryToken(): Promise<DiscoverySettings> {
  const current = await getDiscoverySettings()
  const next = { ...current, githubToken: '' }
  await writeSetting(DISCOVERY_SETTING_KEY, next)
  return next
}

function clampInt(value: unknown, fallback: number, low: number, high: number): number {
  const parsed = typeof value === 'number' ? Math.trunc(value) : Number(value)
  if (!Number.isFinite(parsed)) return clampIntRaw(fallback, low, high)
  return clampIntRaw(parsed, low, high)
}

function clampIntRaw(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

function buildTreeUrl(repo: string): string {
  const [owner, name] = repo.split('/')
  return `${API_HOST}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/HEAD?recursive=1`
}

function buildRawUrl(repo: string, path: string): string {
  const [owner, name] = repo.split('/')
  const encoded = path.split('/').map(segment => encodeURIComponent(segment)).join('/')
  return `${RAW_HOST}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/HEAD/${encoded}`
}

export function runDiscoveryCrawl(): Promise<CrawlSummary> {
  if (runningTask) return runningTask
  runningTask = doCrawl().finally(() => { runningTask = null })
  return runningTask
}

async function doCrawl(): Promise<CrawlSummary> {
  const settings = await getDiscoverySettings()
  if (!settings.enabled) throw new SourceDiscoveryError('音源发现未启用，先在面板上打开开关')
  if (!settings.repos.length) throw new SourceDiscoveryError('仓库清单是空的，没有可扫描的目标')

  const summary: CrawlSummary = {
    reposScanned: 0, reposSkipped: [], truncatedRepos: [], seen: 0, created: 0, refreshed: 0,
    downloaded: 0, suspect: 0, notSource: 0, stale: 0, quota: null, note: null,
  }
  progress.running = true
  progress.phase = '配额预检'
  progress.reposTotal = settings.repos.length
  progress.reposDone = 0
  progress.downloaded = 0
  progress.startedAt = new Date().toISOString()
  progress.lastError = null

  try {
    // 一轮里 API 调用数 ≈ 仓库数（树）+ 正文数（raw 不吃 API 配额，但占时间）
    summary.quota = await readRateLimit(settings.githubToken)
    if (summary.quota && summary.quota.remaining < settings.repos.length) {
      throw new SourceDiscoveryError(
        `GitHub API 余量 ${summary.quota.remaining}，本轮需要 ${settings.repos.length} 次仓库树调用。`
        + `配一个只读 token 或删掉些仓库再来（token 只需提升限额，不要求任何 scope）`,
        429,
      )
    }

    let downloadBudget = settings.maxDownloadsPerRound
    for (const repo of settings.repos) {
      progress.phase = `扫描 ${repo}`
      try {
        const counted = await crawlRepo(repo, settings, summary, downloadBudget)
        downloadBudget -= counted
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        summary.reposSkipped.push(`${repo}：${reason.slice(0, 80)}`)
        logger.info('[discovery] 仓库跳过', { repo, reason })
      }
      progress.reposDone++
      await sleep(GAP_BETWEEN_REPOS_MS)
    }

    progress.phase = '去重择优'
    summary.stale = await dedupeCandidates()

    summary.note = downloadBudget <= 0
      ? `本轮下载额度（${settings.maxDownloadsPerRound}）用尽，剩下的候选留在 pending，下轮继续`
      : null
    progress.last = summary
    logger.info('[discovery] 一轮发现完成', {
      仓库: summary.reposScanned, 候选: summary.seen, 新采: summary.created, 疑似: summary.suspect,
      非音源: summary.notSource, 顶掉: summary.stale, 配额: summary.quota?.remaining ?? '未知',
    })
    return summary
  } catch (err) {
    progress.lastError = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    progress.running = false
    progress.phase = 'idle'
  }
}

async function crawlRepo(
  repo: string,
  settings: DiscoverySettings,
  summary: CrawlSummary,
  downloadBudget: number,
): Promise<number> {
  const response = await githubFetch(buildTreeUrl(repo), settings.githubToken)
  if (response.status === 404) throw new SourceDiscoveryError('仓库不存在或不可访问', 404)
  if (!response.ok) throw new SourceDiscoveryError(`GitHub 返回 HTTP ${response.status}`, response.status === 403 ? 403 : 502)
  const payload = await response.json() as { tree?: unknown; truncated?: unknown }
  const tree = Array.isArray(payload.tree) ? payload.tree as TreeEntry[] : []
  if (payload.truncated === true) {
    summary.truncatedRepos.push(repo)
    logger.info('[discovery] 仓库树被截断，本仓结果不完整', { repo, 条目: tree.length })
  }

  let used = 0
  const paths: Array<{ path: string; sha: string; size: number }> = []
  for (const entry of tree) {
    if (paths.length >= settings.maxCandidatesPerRepo) break
    if (entry.type !== 'blob' || typeof entry.path !== 'string') continue
    if (!isPlausibleScriptPath(entry.path)) continue
    paths.push({ path: entry.path, sha: typeof entry.sha === 'string' ? entry.sha : '', size: Number(entry.size) || 0 })
  }

  for (const entry of paths) {
    const rawUrl = buildRawUrl(repo, entry.path)
    const existing = await prisma.sourceCandidate.findUnique({
      where: { repo_path: { repo, path: entry.path } },
      select: { id: true, blobSha: true, verdict: true },
    })
    if (existing) {
      await prisma.sourceCandidate.update({ where: { id: existing.id }, data: { rawUrl, blobSha: entry.sha, sizeBytes: entry.size } })
      summary.refreshed++
      summary.seen++
      // 正文没变且已有判定 ⇒ 不必再下一遍；这一条是配额与时间的主要节省点
      if (existing.verdict !== 'pending' && existing.blobSha === entry.sha) continue
    } else {
      await prisma.sourceCandidate.create({ data: { repo, path: entry.path, rawUrl, blobSha: entry.sha, sizeBytes: entry.size } })
      summary.created++
      summary.seen++
    }

    if (used >= downloadBudget) continue
    if (entry.size > MAX_SCRIPT_BYTES) {
      await markNotSource(repo, entry.path, `正文 ${Math.round(entry.size / 1024)}KB 超过上限，不像单文件音源`)
      summary.notSource++
      continue
    }
    used++
    progress.downloaded++
    summary.downloaded++
    await downloadAndScore(repo, entry.path, rawUrl, settings.githubToken, summary)
  }

  summary.reposScanned++
  return used
}

async function downloadAndScore(
  repo: string,
  path: string,
  rawUrl: string,
  token: string,
  summary: CrawlSummary,
): Promise<void> {
  let content: string
  let lastModified = ''
  try {
    const response = await githubFetch(rawUrl, token, { headers: { Accept: 'text/plain' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const contentType = response.headers.get('content-type') || ''
    if (/text\/html/i.test(contentType)) throw new Error('返回的是网页不是文件')
    lastModified = response.headers.get('last-modified') || ''
    content = await response.text()
  } catch (err) {
    // 下载失败保留 pending：这是临时故障，不该把结论固化成"非音源"
    logger.info('[discovery] 正文抓取失败，留待下轮', { repo, path, reason: err instanceof Error ? err.message : String(err) })
    return
  }

  if (Buffer.byteLength(content, 'utf8') > MAX_SCRIPT_BYTES) {
    await markNotSource(repo, path, '正文超过上限')
    summary.notSource++
    return
  }

  const { score, hits } = scoreCandidate(path, content)
  const meta = parseScriptMeta(content)
  const suspect = score >= SUSPECT_THRESHOLD
  await prisma.sourceCandidate.update({
    where: { repo_path: { repo, path } },
    data: {
      score,
      verdict: suspect ? 'suspect' : 'not-source',
      reason: suspect ? hits.join('、') : `特征分 ${score} 未达 ${SUSPECT_THRESHOLD}（命中：${hits.join('、') || '无'}）`,
      contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
      scriptName: meta.name || '',
      // 只按归一后的 @name 分组：同名不同内容也要顶掉旧的（被顶的行不删，面板还能看见）
      nameKey: meta.name ? toNameKey(meta.name) : '',
      upstreamAt: lastModified || '',
      checkedAt: new Date(),
    },
  })
  if (suspect) summary.suspect++
  else summary.notSource++
}

async function markNotSource(repo: string, path: string, reason: string): Promise<void> {
  await prisma.sourceCandidate.update({
    where: { repo_path: { repo, path } },
    data: { verdict: 'not-source', reason, checkedAt: new Date() },
  })
}

/**
 * 两轮去重：同内容（sha256）与同名（@name 归一）各留一个"更优者"，其余标 stale 不删行
 * ——留着才看得清"为什么这条不见了"，也避免下轮重新建一遍。
 */
async function dedupeCandidates(): Promise<number> {
  const rows = await prisma.sourceCandidate.findMany({
    where: { verdict: 'suspect', state: 'new' },
    select: {
      id: true, repo: true, path: true, contentHash: true, nameKey: true, scriptName: true,
      score: true, upstreamAt: true,
    },
  })
  const versionOf = new Map<number, string>()
  for (const row of rows) versionOf.set(row.id, parseVersionFromPath(row.path, row.scriptName))

  const losers = new Set<number>()
  const groups = new Map<string, typeof rows>()
  const groupKey = (prefix: string, value: string) => value ? `${prefix}:${value}` : ''

  for (const row of rows) {
    const keys = [groupKey('hash', row.contentHash), groupKey('name', row.nameKey)].filter(Boolean)
    for (const key of keys) {
      const bucket = groups.get(key)
      if (bucket) bucket.push(row)
      else groups.set(key, [row])
    }
  }

  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue
    const keeper = bucket.reduce((best, item) => {
      return betterKeeper(rankOf(item, versionOf), rankOf(best, versionOf)) < 0 ? item : best
    }, bucket[0])
    for (const item of bucket) if (item.id !== keeper.id) losers.add(item.id)
  }

  let changed = 0
  for (const id of losers) {
    await prisma.sourceCandidate.update({ where: { id }, data: { state: 'stale' } })
    changed++
  }
  return changed
}

function rankOf(row: { upstreamAt: string; score: number; id: number }, versionOf: Map<number, string>) {
  return {
    lastModified: row.upstreamAt,
    scriptVersion: versionOf.get(row.id) || '',
    score: row.score,
    id: row.id,
  }
}

/** 版本号优先取 @name 里带的，其次从文件名里捞（`v1.2.0` 这种） */
function parseVersionFromPath(path: string, scriptName: string): string {
  const fromName = scriptName.match(/v?(\d+(?:[._-]\d+)+)/i) || path.match(/v?(\d+(?:[._-]\d+)+)/i)
  return fromName ? fromName[1] : ''
}

export interface CandidateView {
  id: number
  repo: string
  path: string
  rawUrl: string
  scriptName: string
  score: number
  verdict: string
  state: string
  reason: string | null
  sizeBytes: number
  checkedAt: string | null
}

export async function listCandidates(filter: { verdict?: string; state?: string; take?: number } = {}): Promise<CandidateView[]> {
  const rows = await prisma.sourceCandidate.findMany({
    where: {
      ...(filter.verdict ? { verdict: filter.verdict } : {}),
      ...(filter.state ? { state: filter.state } : {}),
    },
    orderBy: [{ score: 'desc' }, { updatedAt: 'desc' }],
    take: filter.take ?? 200,
  })
  return rows.map(row => ({
    id: row.id,
    repo: row.repo,
    path: row.path,
    rawUrl: row.rawUrl,
    scriptName: row.scriptName,
    score: row.score,
    verdict: row.verdict,
    state: row.state,
    reason: row.reason,
    sizeBytes: row.sizeBytes,
    checkedAt: row.checkedAt ? row.checkedAt.toISOString() : null,
  }))
}

export async function countCandidates(): Promise<Record<string, number>> {
  const grouped = await prisma.sourceCandidate.groupBy({ by: ['verdict', 'state'], _count: { id: true } })
  const out: Record<string, number> = {}
  for (const row of grouped) out[`${row.verdict}/${row.state}`] = row._count.id
  return out
}

/** 面板上手动剔除一条候选（只改 state，不删行） */
export async function dismissCandidate(id: number): Promise<void> {
  await prisma.sourceCandidate.update({ where: { id }, data: { state: 'stale' } }).catch(() => {})
}

/**
 * 音源发现：从 GitHub 仓库树里挑出"疑似洛雪音源脚本"的候选，静态打分去重后落库供面板查看（P0-a），
 * 在一次性子进程里真取一次址判级（P0-b），管理员点认可后导入成正式音源（P0-c）。
 *
 * 三条边界是这套流程存在的理由，改动前先看清：
 * 1. **不入库正文**。候选表里只有元数据（地址、blob sha、内容哈希、打分、判定、判级结果）；
 *    脚本文本只为打分与判级临时取一次，用完即弃 —— 既不占库，也不把第三方代码长期留在我们服务器上。
 *    唯一会落盘的入口是 `importCandidate`，那是管理员明确点了一次"导入"。
 * 2. **只有导入才碰生产**：`probeCandidate` 判级不写 `config/music-sources.json`、
 *    **也不写健康账本**。判级与导入都会执行第三方脚本，所以**执行前必须先复验 git blob sha**：
 *    内容对不上 tree 里那个 sha，就说明下来的不是同一份东西，绝不执行、绝不入库。
 * 3. **GitHub 仓库地址是唯一可由管理员输入的自由文本**，所以它同时也是本模块的 SSRF 面：
 *    先按 `owner/repo` 白名单形状校验，再逐段 encodeURIComponent，host 恒定两个，最后仍走
 *    safePublicFetch 的 DNS 级闸门。三道里拆掉任一道都不该变成裸请求。
 *    导入用的地址取自**库里那行记录**，不接受客户端传来的 URL。
 *
 * 参考对象是 zlyon/lx-hunter（GPL-3.0）的流程，本文件为独立实现，未复制其代码。
 */

import { createHash } from 'node:crypto'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { logger } from '@/lib/logger'
import { pickProbeSamples, verifyHead, type ProbeCellOutcome } from '@/lib/services/source-probe'
import { isContentMiss } from '@/lib/server/source-health'
import { prisma } from '@/lib/db'
import { readSetting, writeSetting } from '@/lib/services/app-setting'
import { safePublicFetch } from '@/lib/server/url-guard'
import { gitBlobSha } from '@/lib/server/git-blob-sha'
import { listZipEntries, extractZipEntry, type ZipLimits } from '@/lib/server/zip-read'
import { parseScriptMeta, importSubscription, readConfig, SOURCE_MANAGER_CONSTANTS, SourceSubscriptionError } from '@/lib/services/source-manager-service'
import type { SourceConfig } from '@/lib/types/music'

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
  /**
   * 有 release 的仓只取**最新一个 release 的 .js 资产**，不扫 tree。
   * 默认开：实测一个仓的 tree 里有 969 个像脚本的 .js（全是历史版本堆），
   * 而它最新一次发布就 1 个资产 —— 关掉它等于每月多收几百行噪音。
   */
  preferLatestRelease: boolean
}

/**
 * 起步清单：社区里长期流传的公开音源仓库，标识符来自 lx-hunter 公开发布的推荐清单与它的
 * 内置列表（仓库名是事实性数据，本模块不含它的任何代码）。**38 个已逐个 HEAD 验过还存在**
 * （2026-10-05，my/repo-seed-check.mjs；当时唯一验掉的是我先前拍脑袋加的 liuyangh/yuting=404）。
 *
 * 清单大就有代价：一轮 = 每仓一次树接口调用，匿名配额 60/小时，38 仓刚好还剩得不多；
 * 所以接口在起轮前做配额预检，不够就直说差多少，而不是硬打到 403。
 */
export const DEFAULT_DISCOVERY_SETTINGS: DiscoverySettings = {
  enabled: false,
  repos: [
    'pdone/lx-music-source',
    'Huibq/keep-alive',
    'xzh767/lxmusic-source-all',
    'liuyunss/LX-source',
    'skxingyu/lx_music-',
    'jeffernn/music-source',
    'Qian-Ning/LX-Music-Source',
    'oozzbb/LxMusicApi',
    'guoyue2010/lxmusic-',
    'ZxwyWebSite/lx-script',
    'ZxwyWebSite/lx-source',
    'laosunmaker/New_lxmusic_source',
    'cc2415/lx-custom-music-source',
    'ycquah00/lx-music-source-v5',
    'javon4016/xgzy-mysources',
    'pronii/lx-music-qdy-mini',
    'yanghook730-sketch/lx-music-source-yuanli',
    'fengyvle/yyt-music-sources',
    'peakshuoera/lx-music-source-manager',
    'wwnbalone/lx-manager',
    'NeoDtime/lxmusic-source3',
    'sphenoid-111/LXmusicyy',
    'lczj1215/lx-music',
    'a97083435/lxmusic-source',
    'LXJ-George666/LXMusic-Yinyuan',
    'LuoXiaohei-2025/LX-music-collection',
    'Macrohard0001/lx-ikun-music-sources',
    'lxmusics/lx-music-api-server-python',
    'hejuworld-droid/lx-music-source',
    'haonanren118/jiexiang-Music-Source',
    'hllsg/lx-music-myvip',
    'ZhonX07/lx-music-source-netease',
    'Scotlight/lx-music-source-gateway',
    'HJinTao/Listening',
    'mlik-git/lx-music',
    '7878gyc/gdstudio-lx-source',
    'piko017/-LX-luoxue_yinyuan',
    'wzh15802/lxmusic',
  ],
  maxCandidatesPerRepo: 300,
  maxDownloadsPerRound: 80,
  githubToken: '',
  preferLatestRelease: true,
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
/** release 资产的下载地址在 github.com（会 302 到 objects.githubusercontent.com，逐跳仍过 SSRF 闸门） */
const DOWNLOAD_HOST = 'https://github.com'
const REQUEST_TIMEOUT_MS = 15_000
/**
 * 抓正文的超时单独放宽：release 资产要走 `github.com → objects.githubusercontent.com` 的 302，
 * 实测同一条地址在本机有时 15 秒内拿不下（API 调用从来不需要这么久）。
 * 太紧的后果不是报错，是那条候选每轮都停在 pending 上，谁也不知道为什么。
 */
const DOWNLOAD_TIMEOUT_MS = 45_000
/** 单个脚本正文的上限：实测真音源都在几十到几百 KB，超过这个数基本是打包产物或别的东西 */
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024
/** 打分阈值：只靠"文件名像"不够，必须有脚本自身特征才能进 suspect */
const SUSPECT_THRESHOLD = 5
const GAP_BETWEEN_REPOS_MS = 400
/** 找"最近的一个 zip"时列多少条发布（一次调用，够跨过形态变化） */
const RELEASE_LIST_PER_PAGE = 15
/** 一个 zip 最多展开多少条 .js（你定的 50；真包实测一批 22~23 条，落在里面） */
const MAX_ZIP_MEMBERS = 50
/** 压缩包的上限：整包字节、解压后合计、条目数。超任何一条就拒这个包，不硬撑 */
const ZIP_LIMITS: ZipLimits = {
  maxEntryBytes: MAX_SCRIPT_BYTES,
  maxTotalBytes: 60 * 1024 * 1024,
  maxEntries: 2000,
}
const ZIP_MAX_ASSET_BYTES = 25 * 1024 * 1024

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 仓库名的形状校验：只接受 `owner/repo`，别的（含 URL、含路径穿越）一律拒 */
export function normalizeRepo(input: string): string | null {
  const trimmed = input.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '')
  const match = trimmed.match(/^([\w.-]{1,100})\/([\w.-]{1,100})$/)
  if (!match) return null
  // `..` 单独一段是路径穿越：encodeURIComponent 不编码点，拼进 /repos/{owner}/{repo}/ 后
  // URL 会自己把它折叠掉（实测 ../etc 会变成 /etc/...）。GitHub 的 owner/repo 名里也不允许连续点。
  if (match[1].includes('..') || match[2].includes('..')) return null
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
/** 时间一律归一到 ISO：不同来源的格式不能混存（见 betterKeeper） */
export function toIsoTime(value: unknown): string {
  if (typeof value !== 'string') return ''
  const parsed = Date.parse(value.trim())
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}

/**
 * 同名/同内容择优。
 *
 * 时间一律 `Date.parse` 之后再比，**不能按字符串比**：`upstreamAt` 有两种来源格式
 * ——raw 响应头的 `Last-Modified` 是 `Tue, 08 Sep 2026 11:23:39 GMT`，
 * release 的 `published_at` 是 `2026-09-08T11:23:47Z`。字典序里 `T` 大于 `2`，
 * 混存时 HTTP 日期永远赢，等于把"最新的留下"变成"某种格式的都算最新"。
 */
export function betterKeeper(a: { lastModified: string; scriptVersion: string; score: number; id: number }, b: { lastModified: string; scriptVersion: string; score: number; id: number }): -1 | 1 {
  const timeA = Date.parse(a.lastModified)
  const timeB = Date.parse(b.lastModified)
  const rankA = Number.isFinite(timeA) ? timeA : 0
  const rankB = Number.isFinite(timeB) ? timeB : 0
  if (rankA !== rankB) return rankA > rankB ? -1 : 1
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

async function githubFetch(url: string, token: string, init: Omit<RequestInit, 'redirect'> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // token 只给 api.github.com：raw 与 release 下载都不需要它，而 safePublicFetch 是逐跳带着
  // 同一份 headers 重发的 —— release 地址会 302 到 objects.githubusercontent.com，
  // 不加这道限定就等于把凭据一路递给 CDN 域名。
  const forApi = new URL(url).hostname === 'api.github.com'
  try {
    // 仍然走 safePublicFetch：host 虽然是常量，但 DNS 会重绑，闸门不因为"是我拼的地址"就跳过
    return await safePublicFetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'HollyMusic-source-discovery',
        ...(token && forApi ? { Authorization: `Bearer ${token}` } : {}),
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

export const REPO_SEARCH_SORTS = ['best', 'updated', 'stars'] as const
export type RepoSearchSort = (typeof REPO_SEARCH_SORTS)[number]
const MAX_QUERY_CHARS = 200
const MAX_SEARCH_PAGE_SIZE = 50
/** GitHub 的搜索接口只给看前 1000 条，翻页翻过这个数它是空结果，所以钳在页号上 */
const MAX_SEARCH_RESULT_WINDOW = 1000

export interface RepoSearchItem {
  repo: string
  description: string
  stars: number
  /** 最后一次真推代码的时间（不是我们写库的时间）；清单里的仓就是按这个数判停更的 */
  lastPushAt: string
  language: string
  fork: boolean
  archived: boolean
  alreadyListed: boolean
}

export interface RepoSearchResult {
  total: number
  page: number
  pageSize: number
  sort: RepoSearchSort
  /** GitHub 明说这一页没算完（多为命中量太大）：结果不完整，别当"就这些" */
  incomplete: boolean
  /** 搜索接口自己的配额档，与爬仓库树的 core 额度分开算 */
  quota: RateLimitInfo | null
  items: RepoSearchItem[]
}

/**
 * 搜索词清洗：剔控制字符、钳长度。
 * 这个词只会被拼进 `?q=` 参数（host 是常量），所以这里管的不是 SSRF，是"别把换行/NUL 喂进 URL"。
 */
export function sanitizeRepoQuery(input: unknown): string {
  if (typeof input !== 'string') return ''
  return input.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS)
}

function normalizeSearchSort(input: unknown): RepoSearchSort {
  return REPO_SEARCH_SORTS.includes(input as RepoSearchSort) ? (input as RepoSearchSort) : 'updated'
}

function readQuotaHeaders(response: Response): RateLimitInfo | null {
  const remaining = response.headers.get('x-ratelimit-remaining')
  const limit = response.headers.get('x-ratelimit-limit')
  if (remaining === null || limit === null) return null
  return { remaining: Number(remaining) || 0, limit: Number(limit) || 0, resetAt: Number(response.headers.get('x-ratelimit-reset')) || 0 }
}

/**
 * 把 GitHub 搜索接口的一条仓库记录换成面板要的形状。
 * 单独导出是为了能直测：`private` 的一律不进面板，`full_name` 仍逐个过 `normalizeRepo`
 * —— 清单里只可能是 `owner/repo`，不能因为"是 GitHub 给的"就跳过这道校验。
 */
export function repoSearchItemFromApi(item: Record<string, unknown>, listed: ReadonlySet<string>): RepoSearchItem | null {
  if (item.private === true) return null
  const repo = normalizeRepo(typeof item.full_name === 'string' ? item.full_name : '')
  if (!repo) return null
  return {
    repo,
    description: typeof item.description === 'string' ? item.description.slice(0, 200) : '',
    stars: Number(item.stargazers_count) || 0,
    lastPushAt: typeof item.pushed_at === 'string' ? item.pushed_at : (typeof item.updated_at === 'string' ? item.updated_at : ''),
    language: typeof item.language === 'string' ? item.language : '',
    fork: item.fork === true,
    archived: item.archived === true,
    alreadyListed: listed.has(repo),
  }
}

/**
 * 按关键词搜 GitHub 仓库，给面板勾选入清单用。
 * 这一步**只动搜索**，不改扫描清单，也不下载任何正文：入清单是面板另一次显式保存。
 */
export async function searchGitHubRepos(
  rawQuery: unknown,
  rawPage: unknown = 1,
  rawSort: unknown = 'updated',
  rawPageSize: unknown = 30,
): Promise<RepoSearchResult> {
  const settings = await getDiscoverySettings()
  const query = sanitizeRepoQuery(rawQuery)
  if (!query) throw new SourceDiscoveryError('搜索词是空的（只用空格分关键词即可，例：lxmusic source）')
  if (query.length < 3) throw new SourceDiscoveryError('搜索词太短，至少 3 个字符')

  const pageSize = Math.min(Math.max(Math.trunc(Number(rawPageSize) || 30), 1), MAX_SEARCH_PAGE_SIZE)
  const page = Math.min(Math.max(Math.trunc(Number(rawPage) || 1), 1), Math.max(1, Math.floor(MAX_SEARCH_RESULT_WINDOW / pageSize)))
  const sort = normalizeSearchSort(rawSort)

  const params = new URLSearchParams({ q: query, per_page: String(pageSize), page: String(page) })
  if (sort !== 'best') params.set('sort', sort)
  const response = await githubFetch(`${API_HOST}/search/repositories?${params.toString()}`, settings.githubToken)
  const quota = readQuotaHeaders(response)

  if (!response.ok) {
    const resetSec = quota && quota.resetAt ? Math.max(0, Math.round((quota.resetAt * 1000 - Date.now()) / 1000)) : null
    if (response.status === 403 || response.status === 429) {
      throw new SourceDiscoveryError(
        `GitHub 搜索配额用尽${resetSec != null ? `，约 ${resetSec} 秒后恢复` : ''}`
        + `。这一档和爬仓库树的额度是分开的（带 token 30 次/分、匿名 10 次/分）`,
        429,
      )
    }
    // 422 多半是搜索语法不被接受（例：中文配 in:name）
    throw new SourceDiscoveryError(`GitHub 搜索没接受这个关键词（HTTP ${response.status}）。限定符只认 GitHub 那套写法，中文词别配 in:name`, 502)
  }

  const payload = await response.json() as {
    total_count?: unknown
    incomplete_results?: unknown
    items?: Array<Record<string, unknown>>
  }
  const listed = new Set(settings.repos)
  const seen = new Set<string>()
  const items: RepoSearchItem[] = []
  for (const raw of Array.isArray(payload.items) ? payload.items : []) {
    const view = repoSearchItemFromApi(raw, listed)
    if (!view || seen.has(view.repo)) continue
    seen.add(view.repo)
    items.push(view)
  }

  return {
    total: Number(payload.total_count) || 0,
    page,
    pageSize,
    sort,
    incomplete: payload.incomplete_results === true,
    quota,
    items,
  }
}

/** 体检出来的一个仓：面板按这些字段决定默认勾不勾 */
export interface FreshnessItem {
  repo: string
  lastPushAt: string
  /** 距今多少天；null = GitHub 没给可读的时间（此时不判停更，让人自己看） */
  daysSince: number | null
  stars: number
  archived: boolean
  /** 404/451：仓真没了 */
  missing: boolean
  /** GitHub 跟完重定向后的规范名（改名/转移 owner）；与 repo 相同表示没挪 */
  movedTo: string
  /** 这仓在候选表里还留了多少行 */
  candidates: number
  /** 体检结论：超过阈值、或已归档、或已消失 */
  stale: boolean
}

export interface FreshnessReport {
  checked: number
  maxAgeDays: number
  quota: RateLimitInfo | null
  items: FreshnessItem[]
  /**
   * **查不动的仓**（超时、5xx、DNS 失败）。这些绝不进 `stale`：
   * 一次网络抖动不能被判成"这个仓停更了"，否则体检会把好仓剔掉。
   */
  failed: string[]
}

const FRESHNESS_DEFAULT_DAYS = 365
/** 并发 4：28 个仓约 3 秒出结果，同步回给面板（NAS 上是 I/O 等待，不吃 CPU） */
const FRESHNESS_CONCURRENCY = 4

/**
 * 距今多少天。时间读不出来返回 null，时钟偏前（未来时间）按 0 天算 ——
 * 都不能因此被判成停更。
 */
export function daysSincePush(lastPushAt: unknown, nowMs: number): number | null {
  if (typeof lastPushAt !== 'string' || !lastPushAt) return null
  const pushed = Date.parse(lastPushAt)
  if (!Number.isFinite(pushed)) return null
  if (pushed > nowMs) return 0
  return Math.floor((nowMs - pushed) / 86_400_000)
}

async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor++
      out[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * 停更仓体检：逐个读 GitHub 的 `pushed_at`（我们上次手工剔 11 个仓用的就是这把尺子），
 * 把"该不该从扫描清单里剔掉"的判断材料摆到面板上。
 *
 * 这一步**只读不写**：剔不剔由面板那一次显式保存决定。消失与归档一起进 `stale`，
 * 但查不动的（超时/5xx）只进 `failed` —— 否定式结论要有正证。
 */
export async function auditRepoFreshness(rawMaxAgeDays: unknown = FRESHNESS_DEFAULT_DAYS): Promise<FreshnessReport> {
  const settings = await getDiscoverySettings()
  if (!settings.repos.length) throw new SourceDiscoveryError('扫描仓库清单是空的，没什么可体检的')
  const maxAgeDays = clampInt(rawMaxAgeDays, FRESHNESS_DEFAULT_DAYS, 30, 3650)

  const quota = await readRateLimit(settings.githubToken)
  if (quota && quota.remaining < settings.repos.length) {
    throw new SourceDiscoveryError(
      `GitHub API 余量 ${quota.remaining}，体检 ${settings.repos.length} 个仓需要这么多次调用。`
      + `配一个只读 token 或等额度恢复再来（体检不吃搜索那档额度）`,
      429,
    )
  }

  const counts = new Map<string, number>()
  for (const row of await prisma.sourceCandidate.groupBy({ by: ['repo'], _count: { id: true } })) {
    counts.set(row.repo, row._count.id)
  }

  const nowMs = Date.now()
  const failed: string[] = []
  const items = (await mapWithLimit(settings.repos, FRESHNESS_CONCURRENCY, async (repo): Promise<FreshnessItem | null> => {
    const base = {
      repo, lastPushAt: '', daysSince: null as number | null, stars: 0, archived: false,
      missing: false, movedTo: '', candidates: counts.get(repo) ?? 0, stale: false,
    }
    let response: Response
    try {
      response = await githubFetch(buildRepoUrl(repo), settings.githubToken)
    } catch (err) {
      failed.push(`${repo}：${err instanceof Error ? err.message : String(err)}`.slice(0, 120))
      return null
    }
    if (response.status === 404 || response.status === 451) {
      return { ...base, missing: true, stale: true }
    }
    if (!response.ok) {
      failed.push(`${repo}：HTTP ${response.status}`)
      return null
    }
    const payload = await response.json() as Record<string, unknown>
    const lastPushAt = typeof payload.pushed_at === 'string' ? payload.pushed_at : ''
    const daysSince = daysSincePush(lastPushAt, nowMs)
    const archived = payload.archived === true
    // 跟完重定向后 GitHub 回的是规范名，与请求的那个不一致就是改名/转移了 owner。
    // 比大小写不敏感的版本：清单里的手写名字与 GitHub 规范名常常只差大小写，那不算搬家。
    const canonical = normalizeRepo(typeof payload.full_name === 'string' ? payload.full_name : '')
    const movedTo = canonical && canonical.toLowerCase() !== repo.toLowerCase() ? canonical : ''
    return {
      repo, lastPushAt, daysSince,
      stars: Number(payload.stargazers_count) || 0,
      archived, missing: false, movedTo,
      candidates: counts.get(repo) ?? counts.get(canonical || '') ?? 0,
      stale: archived || (daysSince != null && daysSince > maxAgeDays),
    }
  })).filter((item): item is FreshnessItem => item !== null)

  return { checked: settings.repos.length, maxAgeDays, quota, items, failed }
}

export interface CrawlSummary {
  reposScanned: number
  reposSkipped: string[]
  truncatedRepos: string[]
  /** 本轮走"最新 release 资产"采集的仓（面板要说，否则管理员只看到候选数突然塌下去） */
  releaseRepos: string[]
  /** 查了 release 但回落到 tree 的仓与原因（404=从没发过、5xx=没查到、资产不是 .js） */
  releaseFallbacks: string[]
  /** zip 包的处置说明：为什么没收、跳过了哪些条目、每包上限没登记多少条 */
  zipNotes: string[]
  /** 因为改走 release 采集而被标成"已被顶掉"的 tree 历史行数量 */
  releaseSuperseded: number
  seen: number
  created: number
  refreshed: number
  downloaded: number
  suspect: number
  notSource: number
  stale: number
  quota: RateLimitInfo | null
  note: string | null
  /** 这一轮是被手动停止中断的（连轮据此决定是否继续） */
  stopped: boolean
}

/** 一次连轮（清存量）的总账 */
export interface DrainSummary {
  /** 实际跑了几轮 */
  rounds: number
  downloaded: number
  suspect: number
  notSource: number
  stale: number
  /** 结束时还剩多少条没抓正文 —— 0 就是真清完了 */
  pendingLeft: number
  stopped: boolean
  /** 为什么停：清完 / 被停止 / 整轮没进展 / 配额不够 / 保险丝 */
  note: string | null
}

/** 一批判级的进度（面板据此显示"判级中 12/50"并允许停止） */
interface ProbeBatchProgress {
  total: number
  done: number
  /** 至少一个平台真出货的条数 */
  withAddress: number
  /** 下载不到 / sha 对不上 / 脚本报错而跳过的条数 */
  failed: number
  stopped: boolean
  note: string | null
  running: boolean
  /** 单次上限（面板写"最多 N 条"用，别在 UI 里另抄一份数字） */
  limit: number
}

interface ProgressState {
  running: boolean
  phase: string
  reposDone: number
  reposTotal: number
  downloaded: number
  /** 正在判级的候选 id；null = 没有。判级要执行脚本，一次只允许一个 */
  probingId: number | null
  lastProbeNote: string | null
  startedAt: string | null
  last: CrawlSummary | null
  lastError: string | null
  probeBatch: ProbeBatchProgress | null
  /** 连轮（清存量）里的第几轮；单轮恒为 1 */
  round: number
  /** true = 连轮在跑。面板要靠它决定继续轮询还是收掉，也用来显示"停止" */
  draining: boolean
  /** 按过停止：单轮在下一个仓之间生效，连轮在下一轮之前生效 */
  stopRequested: boolean
  /** 上一次连轮的汇总（中断/清完/没进展都会留一句原因） */
  drainLast: DrainSummary | null
}

let runningTask: Promise<CrawlSummary> | null = null
let drainTask: Promise<DrainSummary> | null = null

const progress: ProgressState = {
  running: false,
  phase: 'idle',
  reposDone: 0,
  reposTotal: 0,
  downloaded: 0,
  probingId: null,
  lastProbeNote: null,
  startedAt: null,
  last: null,
  lastError: null,
  round: 1,
  draining: false,
  stopRequested: false,
  drainLast: null,
  probeBatch: null,
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
    // 上限 2000 是给"清一次几千条存量"留的口子；默认仍是 80（NAS 上一轮别吃掉十几分钟）
    maxDownloadsPerRound: clampInt(patch.maxDownloadsPerRound, current.maxDownloadsPerRound, 0, 2000),
    // 空串视为"不改动"，清空要走显式的 clearToken，避免面板回显时把 token 抹掉
    githubToken: typeof patch.githubToken === 'string' && patch.githubToken.trim() ? patch.githubToken.trim() : current.githubToken,
    preferLatestRelease: typeof patch.preferLatestRelease === 'boolean' ? patch.preferLatestRelease : current.preferLatestRelease,
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

function buildRepoUrl(repo: string): string {
  const [owner, name] = repo.split('/')
  return `${API_HOST}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

function buildRawUrl(repo: string, path: string): string {
  const [owner, name] = repo.split('/')
  const encoded = path.split('/').map(segment => encodeURIComponent(segment)).join('/')
  return `${RAW_HOST}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/HEAD/${encoded}`
}

/**
 * 起一轮发现。`fromDrain` 只给连轮内部用：那时连轮自己已经占住单飞位（drainTask），
 * 不加这个参数的话，每一轮都会被"已有连轮在跑"拒掉。
 * `onlyRepos` 是"只扫勾选那几个仓"：它**只能把扫描范围往小里缩**，
 * 清单里没有的仓传进来会被丢掉（所以这个参数不是第二个自由文本入口）。
 */
export function runDiscoveryCrawl(opts: { fromDrain?: boolean; onlyRepos?: unknown } = {}): Promise<CrawlSummary> {
  if (!opts.fromDrain && drainTask) throw new SourceDiscoveryError('有一轮连轮正在跑，先按停止或等它结束', 409)
  if (runningTask) return runningTask
  // 单轮起手要清掉上一次"停止"的痕迹，否则它会立刻把自己停掉
  if (!progress.draining) progress.stopRequested = false
  const requested = Array.isArray(opts.onlyRepos) ? opts.onlyRepos : null
  const only = (requested ?? [])
    .map(item => normalizeRepo(typeof item === 'string' ? item : ''))
    .filter((item): item is string => Boolean(item))
  // 给了子集却一个都不合法 ⇒ 报错，不能退化成"那就扫全清单"（缩小范围失败只会放大范围是反的）
  if (requested?.length && !only.length) {
    throw new SourceDiscoveryError(`勾选的仓库写法都不合法（要 owner/repo）：${String(requested[0]).slice(0, 40)}`)
  }
  runningTask = doCrawl(only).finally(() => { runningTask = null })
  return runningTask
}

/**
 * 连轮清存量：一轮把「每轮抓正文上限」吃满就自动接着下一轮，直到
 * 待判定清零 / 被手动停止 / 一整轮没能减少任何一条 / 撞上保险丝轮数。
 *
 * 为什么要有"没进展就停"这一条：下载失败会**保留 pending**（临时故障不该固化成结论），
 * 所以没有这条判据，一个一直失败的地址能让它永远转下去。
 */
export function runDiscoveryDrain(): Promise<DrainSummary> {
  if (drainTask) return drainTask
  if (runningTask) throw new SourceDiscoveryError('已有一轮发现正在跑', 409)
  drainTask = doDrain().finally(() => { drainTask = null })
  return drainTask
}

/** 请求停止：正在抓的那一条抓完就收（仓内逐条检查），连轮则不再起下一轮 */
export function requestDiscoveryStop(): { stopping: boolean } {
  if (!(progress.running || progress.draining || progress.probeBatch?.running)) return { stopping: false }
  progress.stopRequested = true
  return { stopping: true }
}

async function countPending(): Promise<number> {
  return prisma.sourceCandidate.count({ where: { verdict: 'pending' } })
}

const MAX_DRAIN_ROUNDS = 40

async function doDrain(): Promise<DrainSummary> {
  const totals: DrainSummary = {
    rounds: 0, downloaded: 0, suspect: 0, notSource: 0, stale: 0, pendingLeft: 0, stopped: false, note: null,
  }
  progress.draining = true
  progress.stopRequested = false
  try {
    while (totals.rounds < MAX_DRAIN_ROUNDS) {
      // 第一轮无条件跑：全新库里 pending 还是 0，先查就等于什么都不做
      const before = totals.rounds === 0 ? null : await countPending()
      if (before === 0) {
        totals.pendingLeft = 0
        totals.note = '待判定已清零'
        break
      }
      totals.rounds++
      progress.round = totals.rounds
      let summary: CrawlSummary
      try {
        summary = await runDiscoveryCrawl({ fromDrain: true })
      } catch (err) {
        // 配额见底这类中断不该让连轮在后台 reject 掉，把原因留在总账里正常结束
        totals.note = `第 ${totals.rounds} 轮起不来：${err instanceof Error ? err.message : String(err)}`
        break
      }
      totals.downloaded += summary.downloaded
      totals.suspect += summary.suspect
      totals.notSource += summary.notSource
      totals.stale += summary.stale
      totals.pendingLeft = await countPending()
      if (summary.stopped) {
        totals.stopped = true
        totals.note = '被手动停止'
        break
      }
      if (before !== null && totals.pendingLeft >= before) {
        totals.note = `第 ${totals.rounds} 轮没能减少待判定（仍 ${totals.pendingLeft} 条），连轮停在这里 —— 看下这轮跳过的仓与配额`
        break
      }
    }
    if (!totals.note && totals.rounds >= MAX_DRAIN_ROUNDS) totals.note = `已到 ${MAX_DRAIN_ROUNDS} 轮保险丝`
    logger.info('[discovery] 连轮结束', {
      轮数: totals.rounds, 抓正文: totals.downloaded, 疑似: totals.suspect, 剩余待判定: totals.pendingLeft, 原因: totals.note,
    })
    return totals
  } finally {
    progress.drainLast = totals
    progress.draining = false
    progress.round = 1
    progress.stopRequested = false
  }
}

async function doCrawl(onlyRepos: string[] = []): Promise<CrawlSummary> {
  const settings = await getDiscoverySettings()
  // 这几条起轮前的检查都在 try 之外，抛出去就是一次"202 然后静默"：
  // 路由那边是 void + catch 打日志，面板只能读 progress.lastError，所以每个原因都得先落进去
  if (!settings.enabled) {
    progress.lastError = '音源发现未启用，先在面板上打开开关'
    throw new SourceDiscoveryError(progress.lastError)
  }
  if (!settings.repos.length) {
    progress.lastError = '仓库清单是空的，没有可扫描的目标'
    throw new SourceDiscoveryError(progress.lastError)
  }
  // 交集在这里算：勾选的仓必须已经在清单里，否则这个参数就成了绕过清单的入口
  const targets = onlyRepos.length ? settings.repos.filter(repo => onlyRepos.includes(repo)) : settings.repos
  if (!targets.length) {
    progress.lastError = `勾选的 ${onlyRepos.length} 个仓都还没进扫描清单，先保存清单再扫`
    throw new SourceDiscoveryError(progress.lastError)
  }

  const summary: CrawlSummary = {
    reposScanned: 0, reposSkipped: [], truncatedRepos: [], releaseRepos: [], releaseFallbacks: [], zipNotes: [], releaseSuperseded: 0,
    seen: 0, created: 0, refreshed: 0,
    downloaded: 0, suspect: 0, notSource: 0, stale: 0, quota: null, note: null, stopped: false,
  }
  progress.running = true
  progress.phase = '配额预检'
  progress.reposTotal = targets.length
  progress.reposDone = 0
  progress.downloaded = 0
  progress.startedAt = new Date().toISOString()
  progress.lastError = null

  try {
    // 一轮里 API 调用数 ≈ 仓库数 ×（走 release 时最多 2 次：发布 + 回落时的树）+ 正文数
    // （raw 与 release 下载不吃 API 配额，但占时间）
    summary.quota = await readRateLimit(settings.githubToken)
    const callsNeeded = targets.length * (settings.preferLatestRelease ? 2 : 1)
    if (summary.quota && summary.quota.remaining < callsNeeded) {
      throw new SourceDiscoveryError(
        `GitHub API 余量 ${summary.quota.remaining}，本轮最多需要 ${callsNeeded} 次仓库接口调用。`
        + `配一个只读 token 或删掉些仓库再来（token 只需提升限额，不要求任何 scope）`,
        429,
      )
    }

    let downloadBudget = settings.maxDownloadsPerRound
    for (const repo of targets) {
      // 停止在仓与仓之间也生效（仓内是逐条检查）：中断点之后剩下的仓这轮不扫，下轮再说
      if (progress.stopRequested) {
        summary.stopped = true
        summary.reposSkipped.push(`（已停止，剩下 ${targets.length - progress.reposDone} 个仓没扫）`)
        break
      }
      progress.phase = `扫描 ${repo}`
      try {
        const counted = await crawlRepo(repo, settings, summary, downloadBudget)
        downloadBudget -= counted
      } catch (err) {
        // 折成一行：Prisma 的报错自带换行与缩进，原样进"跳过"清单会把面板那行撑成一段代码块
        const reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim()
        summary.reposSkipped.push(`${repo}：${reason.slice(0, 80)}`)
        logger.info('[discovery] 仓库跳过', { repo, reason: reason.slice(0, 200) })
      }
      progress.reposDone++
      await sleep(GAP_BETWEEN_REPOS_MS)
    }

    progress.phase = '去重择优'
    summary.stale = await dedupeCandidates()

    const notes: string[] = []
    if (summary.stopped) notes.push('已按停止中断（这一轮扫过的仓已入库，去重照常做完）')
    else if (downloadBudget <= 0) notes.push(`本轮下载额度（${settings.maxDownloadsPerRound}）用尽，剩下的候选留在 pending，下轮继续`)
    if (targets.length < settings.repos.length) notes.push(`只扫了勾选的 ${targets.length}/${settings.repos.length} 个仓`)
    summary.note = notes.join('；') || null
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

/**
 * 一个仓本轮要登记的候选。tree 里的文件与 release 里的资产从这一步起走同一条路：
 * 同样的登记、同样的下载额度、同样的打分。
 */
interface CandidateEntry {
  /** tree 里是仓库内路径；release 里是资产文件名；zip 条目是 `包名!包内路径`（三者与 repo 组成唯一键） */
  path: string
  rawUrl: string
  size: number
  blobSha: string
  /** release 资产的 `sha256:…`；tree 采集时为空。zip 条目记的是**整包**的 sha256 */
  assetDigest: string
  releaseTag: string
  /** 非空 = 正文在 `rawUrl` 那个 zip 里，条目名是这个 */
  zipMember: string
  /** 本轮已经从整包里取出的正文（zip 条目专用：整包只下一次次性的，不再按条目重下） */
  content?: string
  /** release 的 published_at —— tree 那边拿不到（raw 的 HEAD 路径不回 Last-Modified） */
  upstreamAt: string
}

/**
 * 发布列表接口，一次调用同时拿到"最新一次的散 .js"和"从新往旧数的第一个 zip"。
 * 不用 `/releases/latest` 是因为它对"没发过"回 404、而列表回 200 空数组，
 * 且它看不到更早的 zip。
 */
function buildReleasesUrl(repo: string): string {
  const [owner, name] = repo.split('/')
  return `${API_HOST}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases?per_page=${RELEASE_LIST_PER_PAGE}`
}

/**
 * 资产的下载地址由我们自己拼，不取 API 给的 `browser_download_url`：
 * 形状仍是 owner/repo + 逐段编码，"仓库名是唯一自由文本入口"这条口径才不被绕过。
 */
function buildReleaseAssetUrl(repo: string, tag: string, name: string): string {
  const [owner, repoName] = repo.split('/')
  return `${DOWNLOAD_HOST}/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
}

function entriesFromTree(repo: string, tree: TreeEntry[], maxCandidates: number): CandidateEntry[] {
  const out: CandidateEntry[] = []
  for (const entry of tree) {
    if (out.length >= maxCandidates) break
    if (entry.type !== 'blob' || typeof entry.path !== 'string') continue
    if (!isPlausibleScriptPath(entry.path)) continue
    out.push({
      path: entry.path, rawUrl: buildRawUrl(repo, entry.path),
      size: Number(entry.size) || 0, blobSha: typeof entry.sha === 'string' ? entry.sha : '',
      assetDigest: '', releaseTag: '', zipMember: '', upstreamAt: '',
    })
  }
  return out
}

/**
 * GitHub 的资产 digest 形如 `sha256:<hex>`（实测两处都带这个前缀）。
 * 取不出 64 位 hex 就当**没有锚点** —— 宁可不校验，也不能拿一个解析错的串当"内容不一致"拒掉好源。
 */
export function assetDigestHex(digest: unknown): string {
  if (typeof digest !== 'string') return ''
  const match = digest.trim().toLowerCase().match(/^(?:sha256[:=])?([0-9a-f]{64})$/)
  return match ? match[1] : ''
}

/**
 * 校验"下到的字节就是我们记录的那一份"。两种锚点按强弱排：
 * - release 资产的 `digest`（GitHub 给的是文件字节的 sha256）；
 * - tree 的 blob sha（`git hash-object` 那套 `blob <len>\0` 算法）。
 * 返回 null = 这条记录本来没有可对锚点（**无从校验**），不等于"校验通过"。
 *
 * 只用于**整文件**候选。zip 包内条目的锚点是整包的 sha256，对不上条目正文，
 * 所以那条路在 `fetchCandidateContent` 里"复验整包 → 再取条目"，不走这里。
 *
 * content 是已按 UTF-8 解码的文本：.js 是文本，重新编码回字节等价，所以可比。
 */
export function verifyContentAnchor(content: string, blobSha: string, assetDigest: string): boolean | null {
  const digestHex = assetDigestHex(assetDigest)
  if (digestHex) return createHash('sha256').update(content, 'utf8').digest('hex') === digestHex
  const sha = (blobSha || '').trim().toLowerCase()
  if (sha) return gitBlobSha(content) === sha
  return null
}

export interface ReleaseAssetLike { name?: unknown; size?: unknown; digest?: unknown }
export interface ReleaseLike { tag_name?: unknown; published_at?: unknown; prerelease?: unknown; assets?: unknown }

function assetsOf(release: ReleaseLike): ReleaseAssetLike[] {
  return Array.isArray(release.assets) ? release.assets as ReleaseAssetLike[] : []
}
function tagOf(release: ReleaseLike): string {
  return typeof release.tag_name === 'string' ? release.tag_name : ''
}
function publishedOf(release: ReleaseLike): string {
  return typeof release.published_at === 'string' ? release.published_at : ''
}

export interface ReleasePicked {
  /** 最新一次发布里的散 .js 资产 */
  loose: Array<{ tag: string; publishedAt: string; asset: ReleaseAssetLike }>
  /** 从新往旧数到的第一个 zip 资产（可能在更早的发布里） */
  zip: { tag: string; publishedAt: string; asset: ReleaseAssetLike } | null
}

/**
 * 采集形状的纯函数：**最新一次发布的散 .js ＋ 这个仓最近的一个 zip**。
 * 分开出来是为了能直测"包在更早的发布里"这一档 —— 真数据就是这个形状：
 * `Macrohard0001/lx-ikun-music-sources` 最新两次（8-31、9-08）各发 1 个散 js，
 * 而装一大堆源的 zip 在 8-17 那次；只看最新一次就正好把最肥的部分切掉。
 *
 * pre-release 算数（这类仓常把汇总包发成 pre-release），排序自己按 `published_at` 兜一层，
 * 不依赖接口的返回顺序。
 */
export function pickReleaseAssets(releases: ReleaseLike[]): ReleasePicked {
  const sorted = [...releases].sort((a, b) => {
    const at = Date.parse(publishedOf(a))
    const bt = Date.parse(publishedOf(b))
    return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0)
  })
  const loose: ReleasePicked['loose'] = []
  const newest = sorted[0]
  if (newest && tagOf(newest)) {
    for (const asset of assetsOf(newest)) {
      if (typeof asset.name === 'string' && isPlausibleScriptPath(asset.name)) {
        loose.push({ tag: tagOf(newest), publishedAt: publishedOf(newest), asset })
      }
    }
  }
  let zip: ReleasePicked['zip'] = null
  for (const release of sorted) {
    const tag = tagOf(release)
    if (!tag) continue
    const found = assetsOf(release).find(asset => typeof asset.name === 'string' && /\.zip$/i.test(asset.name))
    if (found) { zip = { tag, publishedAt: publishedOf(release), asset: found }; break }
  }
  return { loose, zip }
}

/**
 * 按上限流式下载一个包/文件。声明的 Content-Length 只是一道预筛，
 * 真正的边界是逐块累加 —— 撒谎的服务端不能把内存撑爆。
 */
async function downloadBoundedBytes(url: string, token: string, maxBytes: number): Promise<Buffer> {
  const response = await githubFetch(url, token, { headers: { Accept: 'application/octet-stream' } }, DOWNLOAD_TIMEOUT_MS)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`声明大小 ${Math.round(declared / 1024 / 1024)}MB 超过上限`)
  if (!response.body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > maxBytes) throw new Error(`下载体超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限，中止`)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, total)
}

function zipNote(summary: CrawlSummary, text: string): void {
  summary.zipNotes.push(text)
}

/**
 * 库里已经有"同一个 tag + 同一个整包 sha256"的条目登记 ⇒ 直接复用它们的定位信息，不重下整包。
 * 返回的条目没有 `content`，但锚点与库里一致，`registerEntries` 会在复验相同后跳过取正文。
 */
async function findUnchangedZipMembers(repo: string, tag: string, digest: string): Promise<CandidateEntry[]> {
  const rows = await prisma.sourceCandidate.findMany({
    where: { repo, releaseTag: tag, assetDigest: digest, state: 'new' },
    select: { path: true, rawUrl: true, sizeBytes: true, assetDigest: true, releaseTag: true, zipMember: true, upstreamAt: true, verdict: true },
  })
  // 一行都还没判过（全是 pending）时不省事：那时本来就要下包取正文
  return rows.filter(row => row.zipMember && row.verdict !== 'pending').map(row => ({
    path: row.path,
    rawUrl: row.rawUrl,
    size: row.sizeBytes,
    blobSha: '',
    assetDigest: row.assetDigest,
    releaseTag: row.releaseTag,
    zipMember: row.zipMember,
    upstreamAt: row.upstreamAt,
  }))
}

/**
 * 展开一个 zip 资产：下整包 → 复验整包 sha256 → 取出 .js 条目（正文顺手带在内存里，
 * 一轮里 50 个条目不会重下 50 次同一个包）。
 *
 * 任何一步不成都判整仓失败：记一句为什么没收这个包，散 js 照收，tree 该回落还回落。
 */
async function collectZipMembers(repo: string, picked: ReleasePicked['zip'], settings: DiscoverySettings, summary: CrawlSummary): Promise<CandidateEntry[]> {
  if (!picked) return []
  const assetName = typeof picked.asset.name === 'string' ? picked.asset.name : ''
  const assetUrl = buildReleaseAssetUrl(repo, picked.tag, assetName)
  const digest = assetDigestHex(picked.asset.digest)
  const size = Number(picked.asset.size) || 0

  if (!assetName) return []
  if (size > ZIP_MAX_ASSET_BYTES) {
    zipNote(summary, `${repo}：包 ${assetName} ${(size / 1024 / 1024).toFixed(1)}MB 超过 ${Math.round(ZIP_MAX_ASSET_BYTES / 1024 / 1024)}MB 上限，没收这个包`)
    return []
  }

  // 包没换就不重下：这一档不是省流量好看，是少一个失败面 —— 实测本机到 github.com 的下载时好时坏，
  // 重下一次就多一次"这轮没收到这个包"的机会。
  const cached = digest ? await findUnchangedZipMembers(repo, picked.tag, `sha256:${digest}`) : []
  if (cached.length) {
    zipNote(summary, `${repo}：包 ${assetName} 的 sha256 与库里一致，跳过下载，复用 ${cached.length} 条登记`)
    return cached
  }

  let buffer: Buffer
  try {
    buffer = await downloadBoundedBytes(assetUrl, settings.githubToken, ZIP_MAX_ASSET_BYTES)
  } catch (err) {
    zipNote(summary, `${repo}：包 ${assetName} 下载失败（${(err instanceof Error ? err.message : String(err)).slice(0, 60)}）`)
    return []
  }
  // 先复验整包再解：解包器读到的必须就是发布记录里那个字节
  if (digest && createHash('sha256').update(buffer).digest('hex') !== digest) {
    zipNote(summary, `${repo}：包 ${assetName} 的 sha256 与发布记录不一致，没收`)
    return []
  }

  let listing
  try {
    listing = listZipEntries(buffer, ZIP_LIMITS)
  } catch (err) {
    zipNote(summary, `${repo}：包 ${assetName} 读不了（${(err instanceof Error ? err.message : String(err)).slice(0, 70)}）`)
    return []
  }
  if (listing.rejected.length) {
    zipNote(summary, `${repo}：包 ${assetName} 跳过的条目：${listing.rejected.map(item => `${item.reason}×${item.count}`).join('，')}`)
  }
  const js = listing.entries.filter(entry => isPlausibleScriptPath(entry.name))
  const taken = js.slice(0, MAX_ZIP_MEMBERS)
  if (js.length > taken.length) {
    zipNote(summary, `${repo}：包 ${assetName} 里还有 ${js.length - taken.length} 个 .js 没登记（每包上限 ${MAX_ZIP_MEMBERS}）`)
  }

  const out: CandidateEntry[] = []
  for (const member of taken) {
    let bytes: Buffer
    try {
      bytes = extractZipEntry(buffer, member, ZIP_LIMITS.maxEntryBytes)
    } catch (err) {
      zipNote(summary, `${repo}：包 ${assetName} 里的 ${member.name} 取不出（${(err instanceof Error ? err.message : String(err)).slice(0, 60)}）`)
      continue
    }
    out.push({
      path: `${assetName}!${member.name}`,
      rawUrl: assetUrl,
      size: member.uncompressedSize,
      blobSha: '',
      // 锚点是整包的 sha256：判级/导入要"复验整包 → 再取这个条目"，不能拿包摘要去比对条目正文
      assetDigest: digest ? `sha256:${digest}` : '',
      releaseTag: picked.tag,
      zipMember: member.name,
      content: bytes.toString('utf8'),
      upstreamAt: picked.publishedAt,
    })
  }
  return out
}

/**
 * release 采集：**最新一次发布的散 .js ＋ 这个仓最近的一个 zip 里的 .js**。
 * 动因是实测：`Macrohard0001/lx-ikun-music-sources` 的 tree 里堆着 969 个历史版本 .js
 * （一家占候选表 39% 的行），而它 8 月中旬改成了"一个汇总 zip"、8 月底又改成"一个散 js"。
 *
 * 回落 tree 的情况要分清，**每一种都在结论里说清**：
 * - 从没发过 release（`/releases` 回 200 空数组，或 `/releases/latest` 那种 404）⇒ 静默回落；
 * - 有发布但既没有散 js、zip 里也没收进东西 ⇒ 回落并说明；
 * - 超时 / 5xx / 响应不是 JSON ⇒ 只是**这次没查到**，回落并写一句，别让它读起来像"这仓没发布"。
 */
/** 一条候选怎么找到自己的正文：整文件，还是先下整包再取那一个条目 */
export interface CandidateLocator {
  rawUrl: string
  blobSha: string
  assetDigest: string
  zipMember: string
}

export interface CandidateContent {
  content: string
  /** true=复验过了；false=对不上或取不出；null=没有可对的锚点（无从校验，不等于通过） */
  anchor: boolean | null
  reason: string | null
}

/**
 * 按候选行取正文，并把"内容复验"这件事一次说清。
 *
 * zip 条目那条路是 **先复验整包的 sha256，再取那一个条目** —— 条目的摘要不在我们的记录里，
 * 整包摘要才是同源锚点；整包对不上就一票否决，解出来的东西不配进沙箱、更不配进配置。
 */
export async function fetchCandidateContent(locator: CandidateLocator, token: string): Promise<CandidateContent> {
  if (!locator.zipMember) {
    const content = await fetchScriptText(locator.rawUrl, token)
    const anchor = verifyContentAnchor(content, locator.blobSha, locator.assetDigest)
    // 对不上时说的是"哪一种锚点"，管理员才知道是"上游刚改过 tree"还是"发布被重发过"
    const reason = anchor === false
      ? (assetDigestHex(locator.assetDigest) ? '内容与发布资产记录的 sha256 不一致' : 'blob sha 与仓库 tree 不一致')
      : null
    return { content, anchor, reason }
  }

  const digest = assetDigestHex(locator.assetDigest)
  let buffer: Buffer
  try {
    buffer = await downloadBoundedBytes(locator.rawUrl, token, ZIP_MAX_ASSET_BYTES)
  } catch (err) {
    return { content: '', anchor: false, reason: `下载整包失败：${(err instanceof Error ? err.message : String(err)).slice(0, 80)}` }
  }
  if (digest && createHash('sha256').update(buffer).digest('hex') !== digest) {
    return { content: '', anchor: false, reason: '整包的 sha256 与发布记录不一致' }
  }
  let listing
  try {
    listing = listZipEntries(buffer, ZIP_LIMITS)
  } catch (err) {
    return { content: '', anchor: false, reason: `包读不了：${(err instanceof Error ? err.message : String(err)).slice(0, 80)}` }
  }
  const member = listing.entries.find(entry => entry.name === locator.zipMember)
  if (!member) return { content: '', anchor: false, reason: '包里没有记录的那个条目（上游可能已重发包）' }
  try {
    const bytes = extractZipEntry(buffer, member, ZIP_LIMITS.maxEntryBytes)
    return { content: bytes.toString('utf8'), anchor: digest ? true : null, reason: null }
  } catch (err) {
    return { content: '', anchor: false, reason: `条目取不出：${(err instanceof Error ? err.message : String(err)).slice(0, 80)}` }
  }
}

async function collectReleaseEntries(repo: string, settings: DiscoverySettings, summary: CrawlSummary): Promise<CandidateEntry[] | null> {
  const fallback = (reason: string) => {
    summary.releaseFallbacks.push(`${repo}：${reason}，本轮按 tree 扫`)
    return null
  }

  let releases: ReleaseLike[]
  try {
    const response = await githubFetch(buildReleasesUrl(repo), settings.githubToken)
    if (response.status === 404) return null
    if (!response.ok) return fallback(`release 返回 HTTP ${response.status}`)
    const payload = await response.json() as unknown
    releases = Array.isArray(payload) ? payload as ReleaseLike[] : []
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 60)
    return fallback(`release 没查到（${reason}）`)
  }
  // 这个接口对"从没发过"回的是 200 + 空数组（不是 404），所以这里也要当"没有"
  if (!releases.length) return null

  const picked = pickReleaseAssets(releases)
  const loose = picked.loose.slice(0, settings.maxCandidatesPerRepo).map(item => ({
    path: String(item.asset.name),
    rawUrl: buildReleaseAssetUrl(repo, item.tag, String(item.asset.name)),
    size: Number(item.asset.size) || 0,
    blobSha: '',
    assetDigest: typeof item.asset.digest === 'string' ? item.asset.digest : '',
    releaseTag: item.tag,
    zipMember: '',
    upstreamAt: item.publishedAt,
  }))
  const fromZip = await collectZipMembers(repo, picked.zip, settings, summary)
  const entries = [...loose, ...fromZip]
  if (!entries.length) {
    const names = assetsOf(releases[0] ?? {}).slice(0, 3).map(asset => String(asset.name ?? '')).filter(Boolean).join('、')
    // 回落原因不能张冠李戴：有包但没收进来（下不动/对不上/读不了）时，原因是那一条，
    // 不是"这仓没有 .js 资产" —— 实测本机网络到 github.com 不通时就会走到这里
    const why = picked.zip
      ? `，而最近的包 ${String(picked.zip.asset.name ?? '')} 没收进来（原因见「压缩包」那行）`
      : '，也没找到 zip'
    return fallback(`最新 release${tagOf(releases[0] ?? {}) ? ` ${tagOf(releases[0] ?? {})}` : ''} 里没有 .js 资产${names ? `（是 ${names}）` : ''}${why}`)
  }

  const zipTag = picked.zip && fromZip.length ? `＋包 ${String(picked.zip.asset.name ?? '')} 展开 ${fromZip.length} 条` : ''
  summary.releaseRepos.push(`${repo}（散 js ${loose.length} 条${zipTag}）`)
  return entries
}

/** 改走 release 采集后，tree 里那些不再刷新的历史行标成"已被顶掉"（标行不删行，与去重同一口径） */
async function supersedeOtherPaths(repo: string, keep: Set<string>, summary: CrawlSummary): Promise<void> {
  const rows = await prisma.sourceCandidate.findMany({
    where: { repo, state: 'new' },
    select: { id: true, path: true, verdict: true },
  })
  for (const row of rows) {
    if (keep.has(row.path)) continue
    await prisma.sourceCandidate.update({
      where: { id: row.id },
      data: { state: 'stale', reason: '这个仓改走"最新 release 的资产"采集，tree 里的历史文件不再刷新' },
    })
    summary.releaseSuperseded++
  }
}

async function crawlRepo(
  repo: string,
  settings: DiscoverySettings,
  summary: CrawlSummary,
  downloadBudget: number,
): Promise<number> {
  let entries: CandidateEntry[] | null = null
  let fromRelease = false
  if (settings.preferLatestRelease) {
    entries = await collectReleaseEntries(repo, settings, summary)
    fromRelease = entries !== null
  }
  if (!entries) entries = await collectTree(repo, settings, summary)
  if (fromRelease) await supersedeOtherPaths(repo, new Set(entries.map(entry => entry.path)), summary)
  return registerEntries(repo, entries, settings, summary, downloadBudget)
}

async function collectTree(repo: string, settings: DiscoverySettings, summary: CrawlSummary): Promise<CandidateEntry[]> {
  const response = await githubFetch(buildTreeUrl(repo), settings.githubToken)
  if (response.status === 404) throw new SourceDiscoveryError('仓库不存在或不可访问', 404)
  if (!response.ok) throw new SourceDiscoveryError(`GitHub 返回 HTTP ${response.status}`, response.status === 403 ? 403 : 502)
  const payload = await response.json() as { tree?: unknown; truncated?: unknown }
  const tree = Array.isArray(payload.tree) ? payload.tree as TreeEntry[] : []
  if (payload.truncated === true) {
    summary.truncatedRepos.push(repo)
    logger.info('[discovery] 仓库树被截断，本仓结果不完整', { repo, 条目: tree.length })
  }
  return entriesFromTree(repo, tree, settings.maxCandidatesPerRepo)
}

async function registerEntries(
  repo: string,
  entries: CandidateEntry[],
  settings: DiscoverySettings,
  summary: CrawlSummary,
  downloadBudget: number,
): Promise<number> {
  let used = 0
  for (const entry of entries) {
    // 逐条之间也看停止：一个大仓能一口气吃满整轮额度，只仓间检查的话"停止"要等十几分钟才生效
    if (progress.stopRequested) {
      summary.stopped = true
      break
    }
    // 内容锚点：tree 用 blob sha，release 用资产 digest。两个都没有（GitHub 偶尔不给 size/sha）
    // 就每轮重下 —— 拿"两边都是空串"当"内容没变"会把更新固化掉。
    const incomingId = entry.blobSha || entry.assetDigest
    const existing = await prisma.sourceCandidate.findUnique({
      where: { repo_path: { repo, path: entry.path } },
      select: { id: true, blobSha: true, assetDigest: true, verdict: true },
    })
    if (existing) {
      // 先把旧锚点取出来再写行：update 之后同一个对象的字段已经是新值，
      // 拿它跟新值比就永远"内容没变"，更新会被自己盖掉（真 Prisma 回的是快照，假库回的是引用——两边都要成立）
      const existingId = existing.blobSha || existing.assetDigest
      await prisma.sourceCandidate.update({
        where: { id: existing.id },
        data: {
          rawUrl: entry.rawUrl, blobSha: entry.blobSha, assetDigest: entry.assetDigest,
          releaseTag: entry.releaseTag, zipMember: entry.zipMember, sizeBytes: entry.size,
        },
      })
      summary.refreshed++
      summary.seen++
      // 正文没变且已有判定 ⇒ 不必再下一遍；这一条是配额与时间的主要节省点
      if (existing.verdict !== 'pending' && incomingId && existingId === incomingId) continue
    } else {
      await prisma.sourceCandidate.create({
        data: {
          repo, path: entry.path, rawUrl: entry.rawUrl, blobSha: entry.blobSha,
          assetDigest: entry.assetDigest, releaseTag: entry.releaseTag, zipMember: entry.zipMember, sizeBytes: entry.size,
        },
      })
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
    await downloadAndScore(repo, entry, settings.githubToken, summary)
  }

  summary.reposScanned++
  return used
}

async function downloadAndScore(
  repo: string,
  entry: CandidateEntry,
  token: string,
  summary: CrawlSummary,
): Promise<void> {
  let content: string
  let lastModified = ''
  if (entry.content !== undefined) {
    // zip 条目的正文在本轮解包时已经取出，不必（也不该）为每个条目重下一次整包
    content = entry.content
  } else {
    try {
      const response = await githubFetch(entry.rawUrl, token, { headers: { Accept: 'text/plain' } }, DOWNLOAD_TIMEOUT_MS)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const contentType = response.headers.get('content-type') || ''
      if (/text\/html/i.test(contentType)) throw new Error('返回的是网页不是文件')
      lastModified = response.headers.get('last-modified') || ''
      content = await response.text()
    } catch (err) {
      // 下载失败保留 pending：这是临时故障，不该把结论固化成"非音源"
      logger.info('[discovery] 正文抓取失败，留待下轮', { repo, path: entry.path, reason: err instanceof Error ? err.message : String(err) })
      return
    }
  }

  if (Buffer.byteLength(content, 'utf8') > MAX_SCRIPT_BYTES) {
    await markNotSource(repo, entry.path, '正文超过上限')
    summary.notSource++
    return
  }

  const { score, hits } = scoreCandidate(entry.path, content)
  const meta = parseScriptMeta(content)
  const suspect = score >= SUSPECT_THRESHOLD
  await prisma.sourceCandidate.update({
    where: { repo_path: { repo, path: entry.path } },
    data: {
      score,
      verdict: suspect ? 'suspect' : 'not-source',
      reason: suspect ? hits.join('、') : `特征分 ${score} 未达 ${SUSPECT_THRESHOLD}（命中：${hits.join('、') || '无'}）`,
      contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
      scriptName: meta.name || '',
      // 只按归一后的 @name 分组：同名不同内容也要顶掉旧的（被顶的行不删，面板还能看见）
      nameKey: meta.name ? toNameKey(meta.name) : '',
      // 两种来源都归一成 ISO：raw/release 下载的 Last-Modified 优先（那是文件级的时间），
      // 没有就用 release 的 published_at；tree 采集通常两个都拿不到，留空串
      upstreamAt: toIsoTime(lastModified) || toIsoTime(entry.upstreamAt),
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
    select: DEDUPE_FIELDS,
  })
  return applyDedupeLosers(rows)
}

const DEDUPE_FIELDS = {
  id: true, repo: true, path: true, contentHash: true, nameKey: true, scriptName: true,
  score: true, upstreamAt: true,
}

/** 选输家再逐条落 stale（整表去重只要数量） */
async function applyDedupeLosers(rows: DedupeRow[]): Promise<number> {
  const losers = pickDedupeLosers(rows)
  for (const id of losers) await prisma.sourceCandidate.update({ where: { id }, data: { state: 'stale' } })
  return losers.size
}

interface DedupeRow {
  id: number
  repo: string
  path: string
  contentHash: string
  nameKey: string
  scriptName: string
  score: number
  upstreamAt: string
}

/**
 * 一条刚提升为疑似可用的候选，与**在册的**同内容/同名候选并一次组。
 *
 * 为什么要有这一步：整表去重只在一轮采集结束时跑，而「仍然判级」是往 suspect 池里新塞一个
 * 成员 —— 不补这一下就会出现两条同名源并排站在「疑似可用」里，他各点一次导入就是两条同名源
 * 共用健康账本那一格（冷却与坏证据互相污染，与 P0-c 那条撞车检查同一个理由）。
 *
 * `verdict` 不能放在顶层：这条自己的等级此刻还没写下去（还是 not-source），顶层过滤会把它本人
 * 排除在比较之外，于是"该被顶掉的是它"那种情形算不出来。所以把 verdict 挪进各分支，
 * 自己那一支只按 id 收进来。
 */
async function dedupeAroundPromotedCandidate(self: DedupeRow): Promise<{ others: number; selfLost: boolean }> {
  const branches: Array<Record<string, unknown>> = [{ id: self.id }]
  if (self.contentHash) branches.push({ verdict: 'suspect', contentHash: self.contentHash })
  if (self.nameKey) branches.push({ verdict: 'suspect', nameKey: self.nameKey })
  const peers = await prisma.sourceCandidate.findMany({
    where: { state: 'new', OR: branches },
    select: DEDUPE_FIELDS,
  })
  if (peers.length < 2) return { others: 0, selfLost: false }
  const losers = pickDedupeLosers(peers)
  let others = 0
  for (const id of losers) {
    await prisma.sourceCandidate.update({ where: { id }, data: { state: 'stale' } })
    if (id !== self.id) others++
  }
  return { others, selfLost: losers.has(self.id) }
}

/** 分桶选输家：hash 与 nameKey 各成一桶，一个桶只留 `betterKeeper` 那个，其余落 stale */
function pickDedupeLosers(rows: DedupeRow[]): Set<number> {
  const versionOf = new Map<number, string>()
  for (const row of rows) versionOf.set(row.id, parseVersionFromPath(row.path, row.scriptName))

  const losers = new Set<number>()
  const groups = new Map<string, DedupeRow[]>()
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
  return losers
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
  /** P0-b 判级结果；null = 还没判过 */
  probe: CandidateProbeReport | null
  probedAt: string | null
  /** P0-c：已导入时它在 custom-sources 下的路径；空串 = 没导入过 */
  importedPath: string
  /** P0-c：与**已装源**撞车的对象（content=字节相同 / name=同名不同内容）；null = 没撞 */
  duplicateOf: { kind: 'content' | 'name'; path: string; name: string } | null
  /** 非空 = 这条来自某个 release 的资产（面板据此说"来自发布 vX"，并说明为什么不是仓库路径） */
  releaseTag: string
  /** 非空 = 正文在 rawUrl 那个 zip 里，这是条目名（整包的 sha256 记在 assetDigest） */
  zipMember: string
  /** 资产记录的 sha256（`sha256:<hex>`）；空 = tree 采集或 GitHub 没给 */
  assetDigest: string
  /** 上游时间：release 采集拿到的是发布时间，tree 采集通常拿不到（raw HEAD 不回 Last-Modified） */
  upstreamAt: string
}

/** 判级里真出货的格数；`judged=false` = 从没判过（`probeJson` 空） */
export function shipmentOf(probeJson: string): { judged: boolean; ok: number } {
  if (!probeJson) return { judged: false, ok: 0 }
  const report = parseProbeReport(probeJson)
  return { judged: true, ok: report ? Object.values(report.cells).filter(cell => cell.outcome === 'ok').length : 0 }
}

/** 列表排序用到的那几个键 */
interface CandidateListRank {
  judged: boolean
  ok: number
  score: number
  probedAtMs: number
  updatedAtMs: number
}

/**
 * 排序口径：**判过级的整体排在前面，按真出货格数从多到少**（同数按判级时间新）；
 * 从没判过的排在后面，按静态分排队等判。
 *
 * 为什么静态分不能再当第一键（本机 33 条已判级在册候选实测，2026-10-07）：`score≤5` 那十条
 * 平均出货 **1.00** 格，`score≥10` 那十五条平均 **0.67** 格 —— 过了阈值之后静态分基本没有
 * 信息量，混淆载荷那一批还是反的（4 分却 5/5 出货）。它的本职是"执行之前把噪音压下去"，
 * 拿它排第一就成了"能出货的排在后面"。
 */
function compareCandidatesForList(a: CandidateListRank, b: CandidateListRank): number {
  if (a.judged !== b.judged) return a.judged ? -1 : 1
  if (a.ok !== b.ok) return b.ok - a.ok
  if (a.probedAtMs !== b.probedAtMs) return b.probedAtMs - a.probedAtMs
  if (a.score !== b.score) return b.score - a.score
  return b.updatedAtMs - a.updatedAtMs
}

/** 假库里这些时间列可能是 undefined（真 Prisma 不会），按 0 算就好，别让排序把测试炸掉 */
const epochOf = (value: Date | null | undefined): number => (value instanceof Date ? value.getTime() : 0)

export async function listCandidates(filter: { verdict?: string; state?: string; take?: number } = {}): Promise<CandidateView[]> {
  const rows = await prisma.sourceCandidate.findMany({
    where: {
      ...(filter.verdict ? { verdict: filter.verdict } : {}),
      ...(filter.state ? { state: filter.state } : {}),
    },
  })
  // 排序要看判级结果，而判级结果是一段 JSON ⇒ 先每行解析一次算出排序键，排完切页，
  // **只给这一页**建视图（含与已装源的撞车检查）。反过来先建全表视图等于白算一千多行。
  const ranked = rows.map(row => ({
    row,
    rank: {
      ...shipmentOf(row.probeJson),
      score: row.score,
      probedAtMs: epochOf(row.probedAt),
      updatedAtMs: epochOf(row.updatedAt),
    } satisfies CandidateListRank,
  }))
  ranked.sort((a, b) => compareCandidatesForList(a.rank, b.rank))
  const page = ranked.slice(0, filter.take ?? 200)
  // 空列表时不去读盘上那十几份脚本
  const index = page.length ? await installedTwinIndex() : { byHash: new Map<string, InstalledTwin>(), byName: new Map<string, InstalledTwin>() }
  return page.map(({ row }) => {
    const twin = findInstalledTwin(index, row)
    return {
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
      probe: parseProbeReport(row.probeJson),
      probedAt: row.probedAt ? row.probedAt.toISOString() : null,
      importedPath: row.importedPath,
      duplicateOf: twin ? { kind: twin.kind, path: twin.twin.path, name: twin.twin.name } : null,
      releaseTag: row.releaseTag,
      zipMember: row.zipMember,
      assetDigest: row.assetDigest,
      upstreamAt: row.upstreamAt,
    }
  })
}

export async function countCandidates(): Promise<Record<string, number>> {
  const grouped = await prisma.sourceCandidate.groupBy({ by: ['verdict', 'state'], _count: { id: true } })
  const out: Record<string, number> = {}
  for (const row of grouped) out[`${row.verdict}/${row.state}`] = row._count.id
  return out
}

/** 面板上手动剔除一条候选（只改 state，不删行）；还在配置里的音源不给剔除，否则它成了孤儿 */
export async function dismissCandidate(id: number): Promise<void> {
  const row = await prisma.sourceCandidate.findUnique({ where: { id }, select: { state: true, importedPath: true } })
  if (row?.state === 'imported' && await isStillInstalled(row.importedPath)) {
    throw new SourceDiscoveryError('这条已经导入成音源了，请到「音源管理」里删除它', 409)
  }
  await prisma.sourceCandidate.update({ where: { id }, data: { state: 'stale' } }).catch(() => {})
}

// ————— P0-b：一次性 slot 判级 —————

/** 单平台一次判级的结果；outcome 与周测同口径，另加三种"没跑到"的形态 */
export interface CandidateProbeCell {
  /**
   * `harness` = 我们自己的通道没跑成（一次性进程崩了/起不来/IPC 断），
   * **不代表这个源不行**，所以既不算出货也不算脚本报错，允许重判。
   * 与之相对：`socket hang up` 这类是脚本自己的上游断连，属于真失败（实测两者从不同不同时出现在同一条候选上）。
   */
  outcome: ProbeCellOutcome | 'load-failed' | 'no-sample' | 'harness'
  latencyMs: number | null
  container: string | null
  reason: string | null
}

export interface CandidateProbeReport {
  cells: Record<string, CandidateProbeCell>
  /** false = blob sha 对不上，直接拒绝执行；null = 这条候选 tree 里本来就没给 sha */
  shaVerified: boolean | null
  note: string | null
}

const PROBE_CALL_TIMEOUT_MS = 12_000
const PROBE_LOAD_TIMEOUT_MS = 15_000
/** 一批最多判 50 条：约 250 次第三方取址，再多就有触发上游风控的风险 */
const PROBE_BATCH_LIMIT = 50
/** 条与条之间留 300ms，别把请求打成一串密集突发 */
const PROBE_BATCH_GAP_MS = 300
let probeGapMs = PROBE_BATCH_GAP_MS

/** 仅供测试：把条间隔调小，否则一批 50 条要在测试里真等 15 秒 */
export function _setProbeGapForTest(ms: number | null): void {
  probeGapMs = ms === null ? PROBE_BATCH_GAP_MS : ms
}
/** 与周测同一档，两处结果才可比 */
const PROBE_QUALITY = '320k'
const PROBABLE_PLATFORMS = ['kw', 'tx', 'wy', 'kg', 'mg']

/**
 * 一次性子进程通道的最小面（runner-client 的真身在生产注入，测试里换假的）。
 *
 * 判级**必须**走这条通道而不是共享 runner：实测过一个音源脚本自己内部抛出的未捕获
 * rejection 会把常驻 runner 整个打挂，连带所有平台的取址请求全部"运行器正在重启"——
 * 那个 runner 是所有音源共用的，播放路径上不能为了探测未知代码去冒这个险。
 */
export interface OneShotRunner {
  readonly mode: string
  validateScript(content: string, timeoutMs?: number): Promise<{ ok: boolean; sourceInfo?: unknown; error?: string }>
  probeScript(content: string, call: { source: string; musicInfo: unknown; quality: string }, timeoutMs?: number):
    Promise<{ ok: boolean; sourceInfo?: unknown; callValue?: unknown; callError?: string; error?: string }>
}

let runnerOverride: OneShotRunner | null = null

/** 仅供测试注入假的一次性进程通道 */
export function _setRunnerForTest(runner: OneShotRunner | null): void {
  runnerOverride = runner
}

function getOneShotRunner(): OneShotRunner {
  if (runnerOverride) return runnerOverride
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../music-core/runner-client').getSourceRunner()
}

function withLocalTimeout<T>(promise: Promise<T>, budgetMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超过 ${budgetMs}ms`)), budgetMs)
    }),
  ]).finally(() => { if (timer) clearTimeout(timer) }) as Promise<T>
}

async function fetchScriptText(rawUrl: string, token: string): Promise<string> {
  let response: Response
  try {
    response = await githubFetch(rawUrl, token, { headers: { Accept: 'text/plain' } }, DOWNLOAD_TIMEOUT_MS)
  } catch (err) {
    // 超时是 AbortController 触发的，undici 的原文是 "This operation was aborted" ——
    // 直接透传给管理员等于没说，换成能归因的一句
    const message = err instanceof Error ? err.message : String(err)
    if (/abort/i.test(message)) {
      throw new SourceDiscoveryError(`下载脚本超时（${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)}s），可能是网络抖动或该地址已被限流`, 504)
    }
    throw new SourceDiscoveryError(`下载脚本失败：${message.slice(0, 100)}`, 502)
  }
  if (!response.ok) throw new SourceDiscoveryError(`下载脚本失败：HTTP ${response.status}`, 502)
  const contentType = response.headers.get('content-type') || ''
  if (/text\/html/i.test(contentType)) throw new SourceDiscoveryError('下载脚本失败：返回的是网页不是文件', 502)
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_SCRIPT_BYTES) {
    throw new SourceDiscoveryError('脚本超过体积上限，拒绝判级', 400)
  }
  return text
}

/**
 * 判别"这条结论是我们通道没跑成，不是源坏了"。
 *
 * 只认 runner-client 自己造的那三种形态（进程崩了 / 起不来 / IPC 消息没送出去）。
 * **故意不认 `socket hang up`**：2026-10-05 用真候选数据对过 —— 带 `socket hang up` 的候选与带
 * "进程异常退出"的候选**交集为空**（8 条 vs 12 条，无一重合），说明前者是脚本自己的上游断连，
 * 是真实失败，不能一起算成噪声。
 */
const HARNESS_FAILURE = /进程异常退出|进程启动失败|消息发送失败/

/** 判级结论里有没有通道问题（面板据此提示可重判，导入闸门仍按"有没有真出货"算） */
export function hasHarnessCell(report: CandidateProbeReport | null): boolean {
  return !!report && Object.values(report.cells).some(cell => cell.outcome === 'harness')
}

async function saveReport(id: number, report: CandidateProbeReport): Promise<void> {
  await prisma.sourceCandidate.update({
    where: { id },
    data: { probeJson: JSON.stringify(report), probedAt: new Date(), reason: report.note },
  })
}

/**
 * 「仍然判级」放行的体积窗口：比这小的多半是 README 片段或占位脚本，比这大的多半是打包了
 * 二进制数据的杂物 —— 这两种跑起来也判不出音源，只是白给第三方取址接口加一次请求。
 */
const FORCE_PROBE_MIN_BYTES = 20 * 1024
const FORCE_PROBE_MAX_BYTES = 1024 * 1024

/**
 * 静态特征读不懂、但**长得像一份真载荷**的候选。
 *
 * 为什么要有这一档：混淆过的脚本（字符串表、base64 大块、没有 `musicSearch` 字面量）拿静态
 * 打分必然不过线，可它照样可能是能出货的源 —— 静态分不够不等于跑不起来。而"跑一下"是唯一
 * 能证明这件事的手段，所以给这一档留一个人工入口。
 *
 * 判据必须窄：`@name` 非空说明作者确实把它当洛雪音源发布，体积窗口说明不是碎屑；两条同时成立
 * 才放行。否则管理员拿它当万能口子，把 4 分的那种垃圾 js 也一条条送去真打第三方接口。
 */
export function looksLikeObfuscatedSource(
  row: { verdict: string; scriptName: string; sizeBytes: number },
): boolean {
  return row.verdict === 'not-source'
    && row.scriptName.trim().length > 0
    && row.sizeBytes >= FORCE_PROBE_MIN_BYTES
    && row.sizeBytes <= FORCE_PROBE_MAX_BYTES
}

/**
 * 判级一条候选：下载 → 复验 blob sha → 一次性子进程里"加载 + 真取一次址" →
 * 拿到地址后在父进程走与周测同一套首块魔数判据。
 *
 * 四个不可让步的点：
 * - **sha 对不上就不执行**：执行前的完整性校验比导入时校验有意义得多；
 * - 脚本文本**不落盘**：一次性通道收的是内容本身，用完随进程消失；
 * - 执行只发生在**一次性子进程**：来路不明的代码崩掉也只崩那个进程（详见 OneShotRunner）；
 * - 全程不碰 `sourceHealth`：判级不经取址瀑布，结构上写不进账本
 *   （探测抖动不能变成用户侧的坏证据，这条约束与周测同源）。
 *
 * `force` 只放宽入口那一条（原判不是 suspect 的，得同时满足 `looksLikeObfuscatedSource`），
 * 上面四点一个都不动。
 */
export async function probeCandidate(id: number, opts: { force?: boolean } = {}): Promise<CandidateProbeReport> {
  const row = await prisma.sourceCandidate.findUnique({ where: { id } })
  if (!row) throw new SourceDiscoveryError('候选不存在', 404)
  if (row.verdict !== 'suspect' && !(opts.force && looksLikeObfuscatedSource(row))) {
    throw new SourceDiscoveryError(
      '只给"疑似音源"的候选做判级；不像音源的，只有带 @name 且正文 20KB~1MB 才允许「仍然判级」',
    )
  }

  const settings = await getDiscoverySettings()
  // 取正文这一步就把"内容是不是我们记录的那一份"判掉：zip 条目要先复验整包 sha256 才解，
  // 普通候选对 blob sha / 资产 digest。对不上 = 拒绝执行，一步都不往下走
  const fetched = await fetchCandidateContent(row, settings.githubToken)
  const report: CandidateProbeReport = { cells: {}, shaVerified: fetched.anchor, note: null }

  if (fetched.anchor === false || !fetched.content) {
    report.note = `${fetched.reason ?? '内容与记录里的锚点不一致'}，拒绝执行`
    await saveReport(id, report)
    return report
  }
  const content = fetched.content

  const runner = getOneShotRunner()
  if (runner.mode === 'inline') {
    report.note = 'SOURCE_RUNNER_MODE=inline 时不判级：跑不可信代码没有隔离可言'
    await saveReport(id, report)
    return report
  }

  const loaded = await withLocalTimeout(
    runner.validateScript(content, PROBE_LOAD_TIMEOUT_MS),
    PROBE_LOAD_TIMEOUT_MS + 2_000,
    '脚本加载',
  )
  if (!loaded.ok) {
    report.note = `脚本初始化失败：${loaded.error ?? '未知原因'}`
    report.cells['_'] = {
      outcome: HARNESS_FAILURE.test(loaded.error ?? '') ? 'harness' : 'load-failed',
      latencyMs: null, container: null, reason: report.note.slice(0, 120),
    }
    await saveReport(id, report)
    return report
  }

  const declared = Object.keys((loaded.sourceInfo as { sources?: Record<string, unknown> } | undefined)?.sources ?? {})
  const platforms = declared.filter(platform => PROBABLE_PLATFORMS.includes(platform))
  if (!platforms.length) {
    report.note = '脚本没声明任何可判级平台'
    await saveReport(id, report)
    return report
  }

  const samples = await pickProbeSamples(1)
  for (const platform of platforms) {
    const sample = (samples[platform] ?? [])[0]
    if (!sample) {
      report.cells[platform] = { outcome: 'no-sample', latencyMs: null, container: null, reason: '库里没有该平台的基准样本' }
      continue
    }
    const started = Date.now()
    const probed = await withLocalTimeout(
      runner.probeScript(content, { source: platform, musicInfo: sample, quality: PROBE_QUALITY }, PROBE_CALL_TIMEOUT_MS),
      PROBE_CALL_TIMEOUT_MS + 2_000,
      `${platform} 取址`,
    ).catch((err): { ok: boolean; error?: string; callValue?: unknown; callError?: string } => (
      { ok: false, error: err instanceof Error ? err.message : String(err) }
    ))
    const elapsedMs = Date.now() - started

    if (!probed.ok) {
      const harness = HARNESS_FAILURE.test(String(probed.error ?? ''))
      report.cells[platform] = {
        outcome: harness ? 'harness' : elapsedMs >= PROBE_CALL_TIMEOUT_MS ? 'timeout' : 'error',
        latencyMs: elapsedMs, container: null,
        reason: String(probed.error ?? '一次性进程失败').slice(0, 120),
      }
      continue
    }
    const failure = 'callError' in probed && probed.callError ? String(probed.callError) : ''
    if (failure) {
      report.cells[platform] = {
        outcome: elapsedMs >= PROBE_CALL_TIMEOUT_MS ? 'timeout' : isContentMiss(failure) ? 'no-address' : 'error',
        latencyMs: elapsedMs, container: null, reason: failure.slice(0, 120),
      }
      continue
    }
    const url = probed.callValue
    if (typeof url !== 'string' || !url.trim()) {
      report.cells[platform] = { outcome: 'no-address', latencyMs: elapsedMs, container: null, reason: '脚本返回空地址' }
      continue
    }
    const head = await verifyHead(url)
    report.cells[platform] = { ...head, latencyMs: elapsedMs }
  }

  const cells = Object.values(report.cells)
  const okCount = cells.filter(cell => cell.outcome === 'ok').length
  const harnessCount = cells.filter(cell => cell.outcome === 'harness').length
  report.note = `${okCount}/${cells.length} 个平台真出货`
    + (harnessCount ? `｜${harnessCount} 格是我们通道没判成，可重判` : '')
  await saveReport(id, report)
  // 原判不是 suspect 的（走「仍然判级」进来的）：真出货就把等级提上来。
  // 静态分读不懂混淆载荷，而"跑起来真能取到地址"就是它缺的那份证据 —— 提升之后导入闸门
  // （要 suspect 且至少一格 ok）不用改就能用；0 出货则留在 not-source，只把红绿灯留在行上。
  if (row.verdict !== 'suspect' && okCount > 0) {
    // 先按"它已经是疑似可用"去跟在册的同名/同内容并一次组，再把等级写下去 ——
    // 整表去重只在采集轮末跑，这一档是点判级时才往池子里塞新成员，不补就会出现
    // 两条同名源并排站在「疑似可用」里，各点一次导入 = 两条源共用健康账本那一格。
    const superseded = await dedupeAroundPromotedCandidate(row)
    await prisma.sourceCandidate.update({
      where: { id },
      data: {
        verdict: 'suspect',
        reason: `原判 ${row.score} 分（静态特征读不懂）；仍然判级后 ${okCount}/${cells.length} 个平台真出货 ⇒ 提升为疑似可用`
          // 输的可能是它自己（同名另一条的上游时间更新）——那句话说的是"这条别装"，不是"顶掉了别人"
          + (superseded.selfLost ? '；同名的另一条上游更新，这条记为已被顶掉'
            : superseded.others ? `；顺带顶掉 ${superseded.others} 条同名/同内容的旧候选` : ''),
      },
    })
  }
  return report
}

/**
 * 起一次判级：立刻返回，结果靠 GET 轮询。
 * 判级会真执行第三方脚本（数秒到数十秒），不能把这个时间挂在 HTTP 请求上；
 * 一次只允许一个，避免多个 slot 同时跑把低配 NAS 压住。
 *
 * `force` 是给「仍然判级」留的那一档：静态分读不懂的混淆载荷，判据见
 * `looksLikeObfuscatedSource` —— 只放宽入口，不放宽隔离与完整性复验。
 */
export function startCandidateProbe(id: number, opts: { force?: boolean } = {}): { started: boolean; reason?: string } {
  if (progress.probingId !== null) return { started: false, reason: `候选 ${progress.probingId} 正在判级中` }
  if (progress.probeBatch?.running) return { started: false, reason: '有一批判级正在跑' }
  if (progress.running) return { started: false, reason: '有一轮发现正在跑' }
  progress.probingId = id
  progress.lastProbeNote = null
  void probeCandidate(id, opts)
    .then(report => { progress.lastProbeNote = report.note ?? '判级完成' })
    .catch(err => {
      progress.lastProbeNote = `判级失败：${err instanceof Error ? err.message : String(err)}`
      logger.info('[discovery] 判级失败', { id, reason: progress.lastProbeNote })
    })
    .finally(() => { progress.probingId = null })
  return { started: true }
}

/**
 * 批量判级：把"疑似在册、从没判过"的候选排队逐条判，上限 50 条一批。
 *
 * 为什么串行而不是并发：判级要在一次性子进程里跑**未知代码**，同时开好几个才是把低配 NAS
 * 压住的元凶；而一条本来就快不了多少 —— 实测（2026-10-05，真候选一批跑到 35 条用了 331 秒）
 * **平均一条约 9 秒**：秒回的脚本 3 秒，慢的是**判不动的平台要等超时档**（加载 15 秒 + 每平台
 * 12 秒），所以一批 50 条约 8 分钟。
 * 为什么设 50：判级是**真打第三方平台**的取址接口，一批就是上百次请求；一口气把全部候选
 * 打一遍有触发上游风控的风险（源可用性那期的聚合 API 就是这么吃到 CF 429 的）。
 */
export function startCandidateProbeBatch(): { started: boolean; reason?: string } {
  if (progress.probeBatch?.running) return { started: false, reason: '已有一批判级在跑' }
  if (progress.probingId !== null) return { started: false, reason: `候选 ${progress.probingId} 正在判级中` }
  if (progress.running || progress.draining) return { started: false, reason: '有发现在跑，先等它结束' }
  progress.probeBatch = { total: 0, done: 0, withAddress: 0, failed: 0, stopped: false, note: null, running: true, limit: PROBE_BATCH_LIMIT }
  void runProbeBatch(PROBE_BATCH_LIMIT)
    .catch(err => {
      if (progress.probeBatch) progress.probeBatch.note = `这批崩了：${err instanceof Error ? err.message : String(err)}`
      logger.warn('[discovery] 批量判级异常:', err)
    })
    .finally(() => {
      if (progress.probeBatch) progress.probeBatch.running = false
      // 停止标志要跟着收掉，否则下一次一点开就被上次的"停止"立刻中断
      progress.stopRequested = false
    })
  return { started: true }
}

async function runProbeBatch(limit: number): Promise<void> {
  const rows = await prisma.sourceCandidate.findMany({
    where: {
      verdict: 'suspect',
      state: 'new',
      // 没判过的，加上"通道没判成"的（重判就是它们需要的）；判成功或判成"源真不行"的不再重复消耗上游
      OR: [{ probeJson: '' }, { probeJson: { contains: '"harness"' } }],
    },
    orderBy: [{ score: 'desc' }, { updatedAt: 'desc' }],
    take: limit,
    select: { id: true },
  })
  const batch = progress.probeBatch!
  batch.total = rows.length
  if (!rows.length) {
    batch.note = '没有待判级的候选（在册且没判过的都空了）'
    return
  }
  for (const row of rows) {
    if (progress.stopRequested) {
      batch.stopped = true
      batch.note = `已停止，这批判了 ${batch.done}/${batch.total} 条`
      break
    }
    progress.probingId = row.id
    batch.done++
    try {
      const report = await probeCandidate(row.id)
      if (okCellCount(report) > 0) batch.withAddress++
      progress.lastProbeNote = report.note ?? '判级完成'
    } catch (err) {
      // 一条失败（下载不到、sha 对不上、脚本报错）不该把整批带停
      batch.failed++
      progress.lastProbeNote = `候选 ${row.id} 判级失败：${err instanceof Error ? err.message : String(err)}`
      logger.info('[discovery] 批量判级跳过一条', { id: row.id, reason: progress.lastProbeNote })
    } finally {
      progress.probingId = null
    }
    if (batch.done < batch.total) await sleep(probeGapMs)
  }
  if (!batch.note) batch.note = `这批判完：${batch.withAddress}/${batch.done} 条真出货`
  logger.info('[discovery] 批量判级结束', { 总数: batch.total, 判了: batch.done, 出货: batch.withAddress, 失败: batch.failed, 停止: batch.stopped })
}

/**
 * 清掉"扫描列表里已经没有的仓"留下的候选行（比如把停更仓从列表里删掉之后剩下的尾巴）。
 *
 * 为什么是**删行**而不是标 `stale`：这些仓以后不会再被扫，把行留着只是让"已被顶掉"越堆越厚；
 * 而哪天真要把仓加回列表，当新候选重采一遍才是我们要的状态（重新走下载与打分）。
 * 两个不动：列表里的仓一行不碰；`state=imported` 的行**保留** —— 它是配置里那条音源的溯源，
 * 删了就没法回答"这个脚本是从哪个仓来的"。
 */
export async function pruneOrphanCandidates(): Promise<{ removed: number; keptImported: string[] }> {
  const settings = await getDiscoverySettings()
  // 清单空着时"不在清单里"= 全部，一键就把候选表清空了 —— 这几乎肯定是误操作，先拦住
  if (!settings.repos.length) {
    throw new SourceDiscoveryError('扫描仓库清单是空的，这样会把所有候选都当成失效仓清掉；先加回至少一个仓再清理')
  }
  const listed = new Set(settings.repos)
  const rows = await prisma.sourceCandidate.findMany({
    where: { NOT: { repo: { in: [...listed] } } },
    select: { id: true, repo: true, state: true, importedPath: true },
  })
  const orphans = rows.filter(row => !listed.has(row.repo))
  const keptImported = orphans.filter(row => row.state === 'imported').map(row => `${row.repo} → ${row.importedPath || '(无路径)'}`)
  const doomed = orphans.filter(row => row.state !== 'imported')
  if (doomed.length) await prisma.sourceCandidate.deleteMany({ where: { id: { in: doomed.map(row => row.id) } } })
  logger.info('[discovery] 清理失效仓的候选', { 删除: doomed.length, 保留已导入: keptImported.length })
  return { removed: doomed.length, keptImported }
}

/** 面板渲染用：读回已存的判级结果，没判过或内容坏都返回 null */
export function parseProbeReport(probeJson: string): CandidateProbeReport | null {
  if (!probeJson) return null
  try {
    const parsed = JSON.parse(probeJson) as CandidateProbeReport
    return parsed && typeof parsed === 'object' && parsed.cells ? parsed : null
  } catch {
    return null
  }
}

// ————— P0-c：导入闭环 —————

function okCellCount(report: CandidateProbeReport | null): number {
  if (!report) return 0
  return Object.values(report.cells).filter(cell => cell.outcome === 'ok').length
}

/** 已装源里与某条候选"是同一个东西"的那一条 */
export interface InstalledTwin {
  path: string
  name: string
}

/**
 * 把"已经装进音源列表的源"索引成 内容哈希 → 谁、`@name` 归一键 → 谁。
 *
 * 补的是候选去重缺的**另一半**：候选之间早就按内容/同名去重了，但候选 vs 在册源没比过 ——
 * `addSource` 只校验路径唯一，于是不同仓库流传的同一份脚本能装成两条源。同名不是难看问题而是
 * 记账问题：健康账本的键就是音源名（`instance.config.name = name || path`，取址成败都按它记），
 * 两条同名源共用一格，冷却与坏证据互相污染，面板上也分不清谁是谁。
 *
 * 内容哈希直接读盘上的文件，不拿配置里的旧值：订阅更新会原地换内容，只有读文件才知道现在装的是啥。
 */
async function installedTwinIndex(): Promise<{ byHash: Map<string, InstalledTwin>; byName: Map<string, InstalledTwin> }> {
  const config = await readConfig()
  const byHash = new Map<string, InstalledTwin>()
  const byName = new Map<string, InstalledTwin>()
  for (const source of config.sources) {
    const twin: InstalledTwin = { path: source.path, name: source.name || '' }
    const nameKey = toNameKey(source.name || '')
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, twin)
    // 配置里的 path 由 addSource 校验过，但那是写入时的事；读之前再过一道，别拿配置去拼任意路径
    const abs = path.resolve(process.cwd(), source.path)
    const insideScriptsDir = !path.relative(SOURCE_MANAGER_CONSTANTS.SCRIPTS_DIR, abs).startsWith('..')
      && !path.isAbsolute(path.relative(SOURCE_MANAGER_CONSTANTS.SCRIPTS_DIR, abs))
    if (!insideScriptsDir) continue
    try {
      const hash = createHash('sha256').update(await fsp.readFile(abs, 'utf-8'), 'utf8').digest('hex')
      if (!byHash.has(hash)) byHash.set(hash, twin)
    } catch {
      // 配置里有、盘上没有：那是条坏源，不该让它把别的候选一起挡掉
    }
  }
  return { byHash, byName }
}

/** 先比内容再比同名：内容一样意味着"再装一遍毫无意义"，同名只是"要不要并排装" */
function findInstalledTwin(
  index: { byHash: Map<string, InstalledTwin>; byName: Map<string, InstalledTwin> },
  row: { contentHash: string; nameKey: string },
): { kind: 'content' | 'name'; twin: InstalledTwin } | null {
  if (row.contentHash && index.byHash.has(row.contentHash)) return { kind: 'content', twin: index.byHash.get(row.contentHash)! }
  if (row.nameKey && index.byName.has(row.nameKey)) return { kind: 'name', twin: index.byName.get(row.nameKey)! }
  return null
}

/**
 * 候选行写着"已导入"，不代表它还在服役 —— 音源管理里删掉那条源时，候选表这行不会跟着变。
 * 判据取配置文件（它才是驱动取址瀑布的东西），不取状态：源被删了就该能重新导入，
 * 否则一次误删会把这条候选永久锁死（实测：删完再点导入，回的是"已经导入为 …"）。
 */
async function isStillInstalled(importedPath: string): Promise<boolean> {
  if (!importedPath) return false
  const config = await readConfig()
  return config.sources.some(source => source.path === importedPath)
}

/**
 * 源被删掉之后，把引用它的那些候选行写回"可再导入"。
 *
 * 为什么需要这一步：行上的 `state='imported'` 是**导入那一刻的历史**，而"这条源还在不在"
 * 是配置文件里的事实。导入闸门和剔除闸门早就只看配置（见 `isStillInstalled`），但面板的
 * 页签、页签计数和「导入」按钮读的是 `state` —— 不写回，删过源的候选就永远挂着「已导入」：
 * 出现在「已导入」页签里、行上写着"已导入 → 某个不存在的路径"，还不给「导入」按钮，
 * 而它实际上是能导的。
 *
 * 由删除音源的那条路由调用（面板上那把删除键是唯一入口）。手改 `music-sources.json` 或
 * 整体替换配置的路径够不着 —— 那种情况下导入与剔除照样会重新开放（判据在配置那边），
 * 只是行上的标记要等下一次导入才纠正。
 */
export async function reopenCandidatesForRemovedSource(sourcePath: string): Promise<number> {
  if (!sourcePath) return 0
  const rows = await prisma.sourceCandidate.findMany({
    where: { importedPath: sourcePath },
    select: { id: true, reason: true },
  })
  for (const row of rows) {
    // 同一条路径只记一次：导入→删除→再导入→再删除是常规操作，句子叠两遍就成了噪音
    const note = `曾导入为 ${sourcePath}，源已删除 ⇒ 重新开放导入`
    const reason = row.reason
      ? (row.reason.includes(`曾导入为 ${sourcePath}`) ? row.reason : `${row.reason}；${note}`)
      : note
    await prisma.sourceCandidate.update({
      where: { id: row.id },
      data: {
        state: 'new',
        // importedPath 要清掉：留着它，行上就继续显示"已导入 → 那条已经不存在的路径"。
        // 这段历史改写在依据里，看得见但不参与任何判据。
        importedPath: '',
        reason,
      },
    })
  }
  return rows.length
}

/**
 * 把一条候选导入成正式音源。接口只收 id —— **地址与 blob sha 都取自库里那行记录**，
 * 客户端传进来的 URL / 正文一律不认，否则"发现出来的东西"就能被换成任何地址。
 *
 * 服务端按记录里的地址重新下载、先复验 blob sha 再走原有订阅通道（一次性进程校验 →
 * saveScript → addSource → 立即重建实例）。顺序不能反：sha 对不上说明下下来的不是
 * 打分/判级时那份东西，那种情况下连执行都不该发生。
 *
 * 三道闸门，按"证据成本"从低到高排：
 * - 库里已装着**内容完全相同**的一份 ⇒ 直接拒，`force` 也不给越（同下面那条重复导入的理由）；
 *   只是**同名**不同内容 ⇒ 也拒，但 `force` 能越（"我就要两条并排做对照"是他自己的决定，
 *   代价是两条源共用健康账本那一格）；
 * - 判级至少一个平台真出货，`force` 可以越过 —— 管理员对着红绿灯坚持要装，是他的决定；
 * - 已经导入且**那条源还在配置里**的不给重复导入，**这条不给 force 越** —— 点两下就在
 *   custom-sources 多一个 `-1.js`，那不属于"坚持"，属于垃圾。源已经在「音源管理」里删掉的，
 *   这条候选重新开放导入（判据看配置文件，不看候选状态）。
 */
export async function importCandidate(id: number, opts: { force?: boolean } = {}): Promise<SourceConfig> {
  const row = await prisma.sourceCandidate.findUnique({ where: { id } })
  if (!row) throw new SourceDiscoveryError('候选不存在', 404)
  if (row.verdict !== 'suspect') throw new SourceDiscoveryError('只导入判定为「疑似音源」的候选')
  if (row.state === 'imported' && await isStillInstalled(row.importedPath)) {
    throw new SourceDiscoveryError(`这条候选已经导入为 ${row.importedPath}，请到「音源管理」里管理它`, 409)
  }
  // 撞车检查排在判级之前：它不需要任何新证据（库里就摆着那份），而"还没判级"是可以下一步补的
  const twin = findInstalledTwin(await installedTwinIndex(), row)
  if (twin?.kind === 'content') {
    // 不给 force 越：字节相同意味着"这已经是第二条一模一样的源"，管理员再坚持也变不出新东西
    throw new SourceDiscoveryError(
      `库里已经装着内容完全相同的一份（${twin.twin.name || twin.twin.path}），不需要再装第二遍`,
      409,
    )
  }
  if (twin?.kind === 'name' && !opts.force) {
    throw new SourceDiscoveryError(
      `库里已有同名源「${twin.twin.name}」—— 健康账本按音源名记账，两条同名会互相污染冷却与坏证据。`
      + '确实要并排装请再点一次「确认强制导入」',
      409,
    )
  }
  if (!opts.force && okCellCount(parseProbeReport(row.probeJson)) === 0) {
    throw new SourceDiscoveryError(
      '判级里没有一个平台真出货（或还没判过）。先判级确认能用再导入；确实要强行装入请勾选「忽略判级」',
      409,
    )
  }

  let source: SourceConfig
  try {
    const settings = await getDiscoverySettings()
    if (row.zipMember) {
      // 包内条目：服务端按记录**重下整包 → 先复验整包 sha256 → 再取那一个条目**。
      // 这种源不登记订阅 —— 订阅更新按 URL 重取"整份脚本"，而它的正文在包里的一条目，
      // 让「音源管理」去更新它只会取错东西；要拿上游新版本请回到发现面板再采一次。
      const fetched = await fetchCandidateContent(row, settings.githubToken)
      if (fetched.anchor === false || !fetched.content) {
        throw new SourceDiscoveryError(`导入失败：${fetched.reason ?? '取不到正文'}`, 409)
      }
      source = await importSubscription(row.rawUrl, {
        content: fetched.content,
        filename: (row.zipMember.split('/').pop() || row.zipMember),
        subscribe: false,
      })
    } else {
      // 复验锚点按来源分：release 资产不是 git blob，只能对 GitHub 记录的 sha256；
      // tree 文件仍对 blob sha。两个都没有就交给下游校验（面板会显示"无从校验"）
      source = await importSubscription(row.rawUrl, assetDigestHex(row.assetDigest)
        ? { expectedSha256: assetDigestHex(row.assetDigest) }
        : { expectedBlobSha: row.blobSha })
    }
  } catch (err) {
    if (err instanceof SourceDiscoveryError) throw err
    const status = err instanceof SourceSubscriptionError ? err.status : 422
    const message = err instanceof Error ? err.message : String(err)
    // 导入失败不动 state：这是一次没成功的操作，不是"这条候选不值得再看"
    logger.info('[discovery] 导入失败', { id, repo: row.repo, reason: message.slice(0, 160) })
    throw new SourceDiscoveryError(`导入失败：${message}`, status)
  }

  await prisma.sourceCandidate.update({ where: { id }, data: { state: 'imported', importedPath: source.path } })
  logger.info('[discovery] 候选已导入为音源', { id, 仓库: row.repo, 脚本: source.path })
  return source
}

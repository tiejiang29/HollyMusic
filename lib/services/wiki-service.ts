/**
 * 维基百科服务（可选能力，best-effort）：简介 + 歌手头像
 *
 * Apple 接口没有歌手/专辑简介（musicArtist 实体无 bio，专辑只有一行 copyright），
 * 也没有歌手照片——简介与头像的免费来源都是 zh.wikipedia.org（本网络需 SOCKS 代理）。
 *
 * 启用条件：环境变量 WIKI_PROXY_URL（如 socks5://172.16.1.7:1081）。
 * 未配置时所有查询直接返回 null（调用方字段缺省），不影响任何主流程。
 *
 * 条目定位用 wiki 搜索 API（generator=search，一次往返同时取 extracts + pageimages
 * 缩略图），避免"七里香 (專輯)"这类消歧标题硬编码；文本经 OpenCC 转简体；
 * 条目数据与图片字节分别缓存 24h。
 */

import { socksDispatcher } from 'fetch-socks'
import type { SocksProxy } from 'socks'
import { searchCache } from '@/lib/cache-manager'
import { logger } from '@/lib/logger'
import { appleT2S } from './itunes-service'

const WIKI_TIMEOUT = 10_000
const CACHE_TTL = 24 * 60 * 60 * 1000
/** 简介截断长度（字符）：前端展示用，长简介折叠 */
const EXTRACT_LIMIT = 600
/** 头像缩略图宽度（像素） */
const THUMB_SIZE = 600

const PROXY_URL = process.env.WIKI_PROXY_URL || ''
let dispatcher: ReturnType<typeof socksDispatcher> | null = null
let dispatcherFailed = false

function getDispatcher() {
  if (!PROXY_URL) return null
  if (dispatcher) return dispatcher
  if (dispatcherFailed) return null
  try {
    const u = new URL(PROXY_URL)
    // socks5/socks4/socks4a；socks5h 的 DNS 解析交给代理端（等价 curl --socks5-hostname）
    const type = u.protocol === 'socks4:' ? 4 : u.protocol === 'socks4a:' ? 4 : 5
    const proxy: SocksProxy = { host: u.hostname, port: Number(u.port) || 1080, type }
    dispatcher = socksDispatcher(proxy)
    return dispatcher
  } catch (error) {
    logger.warn('[wiki] WIKI_PROXY_URL 无效，维基功能停用:', error instanceof Error ? error.message : error)
    dispatcherFailed = true
    return null
  }
}

export interface WikiPageData {
  /** 词条首段简介（简体，截断） */
  extract: string | null
  /** 词条缩略图 URL（upload.wikimedia.org，本网络不可直连，需经服务端代理转发） */
  thumbUrl: string | null
  /** Wikidata QID（连接结构化档案；条目无 QID 时缺省） */
  qid?: string | null
}

/**
 * 取维基条目数据（简介 + 缩略图）：一次 API 往返（generator=search 定位条目 +
 * prop=extracts|pageimages）。缓存 24h。
 * @param query 搜索词（歌手名 / 专辑名）
 * @param kind artist=歌手条目；album=专辑条目（搜索词自动追加"專輯"消歧）
 */
export async function getWikiPageData(query: string, kind: 'artist' | 'album'): Promise<WikiPageData | null> {
  const q = query.trim()
  if (!q || !PROXY_URL) return null
  const cacheKey = `wiki:v2:${kind}:${q}`
  const cached = searchCache.get(cacheKey) as WikiPageData | null
  if (cached) return cached

  const d = getDispatcher()
  if (!d) return null

  const search = kind === 'album' ? `${q} 專輯` : q
  const url = 'https://zh.wikipedia.org/w/api.php?' + new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: search,
    gsrlimit: '1',
    prop: 'extracts|pageimages|pageprops',
    explaintext: '1',
    exintro: '1',
    piprop: 'thumbnail',
    pithumbsize: String(THUMB_SIZE),
    ppprop: 'wikibase_item',
  }).toString()

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WIKI_TIMEOUT)
    try {
      const resp = await polite(() => fetch(url, { dispatcher: d, signal: controller.signal } as RequestInit))
      if (!resp.ok) return null
      const data = await resp.json() as {
        query?: { pages?: Record<string, { title?: string; extract?: string; thumbnail?: { source?: string }; pageprops?: { wikibase_item?: string } }> }
      }
      const pages = data.query?.pages ?? {}
      const first = Object.values(pages)[0]
      const result: WikiPageData = {
        extract: first?.extract?.trim() ? appleT2S(first.extract).slice(0, EXTRACT_LIMIT) : null,
        thumbUrl: first?.thumbnail?.source || null,
        qid: first?.pageprops?.wikibase_item || null,
      }
      if (!result.extract && !result.thumbUrl) return null
      searchCache.set(cacheKey, result, CACHE_TTL)
      return result
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    logger.debug('[wiki] 条目获取失败（静默）:', error instanceof Error ? error.message : error)
    return null
  }
}

/** 取维基简介（简体）——getWikiPageData 的简介薄封装 */
export async function getWikiExtract(query: string, kind: 'artist' | 'album'): Promise<string | null> {
  const data = await getWikiPageData(query, kind)
  return data?.extract ?? null
}

export interface WikiImageBytes {
  bytes: ArrayBuffer
  contentType: string
}

/**
 * 经代理抓取维基图片字节（upload.wikimedia.org 本网络不可直连，前端无法直接 <img>；
 * 由服务端取回转发）。缓存 24h。
 */
export async function fetchWikiImage(imageUrl: string): Promise<WikiImageBytes | null> {
  if (!PROXY_URL || !/^https:\/\/upload\.wikimedia\.org\//.test(imageUrl)) return null
  const cacheKey = `wiki:img:${imageUrl}`
  const cached = searchCache.get(cacheKey) as WikiImageBytes | null
  if (cached) return cached

  const d = getDispatcher()
  if (!d) return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WIKI_TIMEOUT)
    try {
      const resp = await fetch(imageUrl, { dispatcher: d, signal: controller.signal } as RequestInit)
      if (!resp.ok) return null
      const contentType = resp.headers.get('content-type') || 'image/jpeg'
      const bytes = await resp.arrayBuffer()
      if (bytes.byteLength === 0 || bytes.byteLength > 5 * 1024 * 1024) return null
      const result: WikiImageBytes = { bytes, contentType }
      searchCache.set(cacheKey, result, CACHE_TTL)
      return result
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    logger.debug('[wiki] 图片获取失败（静默）:', error instanceof Error ? error.message : error)
    return null
  }
}

// ==================== Wikidata 结构化档案 ====================

/** Wikidata 声明（claims）的宽松形状 */
type WdClaims = Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>>

/** 礼貌队列：相邻维基/Wikidata 请求间隔 ≥250ms（模块级串行；维基限流会直接拒绝） */
let wikiQueueTail: Promise<unknown> = Promise.resolve()
function polite<T>(fn: () => Promise<T>): Promise<T> {
  const run = wikiQueueTail.then(async () => {
    await new Promise(r => setTimeout(r, 250))
    return fn()
  })
  wikiQueueTail = run.catch(() => undefined)
  return run
}

async function fetchWikidataJson(path: string): Promise<Record<string, unknown> | null> {
  const d = getDispatcher()
  if (!d) return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WIKI_TIMEOUT)
    try {
      const resp = await polite(() => fetch(`https://www.wikidata.org${path}`, { dispatcher: d, signal: controller.signal } as RequestInit))
      if (!resp.ok) return null
      return await resp.json() as Record<string, unknown>
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    logger.debug('[wiki] Wikidata 请求失败（静默）:', error instanceof Error ? error.message : error)
    return null
  }
}

/** 取实体 claims（缓存 24h） */
async function getClaims(qid: string): Promise<WdClaims | null> {
  const cacheKey = `wiki:claims:${qid}`
  const cached = searchCache.get(cacheKey) as WdClaims | null
  if (cached) return cached
  const data = await fetchWikidataJson(`/w/api.php?action=wbgetentities&ids=${encodeURIComponent(qid)}&props=claims&format=json`)
  const entities = data?.entities as Record<string, { claims?: WdClaims }> | undefined
  const claims = entities?.[qid]?.claims
  if (!claims) return null
  searchCache.set(cacheKey, claims, CACHE_TTL)
  return claims
}

/** Q-id → 中文名（批量：一次 wbgetentities ≤50 个；zh-hans → zh → en 回退，OpenCC 简体；逐个缓存） */
async function resolveQidLabels(qids: string[], limit: number): Promise<string[]> {
  const targets = [...new Set(qids)].slice(0, Math.min(limit, 50))
  if (targets.length === 0) return []
  const out: string[] = []
  const missing: string[] = []
  for (const id of targets) {
    const cached = searchCache.get(`wiki:qlabel:${id}`) as string | null
    if (cached) out.push(cached)
    else missing.push(id)
  }
  if (missing.length > 0) {
    const data = await fetchWikidataJson(`/w/api.php?action=wbgetentities&ids=${missing.join('|')}&props=labels&languages=zh-hans|zh|en&format=json`)
    const entities = data?.entities as Record<string, { labels?: Record<string, { value?: string }> }> | undefined
    for (const id of missing) {
      const labels = entities?.[id]?.labels
      const value = labels?.['zh-hans']?.value || labels?.zh?.value || labels?.en?.value
      if (value) {
        const simplified = appleT2S(value)
        searchCache.set(`wiki:qlabel:${id}`, simplified, CACHE_TTL)
        out.push(simplified)
      }
    }
  }
  // 保持原声明顺序去重
  const seen = new Set<string>()
  return out.filter(x => (seen.has(x) ? false : seen.add(x)))
}

/** 取某属性的 Q-id 列表（去重保序） */
function claimQids(claims: WdClaims, pid: string): string[] {
  const out: string[] = []
  for (const c of claims[pid] || []) {
    const id = (c.mainsnak?.datavalue?.value as { id?: string } | undefined)?.id
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** 取时间属性（P569/P577），年精度返回 YYYY、日精度返回 YYYY-MM-DD */
function claimTime(claims: WdClaims, pid: string): string | undefined {
  const raw = (claims[pid]?.[0]?.mainsnak?.datavalue?.value as { time?: string } | undefined)?.time
  if (!raw) return undefined
  const m = /^\+(\d{4})-(\d{2})-(\d{2})/.exec(raw)
  if (!m) return undefined
  return m[2] === '00' ? m[1] : `${m[1]}-${m[2]}-${m[3]}`
}



export interface ArtistProfile {
  qid: string
  /** 出生日期（P569） */
  birthDate?: string
  /** 职业（P106，≤4） */
  occupations?: string[]
  /** 流派（P136，≤4） */
  genres?: string[]
  /** 唱片公司（P264，≤3） */
  recordLabels?: string[]
  /** 国籍（P27） */
  nationality?: string
}

/** 艺人结构化档案：wiki 条目 QID → Wikidata claims → 中文标签（简体）。缓存 24h，best-effort。 */
export async function getArtistProfile(name: string): Promise<ArtistProfile | null> {
  const q = name.trim()
  if (!q || !PROXY_URL) return null
  const cacheKey = `wiki:artistProfile:${q}`
  const cached = searchCache.get(cacheKey) as ArtistProfile | null
  if (cached) return cached

  const page = await getWikiPageData(q, 'artist')
  if (!page?.qid) return null
  const claims = await getClaims(page.qid)
  if (!claims) return null

  const occupations = await resolveQidLabels(claimQids(claims, 'P106'), 4)
  const genres = await resolveQidLabels(claimQids(claims, 'P136'), 4)
  const recordLabels = await resolveQidLabels(claimQids(claims, 'P264'), 3)
  const nationality = (await resolveQidLabels(claimQids(claims, 'P27'), 1))[0]
  const profile: ArtistProfile = {
    qid: page.qid,
    ...(claimTime(claims, 'P569') ? { birthDate: claimTime(claims, 'P569') } : {}),
    ...(occupations.length ? { occupations } : {}),
    ...(genres.length ? { genres } : {}),
    ...(recordLabels.length ? { recordLabels } : {}),
    ...(nationality ? { nationality } : {}),
  }
  searchCache.set(cacheKey, profile, CACHE_TTL)
  return profile
}

export interface AlbumProfile {
  qid: string
  /** P436（MusicBrainz 发行组 ID）与本地专辑 gid 一致——条目定位的高置信验证 */
  verified?: boolean
  /** 发行日期（P577，年精度返回 YYYY） */
  releaseDate?: string
  /** 流派（P136，≤3） */
  genres?: string[]
  /** 唱片公司（P264，≤3） */
  recordLabels?: string[]
}

/**
 * 专辑结构化档案：wiki 条目 QID → Wikidata claims。
 * 带 gid 时做 P436 校验：不一致=搜索定位错条目，整组数据丢弃（不出张冠李戴的档案）。
 */
export async function getAlbumProfile(title: string, gid?: string): Promise<AlbumProfile | null> {
  const q = title.trim()
  if (!q || !PROXY_URL) return null
  const cacheKey = `wiki:albumProfile:${gid || ''}:${q}`
  const cached = searchCache.get(cacheKey) as AlbumProfile | null
  if (cached) return cached

  const page = await getWikiPageData(q, 'album')
  if (!page?.qid) return null
  const claims = await getClaims(page.qid)
  if (!claims) return null

  // P436 校验：本地专辑 gid 与条目 MusicBrainz 发行组 ID 对照
  const p436 = (claims.P436?.[0]?.mainsnak?.datavalue?.value as string | undefined) || null
  if (gid && p436 && p436 !== gid) {
    logger.debug(`[wiki] 专辑条目 P436 校验不一致，丢弃档案: ${q} 期望 ${gid} 实得 ${p436}`)
    searchCache.set(cacheKey, null as unknown as AlbumProfile, CACHE_TTL)
    return null
  }

  const genres = await resolveQidLabels(claimQids(claims, 'P136'), 3)
  const recordLabels = await resolveQidLabels(claimQids(claims, 'P264'), 3)
  const profile: AlbumProfile = {
    qid: page.qid,
    ...(gid && p436 === gid ? { verified: true } : {}),
    ...(claimTime(claims, 'P577') ? { releaseDate: claimTime(claims, 'P577') } : {}),
    ...(genres.length ? { genres } : {}),
    ...(recordLabels.length ? { recordLabels } : {}),
  }
  searchCache.set(cacheKey, profile, CACHE_TTL)
  return profile
}

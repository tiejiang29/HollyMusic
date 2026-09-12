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
    prop: 'extracts|pageimages',
    explaintext: '1',
    exintro: '1',
    piprop: 'thumbnail',
    pithumbsize: String(THUMB_SIZE),
  }).toString()

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WIKI_TIMEOUT)
    try {
      const resp = await fetch(url, { dispatcher: d, signal: controller.signal } as RequestInit)
      if (!resp.ok) return null
      const data = await resp.json() as {
        query?: { pages?: Record<string, { title?: string; extract?: string; thumbnail?: { source?: string } }> }
      }
      const pages = data.query?.pages ?? {}
      const first = Object.values(pages)[0]
      const result: WikiPageData = {
        extract: first?.extract?.trim() ? appleT2S(first.extract).slice(0, EXTRACT_LIMIT) : null,
        thumbUrl: first?.thumbnail?.source || null,
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

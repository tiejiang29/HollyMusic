/**
 * 维基百科简介服务（可选能力，best-effort）
 *
 * Apple 接口没有歌手/专辑简介（musicArtist 实体无 bio，专辑只有一行 copyright），
 * 简介唯一免费来源是 zh.wikipedia.org——其 API 在本网络环境需走 SOCKS 代理。
 *
 * 启用条件：环境变量 WIKI_PROXY_URL（如 socks5://172.16.1.7:1081）。
 * 未配置时所有 getWikiExtract 直接返回 null（调用方字段缺省），不影响任何主流程。
 *
 * 条目定位用 wiki 搜索 API（generator=search，一次往返），避免"七里香 (專輯)"
 * 这类消歧标题硬编码；返回文本经 OpenCC 转简体；缓存 24h。
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
    logger.warn('[wiki] WIKI_PROXY_URL 无效，简介功能停用:', error instanceof Error ? error.message : error)
    dispatcherFailed = true
    return null
  }
}

/**
 * 取维基简介（简体）。
 * @param query 搜索词（歌手名 / 专辑名）
 * @param kind artist=歌手条目；album=专辑条目（搜索词自动追加"專輯"消歧）
 */
export async function getWikiExtract(query: string, kind: 'artist' | 'album'): Promise<string | null> {
  const q = query.trim()
  if (!q || !PROXY_URL) return null
  const cacheKey = `wiki:${kind}:${q}`
  const cached = searchCache.get(cacheKey) as string | null
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
    prop: 'extracts',
    explaintext: '1',
    exintro: '1',
  }).toString()

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WIKI_TIMEOUT)
    try {
      const resp = await fetch(url, { dispatcher: d, signal: controller.signal } as RequestInit)
      if (!resp.ok) return null
      const data = await resp.json() as {
        query?: { pages?: Record<string, { title?: string; extract?: string }> }
      }
      const pages = data.query?.pages ?? {}
      const first = Object.values(pages)[0]
      const extract = first?.extract?.trim()
      if (!extract) return null
      const simplified = appleT2S(extract).slice(0, EXTRACT_LIMIT)
      searchCache.set(cacheKey, simplified, CACHE_TTL)
      return simplified
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    logger.debug('[wiki] 简介获取失败（静默）:', error instanceof Error ? error.message : error)
    return null
  }
}

/**
 * iTunes Search API 服务（Apple 音乐元数据，只读）
 *
 * 三步用法（实测验证）：
 * 1. 认人/列专辑：search?term=&entity=album&attribute=artistTerm&country=tw —— 一次返回该歌手全部专辑
 * 2. 出曲目：lookup?id={collectionId}&entity=song&limit=200&country=tw —— 曲名/碟位/时长毫秒
 *
 * 用途（元数据增强，不参与播放）：专辑年份、高清封面（mzstatic CDN，100x100bb 可改 600x600bb）。
 * 返回数据为繁体，统一经 OpenCC 转简体后输出/匹配。
 * 限流：无官方文档，礼貌队列 200ms 间隔；结果缓存 24h。
 */

import * as OpenCC from 'opencc-js'
import { searchCache } from '@/lib/cache-manager'
import { logger } from '@/lib/logger'

const ITUNES_TIMEOUT = 10_000
const POLITENESS_INTERVAL = 200
const CACHE_TTL = 24 * 60 * 60 * 1000

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// 简繁转换器（模块级单例）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const OpenCCAny = OpenCC as any
const t2s = OpenCCAny.Converter ? OpenCCAny.Converter({ from: 'tw', to: 'cn' }) : (v: string) => v
const s2t = OpenCCAny.Converter ? OpenCCAny.Converter({ from: 'cn', to: 'tw' }) : (v: string) => v

/** 繁→简（Apple 返回数据的展示/匹配统一口径） */
export function appleT2S(value: string | null | undefined): string {
  return t2s(value || '') || ''
}

/** 简→繁（搜索词转换，部分场景 Apple 索引按繁体） */
export function appleS2T(value: string | null | undefined): string {
  return s2t(value || '') || ''
}

/** 礼貌队列：相邻 Apple 请求间隔 ≥200ms（模块级串行） */
let queueTail: Promise<unknown> = Promise.resolve()
function polite<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(async () => {
    await new Promise(r => setTimeout(r, POLITENESS_INTERVAL))
    return fn()
  })
  queueTail = run.catch(() => undefined)
  return run
}

async function fetchItunesJson(url: string): Promise<{ resultCount?: number; results?: Array<Record<string, unknown>> } & Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(ITUNES_TIMEOUT),
  })
  if (!response.ok) throw new Error(`Apple 接口请求失败: ${response.status}`)
  return await response.json()
}

function artworkHiRes(url: string | undefined): string | null {
  if (!url) return null
  return url.replace('100x100bb', '600x600bb')
}

export interface ItunesAlbumCard {
  /** Apple collectionId（详情 lookup 用） */
  collectionId: string
  /** 简体专辑名 */
  title: string
  /** 简体歌手名 */
  artist: string
  trackCount?: number
  year?: string
  /** 600x600 高清封面（mzstatic CDN） */
  img: string | null
}

interface ItunesCollection {
  collectionId?: number | string
  collectionName?: string
  artistName?: string
  trackCount?: number
  releaseDate?: string
  artworkUrl100?: string
  copyright?: string
  wrapperType?: string
}

interface ItunesTrack {
  kind?: string
  trackName?: string
  trackNumber?: number
  discNumber?: number
  trackTimeMillis?: number
  wrapperType?: string
}

function toCard(c: ItunesCollection): ItunesAlbumCard {
  return {
    collectionId: String(c.collectionId ?? ''),
    title: appleT2S(c.collectionName),
    artist: appleT2S(c.artistName),
    trackCount: c.trackCount,
    year: c.releaseDate?.slice(0, 10),
    img: artworkHiRes(c.artworkUrl100),
  }
}

/** Apple 专辑搜索（country=tw，繁体结果自动转简体） */
export async function searchItunesAlbums(keyword: string, limit = 30): Promise<ItunesAlbumCard[]> {
  const k = keyword.trim()
  if (!k) return []
  const cacheKey = `itunes:search:${k}:${limit}`
  const cached = searchCache.get(cacheKey) as ItunesAlbumCard[] | null
  if (cached) return cached

  const cap = Math.max(1, Math.min(limit, 200))
  const data = await polite(() => fetchItunesJson(
    `https://itunes.apple.com/search?term=${encodeURIComponent(k)}&country=tw&media=music&entity=album&limit=${cap}`,
  ))
  const list = ((data.results || []) as unknown as ItunesCollection[])
    .filter(c => c.collectionId && c.collectionName)
    .map(toCard)
  searchCache.set(cacheKey, list, CACHE_TTL)
  return list
}

export interface ItunesArtistCard {
  /** Apple artistId（歌手详情 lookup 用） */
  artistId: string
  /** 简体歌手名 */
  name: string
  /** 主要流派（如 華語流行樂 → 华语流行乐） */
  genre?: string
}

/** Apple 歌手搜索（entity=musicArtist，country=tw；繁体自动转简体） */
export async function searchItunesArtists(keyword: string, limit = 10): Promise<ItunesArtistCard[]> {
  const k = keyword.trim()
  if (!k) return []
  const cacheKey = `itunes:artistSearch:${k}:${limit}`
  const cached = searchCache.get(cacheKey) as ItunesArtistCard[] | null
  if (cached) return cached

  const cap = Math.max(1, Math.min(limit, 25))
  const data = await polite(() => fetchItunesJson(
    `https://itunes.apple.com/search?term=${encodeURIComponent(k)}&country=tw&media=music&entity=musicArtist&limit=${cap}`,
  ))
  const list = ((data.results || []) as unknown as Array<{ artistId?: number | string; artistName?: string; primaryGenreName?: string }>)
    .filter(a => a.artistId && a.artistName)
    .map(a => ({
      artistId: String(a.artistId),
      name: appleT2S(a.artistName),
      genre: a.primaryGenreName ? appleT2S(a.primaryGenreName) : undefined,
    }))
  searchCache.set(cacheKey, list, CACHE_TTL)
  return list
}

/**
 * 歌手专辑索引：attribute=artistTerm 一次拿该歌手全部专辑（最多 200），
 * 按"简体专辑名"归一化为键（封面/年份查询用）。缓存 24h。
 */
export async function getArtistAlbumIndex(artist: string): Promise<Map<string, { collectionId: string; img: string | null; year?: string }>> {
  const a = artist.trim()
  const cacheKey = `itunes:artistIndex:${a.toLowerCase()}`
  const cached = searchCache.get(cacheKey) as Map<string, { collectionId: string; img: string | null; year?: string }> | null
  if (cached) return cached

  const index = new Map<string, { collectionId: string; img: string | null; year?: string }>()
  if (!a) return index
  try {
    const data = await polite(() => fetchItunesJson(
      `https://itunes.apple.com/search?term=${encodeURIComponent(appleS2T(a))}&country=tw&media=music&entity=album&attribute=artistTerm&limit=200`,
    ))
    for (const c of ((data.results || []) as unknown as ItunesCollection[])) {
      if (!c.collectionId || !c.collectionName) continue
      // 歌手名二次校验（同名歌手过滤）：归一化后双向包含
      const nameKey = appleT2S(c.collectionName).toLowerCase().replace(/\s+/g, '')
      if (index.has(nameKey)) continue
      index.set(nameKey, {
        collectionId: String(c.collectionId),
        img: artworkHiRes(c.artworkUrl100),
        year: c.releaseDate?.slice(0, 10),
      })
    }
  } catch (error) {
    logger.warn('[itunes] 歌手专辑索引获取失败:', error instanceof Error ? error.message : error)
  }
  searchCache.set(cacheKey, index, CACHE_TTL)
  return index
}

export interface ItunesArtistInfo {
  artistId: string
  /** 简体歌手名 */
  name: string
  genre?: string
  /** 热门歌曲（Apple 排序即热门度；歌名简体、含时长毫秒转秒） */
  songs: Array<{ title: string; titleNorm: string; secs: number | null; artist: string }>
}

/** Apple 歌手热门歌曲：lookup?id={artistId}&entity=song（返回歌手对象 + 热门曲目）。缓存 24h。 */
export async function getItunesArtistSongs(artistId: string): Promise<ItunesArtistInfo | null> {
  const cacheKey = `itunes:artistSongs:${artistId}`
  const cached = searchCache.get(cacheKey) as ItunesArtistInfo | null
  if (cached) return cached

  const data = await polite(() => fetchItunesJson(
    `https://itunes.apple.com/lookup?id=${encodeURIComponent(artistId)}&entity=song&limit=25&country=tw`,
  ))
  const results = (data.results || []) as unknown as Array<{ wrapperType?: string; artistType?: string; artistId?: number | string; artistName?: string; primaryGenreName?: string; kind?: string; trackName?: string; trackTimeMillis?: number }>
  const artist = results.find(r => r.wrapperType === 'artist' && r.artistName)
  if (!artist) {
    logger.warn(`[itunes] artistId ${artistId} 未找到歌手`)
    return null
  }
  const info: ItunesArtistInfo = {
    artistId: String(artist.artistId ?? artistId),
    name: appleT2S(artist.artistName),
    genre: artist.primaryGenreName ? appleT2S(artist.primaryGenreName) : undefined,
    songs: results
      .filter(r => r.kind === 'song' && r.trackName)
      .map(r => {
        const title = appleT2S(r.trackName)
        return {
          title,
          titleNorm: title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''),
          secs: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : null,
          artist: appleT2S(artist.artistName),
        }
      }),
  }
  searchCache.set(cacheKey, info, CACHE_TTL)
  return info
}

export interface ItunesAlbumDetail {
  album: { collectionId: string; title: string; artist: string; year?: string; img: string | null; trackCount: number; copyright?: string }
  tracks: Array<{ title: string; titleNorm: string; secs: number | null; disc: number; position: number }>
}

/** Apple 专辑详情：lookup entity=song，曲目含碟位/序号/时长（毫秒），歌名转简体。缓存 24h。 */
export async function getItunesAlbumDetail(collectionId: string): Promise<ItunesAlbumDetail | null> {
  const cacheKey = `itunes:detail:${collectionId}`
  const cached = searchCache.get(cacheKey) as ItunesAlbumDetail | null
  if (cached) return cached

  const data = await polite(() => fetchItunesJson(
    `https://itunes.apple.com/lookup?id=${encodeURIComponent(collectionId)}&entity=song&limit=200&country=tw`,
  ))
  const results = (data.results || []) as unknown as Array<ItunesCollection & ItunesTrack>
  const collection = results.find(r => r.wrapperType === 'collection' && r.collectionName)
  if (!collection) {
    logger.warn(`[itunes] collectionId ${collectionId} 未找到专辑`)
    return null
  }
  const tracks = results
    .filter(r => r.kind === 'song' && r.trackName)
    .sort((a, b) => (a.discNumber ?? 1) - (b.discNumber ?? 1) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0))
    .map(r => {
      const title = appleT2S(r.trackName)
      return {
        title,
        titleNorm: title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''),
        secs: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : null,
        disc: r.discNumber ?? 1,
        position: r.trackNumber ?? 0,
      }
    })
  const detail: ItunesAlbumDetail = {
    album: {
      collectionId: String(collection.collectionId ?? collectionId),
      title: appleT2S(collection.collectionName),
      artist: appleT2S(collection.artistName),
      year: collection.releaseDate?.slice(0, 10),
      img: artworkHiRes(collection.artworkUrl100),
      trackCount: collection.trackCount ?? tracks.length,
      copyright: typeof collection.copyright === 'string' ? appleT2S(collection.copyright) : undefined,
    },
    tracks,
  }
  searchCache.set(cacheKey, detail, CACHE_TTL)
  return detail
}

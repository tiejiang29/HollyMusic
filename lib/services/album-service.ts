/**
 * 专辑服务（本地中文专辑库为核心）
 *
 * 架构（2026-09 重构）：
 * - 专辑搜索 = 本地中文专辑库（album-local-service.ts，2.4 万张简体专辑）优先；
 *   本地未命中自动回退网易平台专辑搜索（platformList），保证冷门/外语专辑也能搜到
 * - 专辑详情 = 本地曲目表 → 逐首落歌：
 *   逐首在线搜曲按 tx→kw→kg→mg→wy 顺序（网易搜索通道被翻唱污染放最后），
 *   歌名+歌手+时长三重校验（±8s），并发 4；命中的走搜索同款入库管道（uid 可播）。
 *   单源搜索管线复用 song-search-service 的 searchOneSource（入库/缓存行为与搜索一致）
 * - 在线详情兜底：wy/kw 走平台原生详情端点；mg 无可用端点 → unsupported。
 *   广场卡片把 专辑名+歌手 作为 name/singer 传入即可触发本地优先。
 */

import { searchCache } from '@/lib/cache-manager'
import { logger } from '@/lib/logger'
import type { MusicInfo, Song, SourceType } from '@/lib/types/music'
import { findLocalAlbum, findLocalAlbumByGid, getLocalAlbumTracks, searchLocalAlbums, type LocalAlbumTrack } from '@/lib/services/album-local-service'
import { searchOneSource } from '@/lib/services/song-search-service'
import {
  enrichMusicInfos,
  normalizeCover,
  toKwMusicInfo,
  toWyMusicInfo,
} from '@/lib/services/discovery-service'

const REQUEST_TIMEOUT = 8_000
/** 平台专辑搜索缓存（关键词页级） */
const ALBUM_SEARCH_CACHE_TTL = 30 * 60 * 1000
/** 专辑详情（含已入库曲目）缓存 */
const ALBUM_TRACKS_CACHE_TTL = 60 * 60 * 1000

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export type AlbumSource = 'wy' | 'kw' | 'mg'
export const ALBUM_SOURCES: AlbumSource[] = ['wy', 'kw', 'mg']

export function isAlbumSource(value: string | null): value is AlbumSource {
  return value === 'wy' || value === 'kw' || value === 'mg'
}

export interface AlbumSummary {
  source: AlbumSource
  albumId: string
  name: string
  singer: string
  img?: string | null
  publishTime?: string
  trackCount?: number
}

export interface AlbumDetail {
  album: AlbumSummary
  list: Song[]
}

/** 该源暂不支持专辑曲目（mg 上游端点失效），由路由层转为 unsupported 响应 */
export class AlbumTracksUnsupportedError extends Error {
  constructor(source: AlbumSource) {
    super(`${source} 暂不支持专辑曲目`)
    this.name = 'AlbumTracksUnsupportedError'
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, ...init?.headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  })
  if (!response.ok) throw new Error(`上游请求失败: ${response.status}`)
  return await response.json() as T
}

function formatDate(ms: number | undefined): string | undefined {
  if (!ms) return undefined
  return new Date(ms).toISOString().slice(0, 10)
}

// ==================== 本地专辑详情（主路径） ====================

// 逐首搜曲的源顺序（按搜曲可靠性排序：网易搜索通道被翻唱污染排最后）
const RESOLVE_SOURCE_ORDER: SourceType[] = ['tx', 'kw', 'kg', 'mg', 'wy']

function normText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** 歌手比对：归一化包含（西方名按空格拆 token） */
function singerMatches(singer: string | undefined, artist: string): boolean {
  const s = normText(singer || '')
  const a = normText(artist)
  if (!a) return true
  if (s.includes(a)) return true
  return a.split(/\s+/).filter(t => t.length >= 2).some(t => s.includes(t))
}

/** 时长比对：'mm:ss' 或秒字符串 → 秒，±8s 容差；无时长数据时仅歌手比对兜底 */
function durationMatches(interval: string | undefined, secs: number | null): boolean {
  if (!secs) return true
  const raw = (interval || '').trim()
  if (!raw) return true
  let dur = 0
  if (raw.includes(':')) {
    for (const part of raw.split(':')) dur = dur * 60 + Number(part)
  } else {
    dur = Number(raw)
  }
  if (!Number.isFinite(dur) || dur <= 0) return true
  return Math.abs(dur - secs) <= 8
}

/** 单首曲目跨源搜曲：按 RESOLVE_SOURCE_ORDER 依次尝试，歌名+歌手+时长三重校验 */
async function resolveLocalTrack(track: LocalAlbumTrack, artist: string): Promise<Song | null> {
  const keyword = `${track.title} ${artist}`
  // 有时长数据时时长是主要消歧信号（繁简/异体歌名差异靠它兜住）；
  // 无时长数据（约 22% 曲目）时长无法参与，改为要求候选歌名与曲名有包含关系
  const titleNorm = normText(track.title)
  for (const source of RESOLVE_SOURCE_ORDER) {
    try {
      const result = await searchOneSource(source, keyword, 1, 10)
      const hit = result.list.find(s => {
        if (!singerMatches(s.singer, artist)) return false
        if (track.secs != null) return durationMatches(s.interval, track.secs)
        const candName = normText(s.name || '')
        return !!candName && (candName.includes(titleNorm) || titleNorm.includes(candName))
      })
      if (hit) return hit
    } catch (error) {
      logger.debug(`[album] 逐首搜曲源 ${source} 失败:`, error instanceof Error ? error.message : error)
    }
  }
  return null
}

/** 有界并发池：逐首搜曲并发 4，避免打爆上游 */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++
      results[current] = await fn(items[current])
    }
  })
  await Promise.all(workers)
  return results
}

/** 从落歌结果推导专辑封面：优先歌曲自带封面；tx 副本用 albumId 拼 QQ 专辑封面直链 */
export function albumCoverFromSongs(list: Song[]): string | null {
  for (const s of list) {
    if (s.img) return s.img
    if (s.source === 'tx' && s.albumId) {
      return `https://y.gtimg.cn/music/photo_new/T002R500x500M000${s.albumId}.jpg`
    }
  }
  return null
}

/** 专辑封面探测：取专辑首曲目在 tx 搜一曲（搜索缓存 210min，与详情复用同一缓存键），
 *  推导专辑封面 URL。给专辑卡片列表懒加载封面用。 */
export async function getAlbumCover(gid: string): Promise<string | null> {
  const cacheKey = `album:cover:${gid}`
  // 注意 searchCache.get 未命中返回 null（与"已探测且无封面"不可区分），
  // 因此无封面结果不写缓存——重复探测由 searchOneSource 的搜索缓存兜底，近乎零成本
  const cached = searchCache.get(cacheKey) as string | null
  if (cached) return cached

  const album = findLocalAlbumByGid(gid)
  const tracks = album ? getLocalAlbumTracks(gid) : []
  let img: string | null = null
  const first = tracks[0]
  if (album && first) {
    try {
      const result = await searchOneSource('tx', `${first.title} ${album.artist}`, 1, 5)
      img = albumCoverFromSongs(result.list)
    } catch (error) {
      logger.debug('[album] 封面探测失败:', error instanceof Error ? error.message : error)
    }
  }
  if (img) searchCache.set(cacheKey, img, 24 * 60 * 60 * 1000)
  return img
}

/** 本地专辑倒查：曲目表逐首在线搜曲，返回可播放歌单与专辑元信息（封面从落歌结果推导） */
async function buildLocalAlbumDetail(source: AlbumSource, albumId: string, localTitle: string, localArtist: string, gid: string): Promise<AlbumDetail | null> {
  const tracks = getLocalAlbumTracks(gid)
  if (tracks.length === 0) return null
  const resolved = await mapPool(tracks, 4, track => resolveLocalTrack(track, localArtist))
  const list = resolved.filter((s): s is Song => s !== null)
  if (list.length === 0) {
    logger.warn(`[album] 本地专辑《${localTitle}》逐首匹配全部失败，回退在线详情`)
    return null
  }
  return {
    album: {
      source,
      albumId,
      name: localTitle,
      singer: localArtist,
      img: albumCoverFromSongs(list),
      trackCount: tracks.length,
    },
    list,
  }
}

export interface LocalAlbumDetail {
  album: { gid: string; name: string; singer: string; trackCount: number; img: string | null }
  list: Song[]
}

/** 按 gid 解析本地专辑为可播放歌单（安卓专辑板块详情用） */
export async function getLocalAlbumDetailByGid(gid: string): Promise<LocalAlbumDetail | null> {
  const album = findLocalAlbumByGid(gid)
  if (!album) return null
  const detail = await buildLocalAlbumDetail('mg', gid, album.title, album.artist, album.gid)
  if (!detail) return null
  return {
    album: { gid: album.gid, name: album.title, singer: album.artist, trackCount: album.trackCount ?? detail.list.length, img: detail.album.img ?? null },
    list: detail.list,
  }
}

// ==================== 专辑搜索（本地优先 + 平台兜底） ====================

export interface PlatformAlbumSummary {
  source: AlbumSource
  albumId: string
  name: string
  singer: string
  img?: string | null
  publishTime?: string
  trackCount?: number
}

type WyAlbumCard = {
  id?: number
  name?: string
  picUrl?: string
  size?: number
  publishTime?: number
  artist?: { name?: string }
  artists?: Array<{ name?: string }>
}

/** 网易平台专辑搜索（明文 search/get/web type=10）：本地库未命中时的兜底源，响应与 eapi 通道同构 */
async function searchWyPlatformAlbums(keyword: string, limit: number): Promise<PlatformAlbumSummary[]> {
  const result = await fetchJson<{ code?: number; result?: { albums?: WyAlbumCard[]; albumCount?: number } }>(
    `https://music.163.com/api/search/get/web?s=${encodeURIComponent(keyword)}&type=10&limit=${limit}`,
  )
  if (result.code !== 200 || !result.result) throw new Error('网易专辑搜索失败')
  return (result.result.albums || [])
    .filter(a => a.id && a.name)
    .map(a => ({
      source: 'wy' as const,
      albumId: String(a.id),
      name: a.name || '',
      singer: wyAlbumSinger(a),
      img: normalizeCover(a.picUrl) || null,
      publishTime: formatDate(a.publishTime),
      trackCount: a.size,
    }))
}

/**
 * 专辑搜索（组合）：本地中文专辑库优先；本地未命中自动回退网易平台专辑搜索。
 * 返回 list（本地，gid 卡片）与 platformList（平台卡片，仅本地未命中时非空）。
 */
export async function searchAlbums(keyword: string, limit = 30): Promise<{
  list: Array<{ gid: string; title: string; artist: string; trackCount?: number }>
  platformList: PlatformAlbumSummary[]
}> {
  const k = keyword.trim()
  if (!k) return { list: [], platformList: [] }
  const cacheKey = `album:v3:combined:${k}:${limit}`
  const cached = searchCache.get(cacheKey) as { list: Array<{ gid: string; title: string; artist: string; trackCount?: number }>; platformList: PlatformAlbumSummary[] } | null
  if (cached) return cached

  const list = searchLocalAlbums(k, limit)
  let platformList: PlatformAlbumSummary[] = []
  if (list.length === 0) {
    // 本地未命中 → 平台兜底（失败静默，返回空平台列表）
    try {
      platformList = await searchWyPlatformAlbums(k, limit)
    } catch (error) {
      logger.warn('[album] 平台专辑搜索兜底失败:', error instanceof Error ? error.message : error)
    }
  }
  const result = { list, platformList }
  searchCache.set(cacheKey, result, ALBUM_SEARCH_CACHE_TTL)
  return result
}

// ==================== 在线详情兜底（平台卡片渠道） ====================

type WyArtist = { name?: string }

function wyAlbumSinger(card: { artist?: WyArtist; artists?: WyArtist[] }): string {
  return card.artist?.name || (card.artists || []).map(a => a.name || '').filter(Boolean).join('、') || '未知歌手'
}

async function getWyAlbumTracks(albumId: string): Promise<AlbumDetail> {
  const payload = await fetchJson<{
    code?: number
    album?: { id?: number; name?: string; picUrl?: string; publishTime?: number; artist?: WyArtist; artists?: WyArtist[] }
    songs?: Parameters<typeof toWyMusicInfo>[0][]
  }>(`https://music.163.com/api/v1/album/${encodeURIComponent(albumId)}`, {
    headers: { Referer: 'https://music.163.com/' },
  })
  if (payload.code !== 200 || !payload.album) throw new Error('网易专辑详情获取失败')

  const album = payload.album
  const musicInfos = (payload.songs || []).map(toWyMusicInfo).filter((m): m is MusicInfo => m !== null)
  const list = await enrichMusicInfos(musicInfos)
  return {
    album: {
      source: 'wy',
      albumId: album.id ? String(album.id) : albumId,
      name: album.name || '',
      singer: wyAlbumSinger(album),
      img: normalizeCover(album.picUrl) || null,
      publishTime: formatDate(album.publishTime),
      trackCount: list.length,
    },
    list,
  }
}

type KwNuxtSong = {
  id?: string | number
  musicrid?: string | number
  name?: string
  songname?: string
  artist?: string
  album?: string
  albumId?: string | number
  duration?: string | number
  formats?: string
}

/**
 * 提取并求值酷我 SSR 页的 window.__NUXT__ 载荷（自执行函数表达式）。
 * NUXT 载荷字符串全部为双引号 + \uXXXX 转义，按双引号串处理即可安全括号配平。
 */
function extractKwNuxtPayload(html: string): unknown {
  const match = /window\.__NUXT__\s*=\s*/.exec(html)
  if (!match) throw new Error('酷我专辑页无数据')
  const start = match.index + match[0].length
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < html.length; i++) {
    const c = html[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') {
      depth--
      if (depth === 0) {
        // 载荷是酷我自家 SSR 生成的自包含表达式，非用户输入
        return new Function(`return ${html.slice(start, i + 1)}`)()
      }
    }
  }
  throw new Error('酷我专辑页数据解析失败')
}

async function getKwAlbumTracks(albumId: string): Promise<AlbumDetail> {
  const response = await fetch(`https://www.kuwo.cn/album/${encodeURIComponent(albumId)}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  })
  if (!response.ok) throw new Error(`酷我专辑页请求失败: ${response.status}`)
  const html = await response.text()
  const data = extractKwNuxtPayload(html) as {
    data?: Array<{
      albumInfo?: {
        albumid?: string | number
        name?: string
        artist?: string
        img?: string
        hts_img?: string
        pub?: string
        songnum?: number
        musiclist?: KwNuxtSong[]
      }
    }>
  }
  const info = data.data?.[0]?.albumInfo
  if (!info) throw new Error('酷我专辑数据缺失')

  const musicInfos = (info.musiclist || [])
    .map(raw => toKwMusicInfo({
      id: raw.id ?? raw.musicrid,
      name: raw.name || raw.songname || '',
      artist: raw.artist || '',
      album: raw.album || info.name || '',
      albumid: raw.albumId ?? info.albumid,
      duration: raw.duration,
      formats: raw.formats || '',
    }))
    .filter((m): m is MusicInfo => m !== null)
  const list = await enrichMusicInfos(musicInfos)
  return {
    album: {
      source: 'kw',
      albumId: info.albumid != null ? String(info.albumid) : albumId,
      name: info.name || '',
      singer: info.artist || '未知歌手',
      img: normalizeCover(info.img || info.hts_img) || null,
      publishTime: info.pub || undefined,
      trackCount: info.songnum ?? list.length,
    },
    list,
  }
}

const albumTrackFetchers: Partial<Record<AlbumSource, (albumId: string) => Promise<AlbumDetail>>> = {
  wy: getWyAlbumTracks,
  kw: getKwAlbumTracks,
  // mg 暂无可用专辑曲目端点，缺省 → AlbumTracksUnsupportedError
}

/** 专辑曲目详情。默认本地专辑库优先（曲目表逐首在线搜曲），本地未命中回退平台详情。 */
export interface AlbumTracksOptions {
  /** 广场卡片上的专辑名/歌手——本地库匹配用，缺省时直接走在线详情 */
  name?: string
  singer?: string
}

export async function getAlbumTracks(source: AlbumSource, albumId: string, opts: AlbumTracksOptions = {}): Promise<AlbumDetail> {
  const name = opts.name?.trim() || ''
  const singer = opts.singer?.trim() || ''
  const cacheKey = `album:v5:tracks:${source}:${albumId}:${name}:${singer}`
  const cached = searchCache.get(cacheKey) as AlbumDetail | undefined
  if (cached) return cached

  // 本地专辑库优先：卡片名+歌手命中 → 曲目表逐首搜曲（构造可播歌单）
  if (name && singer) {
    try {
      const localAlbum = findLocalAlbum(name, singer)
      if (localAlbum) {
        const detail = await buildLocalAlbumDetail(source, albumId, localAlbum.title, localAlbum.artist, localAlbum.gid)
        if (detail) {
          searchCache.set(cacheKey, detail, ALBUM_TRACKS_CACHE_TTL)
          return detail
        }
        logger.warn(`[album] 本地专辑《${localAlbum.title}》逐首匹配失败，回退在线详情`)
      }
    } catch (error) {
      logger.warn('[album] 本地专辑倒查失败，回退在线详情:', error instanceof Error ? error.message : error)
    }
  }

  // 在线兜底：wy/kw 有原生详情端点；mg 无（上游失效）→ unsupported
  const fetcher = albumTrackFetchers[source]
  if (!fetcher) throw new AlbumTracksUnsupportedError(source)

  const detail = await fetcher(albumId)
  if (detail.list.length > 0) {
    searchCache.set(`album:v5:tracks:${source}:${albumId}::`, detail, ALBUM_TRACKS_CACHE_TTL)
  }
  return detail
}

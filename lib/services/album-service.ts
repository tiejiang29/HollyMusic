/**
 * 专辑搜索与专辑详情服务（平台能力，遵循 music-core/AGENTS.md：平台适配一律用 TypeScript）
 *
 * 一期覆盖 wy / kw / mg（tx/kg 二期逆向后接入）：
 * - wy 专辑搜索：eapi cloudsearch/pc type=10（与歌曲搜索同一通道，仅换 type）
 *   wy 专辑曲目：明文 GET music.163.com/api/v1/album/{id}（songs 实体与 cloudsearch 同构，
 *   直接复用 discovery-service 的 toWyMusicInfo）
 * - kw 专辑搜索：r.s 歌曲搜索按 ALBUMID 聚合（www.kuwo.cn/api/www 系列被反爬拦截，
 *   csrf/kw_token 方案实测均返回 "The request is illegal!"，聚合是当前唯一可行方案）
 *   kw 专辑曲目：GET www.kuwo.cn/album/{id} 服务端渲染页，window.__NUXT__ 为自执行函数
 *   表达式，Node 内 new Function 求值后取 data[0].albumInfo.musiclist（实测含全量字段）
 * - mg 专辑搜索：searchAll 接口 searchSwitch 打开 album 开关（与歌曲搜索同一端点同签名；
 *   注意专辑数据在 albumResultData.result，扁平数组，id 字段名为 id）
 *   mg 专辑曲目：暂不支持——remoting/album_detail_api 系列已全部失效（SPA 壳/路由不支持），
 *   一期只出卡片，详情返回 unsupported
 */

import { createCipheriv, createHash } from 'crypto'
import { searchCache } from '@/lib/cache-manager'
import { logger } from '@/lib/logger'
import type { MusicInfo, Song } from '@/lib/types/music'
import { kw as kwSongSearch } from '@/lib/music-core/music-search'
import {
  enrichMusicInfos,
  normalizeCover,
  normalizeMgCover,
  toKwMusicInfo,
  toWyMusicInfo,
} from '@/lib/services/discovery-service'

const REQUEST_TIMEOUT = 8_000
/** 专辑搜索卡片缓存（关键词页级） */
const ALBUM_SEARCH_CACHE_TTL = 30 * 60 * 1000
/** 专辑详情（含已入库曲目）缓存 */
const ALBUM_TRACKS_CACHE_TTL = 60 * 60 * 1000

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const MG_UA = 'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30'

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
  /** 发行日期（YYYY-MM-DD，取不到时缺省） */
  publishTime?: string
  /** 曲目数（kw 聚合来源时为该页命中数，仅参考） */
  trackCount?: number
}

export interface AlbumDetail {
  album: AlbumSummary
  list: Song[]
}

/** 该源暂不支持专辑曲目（卡片可搜，详情待上游端点），由路由层转为 unsupported 响应 */
export class AlbumTracksUnsupportedError extends Error {
  constructor(source: AlbumSource) {
    super(`${source} 暂不支持专辑曲目`)
    this.name = 'AlbumTracksUnsupportedError'
  }
}

export interface AlbumSearchResult {
  list: AlbumSummary[]
  total: number
  page: number
  allPage: number
  limit: number
  source: AlbumSource | 'all'
  /** all 模式下失败的源 */
  failedSources?: AlbumSource[]
}

// ==================== 通用 HTTP ====================

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

// ==================== 网易云（wy） ====================

// 与 lib/music-core/wy-eapi.js 一致的 eapi 加密（TS 版）
const WY_EAPI_KEY = 'e82ckenh8dichen8'

function wyEapi(apiPath: string, object: unknown): string {
  const text = JSON.stringify(object)
  const message = `nobody${apiPath}use${text}md5forencrypt`
  const digest = createHash('md5').update(message).digest('hex')
  const data = `${apiPath}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(WY_EAPI_KEY), null)
  return Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]).toString('hex').toUpperCase()
}

type WyArtist = { name?: string }
type WyAlbumCard = {
  id?: number
  name?: string
  picUrl?: string
  size?: number
  publishTime?: number
  artist?: WyArtist
  artists?: WyArtist[]
}

function wyAlbumSinger(card: { artist?: WyArtist; artists?: WyArtist[] }): string {
  return card.artist?.name || (card.artists || []).map(a => a.name || '').filter(Boolean).join('、') || '未知歌手'
}

async function searchWyAlbums(keyword: string, page: number, limit: number): Promise<{ list: AlbumSummary[]; total: number }> {
  // 与歌曲搜索同一 eapi 通道（music-search.js wySearch），type=10 即专辑
  const apiPath = '/api/cloudsearch/pc'
  const params = wyEapi(apiPath, { s: keyword, type: 10, limit, total: page === 1, offset: limit * (page - 1) })
  const result = await fetchJson<{ code?: number; result?: { albums?: WyAlbumCard[]; albumCount?: number } }>(
    'http://interface.music.163.com/eapi/batch',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://music.163.com',
        'Referer': 'https://music.163.com/',
      },
      body: new URLSearchParams({ params }).toString(),
    },
  )
  if (result.code !== 200 || !result.result) throw new Error('网易专辑搜索失败')

  const albums = (result.result.albums || []).filter(a => a.id && a.name)
  return {
    total: result.result.albumCount || 0,
    list: albums.map(a => ({
      source: 'wy' as const,
      albumId: String(a.id),
      name: a.name || '',
      singer: wyAlbumSinger(a),
      img: normalizeCover(a.picUrl) || null,
      publishTime: formatDate(a.publishTime),
      trackCount: a.size,
    })),
  }
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

// ==================== 酷我（kw） ====================

/**
 * kw 专辑搜索：r.s 歌曲搜索按 ALBUMID 聚合出专辑卡片。
 * 无直接专辑搜索端点可用（www API 反爬、r.s ft=album 恒空），聚合页内命中数仅作排序参考。
 */
async function searchKwAlbums(keyword: string, page: number, limit: number): Promise<{ list: AlbumSummary[]; total: number }> {
  const result = await kwSongSearch.search(keyword, page, limit)
  const groups = new Map<string, AlbumSummary>()
  for (const song of result.list) {
    const albumId = song.albumId ? String(song.albumId) : ''
    if (!albumId || !song.albumName) continue
    const existing = groups.get(albumId)
    if (existing) {
      existing.trackCount = (existing.trackCount || 0) + 1
      continue
    }
    groups.set(albumId, {
      source: 'kw',
      albumId,
      name: song.albumName,
      singer: song.singer || '未知歌手',
      img: null,
      trackCount: 1,
    })
  }
  const list = [...groups.values()].sort((a, b) => (b.trackCount || 0) - (a.trackCount || 0))
  return { list, total: result.total || list.length }
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

// ==================== 咪咕（mg） ====================

// 与 music-search.js createMgSignature 一致（同一端点必须同一签名口径）
function mgSignature(time: string, keyword: string): { sign: string; deviceId: string } {
  const deviceId = '963B7AA0D21511ED807EE5846EC87D20'
  const sign = createHash('md5')
    .update(`${keyword}6cdc72a439cef99a3418d2a78aa28c73yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`)
    .digest('hex')
  return { sign, deviceId }
}

type MgAlbumCard = {
  id?: string | number
  name?: string
  singer?: string
  publishDate?: string
  imgItems?: Array<{ img?: string; imgSizeType?: string }>
}

function pickMgAlbumImg(card: MgAlbumCard): string | undefined {
  const items = card.imgItems || []
  return items.find(i => i.imgSizeType === '03')?.img
    || items[items.length - 1]?.img
    || items[0]?.img
}

async function searchMgAlbums(keyword: string, page: number, limit: number): Promise<{ list: AlbumSummary[]; total: number }> {
  const time = Date.now().toString()
  const { sign, deviceId } = mgSignature(time, keyword)
  // 与歌曲搜索同一 searchAll 端点，searchSwitch 打开 album、关闭 song
  const searchSwitch = encodeURIComponent(JSON.stringify({ song: 0, album: 1, singer: 0, tagSong: 0, mvSong: 0, bestShow: 0, songlist: 0, lyricSong: 0 }))
  const url = `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=${searchSwitch}&pageSize=${limit}&text=${encodeURIComponent(keyword)}&pageNo=${page}&sort=0&sid=USS`
  const result = await fetchJson<{ code?: string; albumResultData?: { totalCount?: string | number; result?: MgAlbumCard[] } }>(url, {
    headers: {
      uiVersion: 'A_music_3.6.1',
      deviceId,
      timestamp: time,
      sign,
      channel: '0146921',
      'User-Agent': MG_UA,
    },
  })
  if (result.code !== '000000' || !result.albumResultData) throw new Error('咪咕专辑搜索失败')

  // 注意：专辑数据在 albumResultData.result（扁平数组），与歌曲搜索的 resultList 二维数组不同
  const cards = (result.albumResultData.result || []).filter(c => c.id && c.name)
  return {
    total: Number(result.albumResultData.totalCount) || 0,
    list: cards.map(c => ({
      source: 'mg' as const,
      albumId: String(c.id),
      name: c.name || '',
      singer: c.singer || '未知歌手',
      img: normalizeMgCover(pickMgAlbumImg(c)) || null,
      publishTime: c.publishDate || undefined,
    })),
  }
}

// ==================== 统一入口 ====================

const albumSearchers: Record<AlbumSource, (keyword: string, page: number, limit: number) => Promise<{ list: AlbumSummary[]; total: number }>> = {
  wy: searchWyAlbums,
  kw: searchKwAlbums,
  mg: searchMgAlbums,
}

const albumTrackFetchers: Partial<Record<AlbumSource, (albumId: string) => Promise<AlbumDetail>>> = {
  wy: getWyAlbumTracks,
  kw: getKwAlbumTracks,
  // mg 暂无可用专辑曲目端点，缺省 → AlbumTracksUnsupportedError
}

/** 专辑搜索（单源或三源汇聚）。卡片不入库；曲目在专辑详情时才落库。 */
export async function searchAlbums(
  source: AlbumSource | 'all',
  keyword: string,
  page = 1,
  limit = 20,
): Promise<AlbumSearchResult> {
  const cacheKey = `album:v1:search:${source}:${keyword}:${page}:${limit}`
  const cached = searchCache.get(cacheKey) as AlbumSearchResult | undefined
  if (cached) return cached

  if (source !== 'all') {
    const result = await albumSearchers[source](keyword, page, limit)
    const enriched: AlbumSearchResult = {
      list: result.list,
      total: result.total,
      page,
      allPage: Math.ceil(result.total / limit),
      limit,
      source,
    }
    searchCache.set(cacheKey, enriched, ALBUM_SEARCH_CACHE_TTL)
    return enriched
  }

  // 三源汇聚：allSettled 按固定源顺序拼接，失败源跳过并透出
  const settled = await Promise.allSettled(
    ALBUM_SOURCES.map(s => albumSearchers[s](keyword, page, limit)),
  )
  const okLists: AlbumSummary[][] = []
  const failedSources: AlbumSource[] = []
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') okLists.push(r.value.list)
    else {
      failedSources.push(ALBUM_SOURCES[i])
      logger.warn(`[album] 源 ${ALBUM_SOURCES[i]} 专辑搜索失败:`, r.reason instanceof Error ? r.reason.message : r.reason)
    }
  })
  if (okLists.length === 0) throw new Error('所有音源专辑搜索失败')

  const list = okLists.flat()
  const total = settled.reduce((sum, r) => sum + (r.status === 'fulfilled' ? r.value.total : 0), 0)
  const merged: AlbumSearchResult = {
    list,
    total,
    page,
    allPage: Math.max(1, ...settled.map(r => r.status === 'fulfilled' ? Math.ceil(r.value.total / limit) : 1)),
    limit,
    source: 'all',
    ...(failedSources.length > 0 ? { failedSources } : {}),
  }
  searchCache.set(cacheKey, merged, ALBUM_SEARCH_CACHE_TTL)
  return merged
}

/** 专辑曲目详情。曲目走搜索同款入库管道（upsert + uid），播放/下载/收藏直接可用。 */
export async function getAlbumTracks(source: AlbumSource, albumId: string): Promise<AlbumDetail> {
  const fetcher = albumTrackFetchers[source]
  if (!fetcher) throw new AlbumTracksUnsupportedError(source)

  const cacheKey = `album:v1:tracks:${source}:${albumId}`
  const cached = searchCache.get(cacheKey) as AlbumDetail | undefined
  if (cached) return cached

  const detail = await fetcher(albumId)
  if (detail.list.length > 0) {
    searchCache.set(cacheKey, detail, ALBUM_TRACKS_CACHE_TTL)
  }
  return detail
}

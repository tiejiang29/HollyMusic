/**
 * 专辑服务（本地中文专辑库为核心）
 *
 * 架构（2026-09 重构）：
 * - 专辑搜索 = 本地中文专辑库（album-local-service.ts，2.4 万张简体专辑）优先；
 *   本地未命中自动回退 Apple 专辑搜索（platformList，iTunes Search API country=tw，
 *   返回数据经 OpenCC 转简体），保证冷门/外语专辑也能搜到
 * - 专辑详情 = 本地曲目表 → 逐首落歌：
 *   逐首在线搜曲按 tx→kw→kg→mg→wy 顺序（网易搜索通道被翻唱污染放最后），
 *   歌名+歌手+时长三重校验（±8s），并发 4；命中的走搜索同款入库管道（uid 可播）。
 *   单源搜索管线复用 song-search-service 的 searchOneSource（入库/缓存行为与搜索一致）
 * - 元数据增强：Apple 歌手级索引（一次调用拿该歌手全部专辑）补年份 + 600x600 高清封面
 *   （mzstatic CDN，218ms 实测），按歌手缓存 24h；失败静默不影响主流程
 */

import { searchCache } from '@/lib/cache-manager'
import { logger } from '@/lib/logger'
import { prisma, getStorageSongmidForMusicInfo } from '@/lib/db'
import { songIdentity } from '@/lib/song-identity'
import type { MusicInfo, Song, SourceType } from '@/lib/types/music'
import { findLocalAlbumByGid, getLocalAlbumTracks, searchLocalAlbums, type LocalAlbumTrack } from '@/lib/services/album-local-service'
import { searchOneSource } from '@/lib/services/song-search-service'
import { appleT2S, getArtistAlbumIndex, getItunesAlbumDetail, getItunesArtistSongs, searchItunesAlbums } from '@/lib/services/itunes-service'
import { getWikiExtract, getArtistProfile, getAlbumProfile, type ArtistProfile, type AlbumProfile } from '@/lib/services/wiki-service'

/** 专辑详情（含已入库曲目）缓存 */
const ALBUM_TRACKS_CACHE_TTL = 60 * 60 * 1000

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

/** 本地音乐库优先：identity 同款歌命中直接返回库内条目（零上游成本，毫秒级）。
 *  与换源接口 findLocalAlternatives 同一套机制（MusicInfo.identity 分组键）。
 *  双 identity 尝试：妳→你 变体在前（平台入库曲名多为"你"），原样在后（兼容存量行）。 */
async function resolveFromLocalLibrary(title: string, artist: string): Promise<Song | null> {
  const identityVariant = songIdentity({ name: title.replace(/妳/g, '你'), singer: artist })
  const identityRaw = songIdentity({ name: title, singer: artist })
  if (identityVariant === '|' && identityRaw === '|') return null
  try {
    const row = (await prisma.musicInfo.findFirst({ where: { identity: identityVariant } }))
      ?? (identityVariant !== identityRaw
        ? await prisma.musicInfo.findFirst({ where: { identity: identityRaw } })
        : null)
    if (!row) return null
    const mi = JSON.parse(row.data ?? '') as MusicInfo
    return { ...mi, uid: `${mi.source}-${getStorageSongmidForMusicInfo(mi)}` }
  } catch (error) {
    logger.debug('[album] 本地库 identity 查询失败（跳过）:', error instanceof Error ? error.message : error)
    return null
  }
}

/** 单首曲目跨源搜曲：本地库 identity 优先 → 在线按 RESOLVE_SOURCE_ORDER 依次尝试。
 *  候选校验（三重，歌名始终参与）：歌手归一化匹配 + 歌名简繁归一双向包含 + 时长 ±8s
 *  （无时长数据时歌名+歌手即通过）。带专辑上下文时优先取 albumName 一致的专辑版本，
 *  平台只收单曲版本时回退首个通过校验的候选（同一首歌、不同发行）。 */
async function resolveLocalTrack(track: LocalAlbumTrack, artist: string, albumTitle?: string): Promise<Song | null> {
  const localFit = await resolveFromLocalLibrary(track.title, artist)
  if (localFit) return localFit

  const keyword = `${track.title} ${artist}`
  // 歌名归一化：OpenCC 简繁 + 妳→你（异体字 OpenCC 不转，"妳听得到/你听得到"会一字之差漏配）
  const normalizeName = (v: string | null | undefined) => normText(appleT2S(v || '').replace(/妳/g, '你'))
  const titleNorm = normalizeName(track.title)
  const albumNorm = albumTitle ? normalizeName(albumTitle) : null
  const passes = (s: Song) => {
    if (!singerMatches(s.singer, artist)) return false
    const candName = normalizeName(s.name)
    if (!candName || (!candName.includes(titleNorm) && !titleNorm.includes(candName))) return false
    if (track.secs != null) return durationMatches(s.interval, track.secs)
    return true
  }
  for (const source of RESOLVE_SOURCE_ORDER) {
    try {
      const result = await searchOneSource(source, keyword, 1, 10)
      const candidates = result.list.filter(passes)
      if (candidates.length === 0) continue
      if (albumNorm) {
        const albumHit = candidates.find(s => {
          const candAlbum = normalizeName(s.albumName)
          return !!candAlbum && (candAlbum.includes(albumNorm) || albumNorm.includes(candAlbum))
        })
        if (albumHit) return albumHit
      }
      return candidates[0]
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

export interface AlbumDetail {
  album: { source: string; albumId: string; name: string; singer: string; img?: string | null; publishTime?: string; trackCount?: number; bio?: string | null; profile?: AlbumProfile | null }
  list: Song[]
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

/** Apple 元数据（年份 + 高清封面）：按歌手索引匹配本地专辑，失败/未收录返回空对象 */
async function getAppleAlbumMeta(
  title: string,
  artist: string,
): Promise<{ img: string | null; year?: string }> {
  try {
    const index = await getArtistAlbumIndex(artist)
    const key = normText(title)
    const hit = index.get(key)
      ?? [...index.entries()].find(([name]) => name.includes(key) || key.includes(name))?.[1]
    if (!hit) return { img: null }
    return { img: hit.img, year: hit.year }
  } catch (error) {
    logger.debug('[album] Apple 元数据获取失败（跳过）:', error instanceof Error ? error.message : error)
    return { img: null }
  }
}

/** 封面图床白名单（服务端中转只抓这些域） */
const COVER_IMAGE_DOMAINS = [
  /^https:\/\/[a-z0-9-]+\.mzstatic\.com\//i,        // Apple 封面 CDN
  /^https:\/\/y\.gtimg\.cn\//i,                     // QQ 专辑封面
  /^https?:\/\/[a-z0-9]+\.music\.126\.net\//i,     // 网易封面
  /^https:\/\/img[0-9]*\.kwcdn\.kuwo\.cn\//i,      // 酷我封面
  /^https:\/\/d\.musicapp\.migu\.cn\//i,           // 咪咕封面
]

export interface CoverImageBytes {
  bytes: ArrayBuffer
  contentType: string
}

/** 服务端抓取封面字节（带 24h 缓存，转发给前端——前端不再直连图床）。 */
export async function fetchCoverImageBytes(imageUrl: string): Promise<CoverImageBytes | null> {
  if (!COVER_IMAGE_DOMAINS.some(re => re.test(imageUrl))) return null
  const cacheKey = `album:imgbytes:${imageUrl}`
  const cached = searchCache.get(cacheKey) as CoverImageBytes | null
  if (cached) return cached
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    try {
      const resp = await fetch(imageUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        redirect: 'follow',
      })
      if (!resp.ok) return null
      const contentType = resp.headers.get('content-type') || 'image/jpeg'
      if (!contentType.startsWith('image/')) return null
      const bytes = await resp.arrayBuffer()
      if (bytes.byteLength === 0 || bytes.byteLength > 5 * 1024 * 1024) return null
      const result: CoverImageBytes = { bytes, contentType }
      searchCache.set(cacheKey, result, 24 * 60 * 60 * 1000)
      return result
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    logger.debug('[album] 封面字节获取失败（静默）:', error instanceof Error ? error.message : error)
    return null
  }
}

/** 专辑封面探测（专辑卡片懒加载）：优先 Apple 高清封面，未收录回退 tx 首曲目搜曲推导 gtimg */
export async function getAlbumCover(gid: string): Promise<string | null> {
  const cacheKey = `album:cover:${gid}`
  // 注意 searchCache.get 未命中返回 null（与"已探测且无封面"不可区分），
  // 因此无封面结果不写缓存——重复探测由 searchOneSource 的搜索缓存兜底，近乎零成本
  const cached = searchCache.get(cacheKey) as string | null
  if (cached) return cached

  const album = findLocalAlbumByGid(gid)
  let img: string | null = null
  if (album) {
    // ① Apple：歌手专辑索引按专辑名匹配 → 600x600 高清
    const apple = await getAppleAlbumMeta(album.title, album.artist).catch(() => ({ img: null as string | null }))
    img = apple.img ?? null
  }
  // ② 回退：首曲目在 tx 搜曲推导 gtimg 直链
  if (!img && album) {
    const tracks = getLocalAlbumTracks(gid)
    const first = tracks[0]
    if (first) {
      try {
        const result = await searchOneSource('tx', `${first.title} ${album.artist}`, 1, 5)
        img = albumCoverFromSongs(result.list)
      } catch (error) {
        logger.debug('[album] 封面探测失败:', error instanceof Error ? error.message : error)
      }
    }
  }
  if (img) searchCache.set(cacheKey, img, 24 * 60 * 60 * 1000)
  return img
}

/** 本地专辑倒查：曲目表逐首在线搜曲，返回可播放歌单与专辑元信息（年份/封面由 Apple 增强） */
async function buildLocalAlbumDetail(localTitle: string, localArtist: string, gid: string): Promise<AlbumDetail | null> {
  const tracks = getLocalAlbumTracks(gid)
  if (tracks.length === 0) return null
  const resolved = await mapPool(tracks, 4, track => resolveLocalTrack(track, localArtist, localTitle))
  const list = resolved.filter((s): s is Song => s !== null)
  if (list.length === 0) {
    logger.warn(`[album] 本地专辑《${localTitle}》逐首匹配全部失败`)
    return null
  }
  // Apple 增强（缓存命中时近零成本；失败静默）
  const apple = await getAppleAlbumMeta(localTitle, localArtist).catch(() => ({ img: null as string | null, year: undefined as string | undefined }))
  const bio = await getWikiExtract(localTitle, 'album').catch(() => null)
  const profile = await getAlbumProfile(localTitle, gid).catch(() => null)
  return {
    album: {
      source: 'local',
      albumId: gid,
      name: localTitle,
      singer: localArtist,
      img: apple.img ?? albumCoverFromSongs(list),
      publishTime: apple.year,
      trackCount: tracks.length,
      bio,
      profile,
    },
    list,
  }
}

export interface LocalAlbumDetail {
  album: { gid: string; name: string; singer: string; trackCount: number; img: string | null; year?: string; bio?: string | null; profile?: AlbumProfile | null }
  list: Song[]
}

/** 按 gid 解析本地专辑为可播放歌单（安卓专辑板块详情用） */
export async function getLocalAlbumDetailByGid(gid: string): Promise<LocalAlbumDetail | null> {
  const album = findLocalAlbumByGid(gid)
  if (!album) return null
  const detail = await buildLocalAlbumDetail(album.title, album.artist, album.gid)
  if (!detail) return null
  return {
    album: {
      gid: album.gid,
      name: album.title,
      singer: album.artist,
      trackCount: album.trackCount ?? detail.list.length,
      img: detail.album.img ?? null,
      year: detail.album.publishTime,
      bio: detail.album.bio ?? null,
      profile: detail.album.profile ?? null,
    },
    list: detail.list,
  }
}

// ==================== 歌手详情（Apple） ====================

export interface ArtistAlbumCard {
  source: 'apple'
  albumId: string
  name: string
  artist: string
  year?: string
  img: string | null
  trackCount?: number
}

export interface AppleArtistDetail {
  artist: {
    artistId: string
    name: string
    genre?: string
    /** 维基简介（简体，best-effort：未配置 WIKI_PROXY_URL 或条目不存在时缺省） */
    bio?: string | null
    /** Wikidata 结构化档案（出生/职业/流派/唱片公司，best-effort） */
    profile?: ArtistProfile | null
    /** 头像（Apple 歌手实体无照片，取首张专辑封面） */
    img: string | null
  }
  /** 热门歌曲（Apple 热门度排序，本地库优先落歌，可播） */
  hotSongs: Song[]
  /** 专辑卡片（点进走 /api/album/apple/tracks） */
  albums: ArtistAlbumCard[]
}

/** Apple 歌手详情：热门歌（本地优先落歌）+ 专辑列表 + 维基简介。结果缓存 1h。 */
export async function getAppleArtistDetail(artistId: string): Promise<AppleArtistDetail | null> {
  const cacheKey = `album:v1:artist:${artistId}`
  const cached = searchCache.get(cacheKey) as AppleArtistDetail | null
  if (cached) return cached

  const info = await getItunesArtistSongs(artistId)
  if (!info) return null

  // 热门歌：本地库 identity 优先 → 在线五源（与专辑详情同一落歌管道）
  const resolved = await mapPool(info.songs, 4, song =>
    resolveLocalTrack({ title: song.title, titleNorm: song.titleNorm, secs: song.secs, disc: 1, position: 0 }, info.name))
  const hotSongs = resolved.filter((x): x is Song => x !== null)

  // 专辑列表（复用歌手专辑索引，缓存 24h）
  const index = await getArtistAlbumIndex(info.name)
  const albums: ArtistAlbumCard[] = [...index.entries()].map(([title, meta]) => ({
    source: 'apple' as const,
    albumId: meta.collectionId,
    name: title,
    artist: info.name,
    year: meta.year,
    img: meta.img ?? null,
    trackCount: undefined,
  }))

  // 头像 = 首张专辑封面（Apple 歌手实体无照片）
  const img = albums.find(a => a.img)?.img ?? null
  const bio = await getWikiExtract(info.name, 'artist').catch(() => null)
  const profile = await getArtistProfile(info.name).catch(() => null)

  const detail: AppleArtistDetail = {
    artist: { artistId: info.artistId, name: info.name, genre: info.genre, bio, profile, img },
    hotSongs,
    albums,
  }
  searchCache.set(cacheKey, detail, ALBUM_TRACKS_CACHE_TTL)
  return detail
}

// ==================== 专辑搜索（本地优先 + Apple 兜底） ====================

export interface PlatformAlbumSummary {
  /** 固定 'apple' */
  source: 'apple'
  /** Apple collectionId */
  albumId: string
  name: string
  singer: string
  img?: string | null
  year?: string
  trackCount?: number
}

/**
 * 专辑搜索（组合）：本地中文专辑库优先；本地未命中自动回退 Apple 专辑搜索。
 * 返回 list（本地，gid 卡片）与 platformList（Apple 卡片，仅本地未命中时非空）。
 */
export async function searchAlbums(keyword: string, limit = 30): Promise<{
  list: Array<{ gid: string; title: string; artist: string; trackCount?: number }>
  platformList: Array<{ source: 'apple'; albumId: string; name: string; singer: string; img?: string | null; year?: string; trackCount?: number }>
}> {
  const k = keyword.trim()
  if (!k) return { list: [], platformList: [] }
  const cacheKey = `album:v4:combined:${k}:${limit}`
  const cached = searchCache.get(cacheKey) as { list: Array<{ gid: string; title: string; artist: string; trackCount?: number }>; platformList: Array<{ source: 'apple'; albumId: string; name: string; singer: string; img?: string | null; year?: string; trackCount?: number }> } | null
  if (cached) return cached

  const list = searchLocalAlbums(k, limit)
  let platformList: Array<{ source: 'apple'; albumId: string; name: string; singer: string; img?: string | null; year?: string; trackCount?: number }> = []
  if (list.length === 0) {
    // 本地未命中 → Apple 兜底（失败静默，返回空平台列表）
    try {
      platformList = (await searchItunesAlbums(k, limit)).map(c => ({
        source: 'apple' as const,
        albumId: c.collectionId,
        name: c.title,
        singer: c.artist,
        img: c.img,
        year: c.year,
        trackCount: c.trackCount,
      }))
    } catch (error) {
      logger.warn('[album] Apple 专辑搜索兜底失败:', error instanceof Error ? error.message : error)
    }
  }
  const result = { list, platformList }
  searchCache.set(cacheKey, result, ALBUM_TRACKS_CACHE_TTL)
  return result
}

// ==================== Apple 专辑详情（平台卡片渠道） ====================

export interface AppleAlbumDetail {
  album: { name: string; singer: string; year?: string; img: string | null; trackCount: number; collectionId: string; bio?: string | null; profile?: AlbumProfile | null }
  list: Song[]
}

/** Apple 专辑卡片详情：Apple 曲目表（繁→简）→ 逐首在线搜曲落歌（与本地专辑同一管道） */
export async function getAppleAlbumDetail(collectionId: string): Promise<AppleAlbumDetail | null> {
  const cacheKey = `album:v1:apple:${collectionId}`
  const cached = searchCache.get(cacheKey) as AppleAlbumDetail | null
  if (cached) return cached

  const itunes = await getItunesAlbumDetail(collectionId)
  if (!itunes || itunes.tracks.length === 0) return null

  const resolved = await mapPool(itunes.tracks, 4, track =>
    resolveLocalTrack({ title: track.title, titleNorm: track.titleNorm, secs: track.secs, disc: track.disc, position: track.position }, itunes.album.artist, itunes.album.title))
  const list = resolved.filter((s): s is Song => s !== null)
  if (list.length === 0) {
    logger.warn(`[album] Apple 专辑《${itunes.album.title}》逐首匹配全部失败`)
    return null
  }

  const bio = await getWikiExtract(itunes.album.title, 'album').catch(() => null)
  const profile = await getAlbumProfile(itunes.album.title).catch(() => null)
  const detail: AppleAlbumDetail = {
    album: {
      collectionId,
      name: itunes.album.title,
      singer: itunes.album.artist,
      year: itunes.album.year,
      img: itunes.album.img ?? albumCoverFromSongs(list),
      trackCount: itunes.tracks.length,
      bio,
      profile,
    },
    list,
  }
  searchCache.set(cacheKey, detail, ALBUM_TRACKS_CACHE_TTL)
  return detail
}

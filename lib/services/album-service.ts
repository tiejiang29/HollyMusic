/**
 * 专辑服务（平台链为核心）
 *
 * 架构（2026-09 调整）：
 * - 专辑搜索 = 平台编排链 TX → 酷我 → 咪咕 → Apple（source-chain.searchAlbumCardsChain）；
 *   原本地 MusicBrainz 专辑索引（album-db）已下线，不再参与专辑搜索与详情
 * - 专辑详情 = 各平台原生链（/api/album/{tx,kw,mg,apple}/tracks），Apple 走 amp + iTunes
 * - 元数据增强：Apple 歌手级索引（一次调用拿该歌手全部专辑）补年份 + 600x600 高清封面
 *   （mzstatic CDN，218ms 实测），按歌手缓存 24h；失败静默不影响主流程
 */

import { searchCache } from '@/lib/cache-manager'
import { logger } from '@/lib/logger'
import { prisma, getStorageSongmidForMusicInfo, upsertMusicInfosInTransaction } from '@/lib/db'
import { songIdentity } from '@/lib/song-identity'
import type { MusicInfo, Song, SourceType } from '@/lib/types/music'
import { searchOneSource } from '@/lib/services/song-search-service'
import { batchResolveAndUpsert } from '@/lib/services/batch-resolve'
import { getArtistAlbumIndex, getArtistAlbumsById, getItunesAlbumDetail, getItunesArtistSongs, searchItunesArtists, searchItunesAlbums, appleT2S } from '@/lib/services/itunes-service'
import { searchKwAlbums, findKwAlbumId, getKwAlbumDetail } from '@/lib/services/kw-chain-service'
import { findMgAlbumId, getMgAlbumDetail } from '@/lib/services/mg-chain-service'
import { findTxAlbumId, getTxAlbumDetail } from '@/lib/services/tx-chain-service'
import { searchAlbumCardsChain } from '@/lib/services/source-chain'
import { parseIntervalToSeconds } from '@/lib/services/source-toggle'
import { getAmpArtistDetail, getAmpAlbumDetail } from '@/lib/services/apple-amp-service'
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
  /^https:\/\/img[0-9]*\.kwcdn\.kuwo\.cn\//i,      // 酷我封面（kwcdn 域）
  /^https:\/\/(img[0-9]*|star)\.kuwo\.cn\//i,      // 酷我封面/歌手头像（img1/img4/star 直域，r.s 与 wapi 返回的实际域名）
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
    /** 头像（v2.5 amp 官方 artwork；老路径回落首张专辑封面） */
    img: string | null
    /** amp bornOrFormed（Wikidata 档案缺失时兜底） */
    birthDate?: string
  }
  /** 热门歌曲（Apple 热门度排序，本地库优先落歌，可播） */
  hotSongs: Song[]
  /** 专辑卡片（点进走 /api/album/apple/tracks） */
  albums: ArtistAlbumCard[]
}

/** Apple 歌手详情：热门歌（本地优先落歌）+ 专辑列表 + 维基简介。结果缓存 1h。 */
export async function getAppleArtistDetail(artistId: string): Promise<AppleArtistDetail | null> {
  const cacheKey = `album:v3:artist:${artistId}`
  const cached = searchCache.get(cacheKey) as AppleArtistDetail | null
  if (cached) return cached

  // v2.5 amp 升级：一发全包（官方头像 artwork + 生日 + 24 热门歌 + 全部专辑），
  // 失败回落老 iTunes Search API 路径；bio/档案仍走维基（cn 目录 amp artistBio 普遍为空）
  const amp = await getAmpArtistDetail(artistId).catch(() => null)
  const info = amp ? {
    artistId,
    name: amp.artist.name,
    genre: amp.artist.genre,
    img: amp.artist.img,
    birthDate: amp.artist.birthDate,
    songs: amp.topSongs.map(s => ({ title: s.title, titleNorm: '', secs: s.secs, artist: s.artist })),
    ampAlbums: amp.albums,
  } : null
  const fallback = info ? null : await getItunesArtistSongs(artistId)
  if (!info && !fallback) return null
  const name = info?.name ?? fallback!.name

  // 同名歌手检测：Apple 搜索该名字返回多个结果时，仅第一个（最热门）展示维基档案，
  // 其余跳过避免张冠李戴（如四个"张杰"只有大陆张杰的简介是对的）
  let isPrimaryArtist = true
  try {
    const artistSearch = await searchItunesArtists(name, 5)
    isPrimaryArtist = artistSearch.length <= 1 || artistSearch[0]?.artistId === artistId
  } catch { /* 检测失败时保守展示 */ }

  // 四路并行：热门歌落歌 / 专辑（amp 优先）/ 维基简介 / Wikidata 档案
  const [hotSongs, artistAlbums, bio, profile] = await Promise.all([
    batchResolveAndUpsert((info?.songs ?? fallback!.songs), name, undefined),
    info ? Promise.resolve(info.ampAlbums.map(a => ({
      source: 'apple' as const,
      albumId: a.albumId,
      name: a.name,
      artist: a.artist || name,
      year: a.year,
      img: a.img ?? null,
    }))) : getArtistAlbumsById(artistId).then(list => list.map(a => ({
      source: 'apple' as const,
      albumId: a.collectionId,
      name: a.name,
      artist: a.artist || name,
      year: a.year,
      img: a.img ?? null,
      trackCount: a.trackCount,
    }))).catch(() => []),
    isPrimaryArtist ? getWikiExtract(name, 'artist').catch(() => null) : Promise.resolve(null),
    isPrimaryArtist ? getArtistProfile(name, ).catch(() => null) : Promise.resolve(null),
  ])

  const albums: ArtistAlbumCard[] = artistAlbums

  // 头像 = amp 官方 artwork（老路径无照片时回落首张专辑封面）
  const img = info?.img ?? albums.find(a => a.img)?.img ?? null

  const detail: AppleArtistDetail = {
    artist: {
      artistId,
      name,
      genre: info?.genre ?? fallback?.genre,
      bio,
      profile,
      img,
      // amp bornOrFormed（Wikidata 档案缺失时的兜底生日）
      ...(info?.birthDate ? { birthDate: info.birthDate } : {}),
    },
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
 * 专辑搜索：走平台编排链 TX → 酷我 → 咪咕 → Apple（本地 MusicBrainz 索引已下线）。
 * 返回 list（恒为空，保留字段兼容旧前端）与 platformList（实际结果，卡片自带 source）。
 */
export async function searchAlbums(keyword: string, limit = 30): Promise<{
  list: Array<{ gid: string; title: string; artist: string; trackCount?: number }>
  platformList: Array<{ source: 'tx' | 'kw' | 'mg' | 'apple'; albumId: string; name: string; singer: string; img?: string | null; year?: string; trackCount?: number }>
}> {
  const k = keyword.trim()
  if (!k) return { list: [], platformList: [] }
  const cacheKey = `album:v8:platform:${k}:${limit}`
  type PlatformList = Array<{ source: 'tx' | 'kw' | 'mg' | 'apple'; albumId: string; name: string; singer: string; img?: string | null; year?: string; trackCount?: number }>
  const cached = searchCache.get(cacheKey) as { list: Array<{ gid: string; title: string; artist: string }>; platformList: PlatformList } | null
  if (cached) return cached

  let platformList: PlatformList = []
  try {
    platformList = (await searchAlbumCardsChain(k, limit)).map(c => ({
      source: c.source,
      albumId: c.albumId,
      name: c.name,
      singer: c.artist,
      img: c.img ?? undefined,
      year: c.year,
      ...('trackCount' in c && c.trackCount != null ? { trackCount: c.trackCount } : {}),
    }))
  } catch (error) {
    logger.warn('[album] 平台专辑搜索链失败:', error instanceof Error ? error.message : error)
  }
  const result = { list: [] as Array<{ gid: string; title: string; artist: string }>, platformList }
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
  const cacheKey = `album:v2:apple:${collectionId}`
  const cached = searchCache.get(cacheKey) as AppleAlbumDetail | null
  if (cached) return cached

  // v2.5 amp 优先（editorialNotes 专业乐评），失败回落老 iTunes lookup
  const amp = await getAmpAlbumDetail(collectionId).catch(() => null)
  const meta = amp ?? await getItunesAlbumDetail(collectionId)
  if (!meta || meta.tracks.length === 0) return null
  const title = amp ? amp.album.title : meta.album.title
  const artist = amp ? amp.album.artist : meta.album.artist

  const list = await batchResolveAndUpsert(meta.tracks, artist, title)
  if (list.length === 0) {
    logger.warn(`[album] Apple 专辑《${title}》逐首匹配全部失败`)
    return null
  }

  const [bio, profile] = await Promise.all([
    getWikiExtract(title, 'album').catch(() => null),
    getAlbumProfile(title).catch(() => null),
  ])
  const detail: AppleAlbumDetail = {
    album: {
      collectionId,
      name: title,
      singer: artist,
      year: amp ? amp.album.year : meta.album.year,
      img: (amp ? amp.album.img : meta.album.img) ?? albumCoverFromSongs(list),
      trackCount: meta.tracks.length,
      // amp editorialNotes（专业乐评）优先于维基简介
      bio: amp?.album.bio || bio,
      profile,
    },
    list,
  }
  searchCache.set(cacheKey, detail, ALBUM_TRACKS_CACHE_TTL)
  return detail
}

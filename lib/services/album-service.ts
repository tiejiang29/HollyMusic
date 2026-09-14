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
import { prisma, getStorageSongmidForMusicInfo, upsertMusicInfosInTransaction } from '@/lib/db'
import { songIdentity } from '@/lib/song-identity'
import type { MusicInfo, Song, SourceType } from '@/lib/types/music'
import { findLocalAlbumByGid, getLocalAlbumTracks, searchLocalAlbums } from '@/lib/services/album-local-service'
import { searchOneSource } from '@/lib/services/song-search-service'
import { batchResolveAndUpsert } from '@/lib/services/batch-resolve'
import { getArtistAlbumIndex, getArtistAlbumsById, getItunesAlbumDetail, getItunesArtistSongs, searchItunesArtists, searchItunesAlbums, appleT2S } from '@/lib/services/itunes-service'
import { searchKwAlbums, findKwAlbumId, getKwAlbumDetail } from '@/lib/services/kw-chain-service'
import { findMgAlbumId, getMgAlbumDetail } from '@/lib/services/mg-chain-service'
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
    // ⓪ 详情缓存借用（零成本）：用户点开过详情（落歌完成）时封面已算好缓存
    const detail = searchCache.get(`album:v3:local:${gid}`) as { album?: { img?: string | null } } | null
    img = detail?.album?.img ?? null
  }
  if (!img && album) {
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

/** 曲目匹配器（kw/mg 快路径共享）：本地曲目表为权威顺序，
 *  逐曲按「歌名归一双向包含 + 时长 ±8s」匹配候选曲目，返回 原始下标 → MusicInfo */
function matchTracksToCandidates(
  tracks: Array<{ title: string; secs: number | null }>,
  candidates: MusicInfo[],
): Map<number, MusicInfo> {
  const normalize = (v: string | null | undefined) => normText(appleT2S(v || '').replace(/妳/g, '你'))
  const pool = candidates.map(t => ({
    mi: t,
    name: normalize(t.name),
    secs: parseIntervalToSeconds(t.interval),
    used: false,
  }))
  const map = new Map<number, MusicInfo>()
  tracks.forEach((track, i) => {
    const tNorm = normalize(track.title)
    if (!tNorm) return
    const hit = pool.find(k =>
      !k.used && k.name
      && (k.name.includes(tNorm) || tNorm.includes(k.name))
      && (track.secs == null || k.secs == null || Math.abs(k.secs - track.secs) <= 8),
    )
    if (hit) {
      hit.used = true
      map.set(i, hit.mi)
    }
  })
  return map
}

/** 链快路径（kw/mg 通用）：专辑名+歌手 → albumid → 整张曲目一次拿回（全带可播 id，不写库）。
 *  匹配失败返回 null（走下一链/batch 兜底）。 */
async function resolveLocalTracksViaChain(
  source: 'kw' | 'mg',
  tracks: Array<{ title: string; secs: number | null }>,
  artist: string,
  albumTitle: string,
): Promise<Map<number, MusicInfo> | null> {
  const albumId = source === 'kw'
    ? await findKwAlbumId(albumTitle, artist)
    : await findMgAlbumId(albumTitle, artist)
  if (!albumId) return null
  const detail = source === 'kw'
    ? await getKwAlbumDetail(albumId)
    : await getMgAlbumDetail(albumId)
  if (!detail) return null
  const map = matchTracksToCandidates(tracks, detail.tracks)
  return map.size > 0 ? map : null
}

/** 链命中曲目单事务入库 + 附 uid（按本地曲目顺序）；失败返回 null 让全量走 batch 兜底 */
async function upsertChainMatched(chainMap: Map<number, MusicInfo>): Promise<Song[] | null> {
  if (chainMap.size === 0) return []
  try {
    await upsertMusicInfosInTransaction([...chainMap.values()])
  } catch (error) {
    logger.warn('[album] 链快路径入库失败（该专辑走 batch 兜底）:', error instanceof Error ? error.message : error)
    return null
  }
  const songs: Song[] = []
  chainMap.forEach(mi => songs.push({ ...mi, uid: `${mi.source}-${getStorageSongmidForMusicInfo(mi)}` }))
  return songs
}

async function buildLocalAlbumDetail(localTitle: string, localArtist: string, gid: string): Promise<AlbumDetail | null> {
  const tracks = getLocalAlbumTracks(gid)
  if (tracks.length === 0) return null

  // 曲目解析（酷我快路径 → 咪咕快路径 → batch 兜底）与 Apple/wiki 元数据增强全并行：
  // 元数据只依赖专辑名+歌手，不依赖落歌结果
  const resolveTracks = async (): Promise<Song[]> => {
    let chainSongs: Song[] | null = null
    let matched = new Set<number>()
    for (const chain of ['kw', 'mg'] as const) {
      try {
        const chainMap = await resolveLocalTracksViaChain(chain, tracks, localArtist, localTitle)
        if (!chainMap) continue
        const songs = await upsertChainMatched(chainMap)
        if (songs) {
          chainSongs = songs
          matched = new Set(chainMap.keys())
          break
        }
      } catch (error) {
        logger.debug(`[album] 《${localTitle}》${chain} 快路径失败（走下一条链）:`, error instanceof Error ? error.message : error)
      }
    }
    const remaining = tracks.filter((_, i) => !matched.has(i))
    const fallbackList = remaining.length > 0
      ? await batchResolveAndUpsert(remaining, localArtist, localTitle)
      : []
    return [...(chainSongs ?? []), ...fallbackList]
  }
  const [list, apple, bio, profile] = await Promise.all([
    resolveTracks(),
    getAppleAlbumMeta(localTitle, localArtist).catch(() => ({ img: null as string | null, year: undefined as string | undefined })),
    getWikiExtract(localTitle, 'album').catch(() => null),
    getAlbumProfile(localTitle, gid).catch(() => null),
  ])
  if (list.length === 0) {
    logger.warn(`[album] 本地专辑《${localTitle}》逐首匹配全部失败`)
    return null
  }
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
  // 详情缓存（落歌昂贵，二次打开秒回；封面探测接口也借这份缓存取 img）
  const cacheKey = `album:v6:local:${gid}`
  const cached = searchCache.get(cacheKey) as LocalAlbumDetail | null
  if (cached) return cached

  // 落歌与维基 bio/profile 三路并行（wiki 内部 pageData 去重，只打一次上游）
  const album = findLocalAlbumByGid(gid)
  if (!album) return null
  const [detail, bio, profile] = await Promise.all([
    buildLocalAlbumDetail(album.title, album.artist, album.gid),
    getWikiExtract(album.title, 'album').catch(() => null),
    getAlbumProfile(album.title, gid).catch(() => null),
  ])
  if (!detail) return null
  const result: LocalAlbumDetail = {
    album: {
      gid: album.gid,
      name: album.title,
      singer: album.artist,
      trackCount: album.trackCount ?? detail.list.length,
      img: detail.album.img ?? null,
      year: detail.album.publishTime,
      bio: bio ?? null,
      profile: profile ?? null,
    },
    list: detail.list,
  }
  searchCache.set(cacheKey, result, ALBUM_TRACKS_CACHE_TTL)
  return result
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
 * 专辑搜索（组合）：本地中文专辑库优先；本地未命中自动回退 Apple 专辑搜索。
 * 返回 list（本地，gid 卡片）与 platformList（Apple 卡片，仅本地未命中时非空）。
 */
export async function searchAlbums(keyword: string, limit = 30): Promise<{
  list: Array<{ gid: string; title: string; artist: string; trackCount?: number }>
  platformList: Array<{ source: 'kw' | 'mg' | 'apple'; albumId: string; name: string; singer: string; img?: string | null; year?: string; trackCount?: number }>
}> {
  const k = keyword.trim()
  if (!k) return { list: [], platformList: [] }
  const cacheKey = `album:v7:combined:${k}:${limit}`
  type PlatformList = Array<{ source: 'kw' | 'mg' | 'apple'; albumId: string; name: string; singer: string; img?: string | null; year?: string; trackCount?: number }>
  const cached = searchCache.get(cacheKey) as { list: Array<{ gid: string; title: string; artist: string; trackCount?: number }>; platformList: PlatformList } | null
  if (cached) return cached

  const list = searchLocalAlbums(k, limit)
  let platformList: PlatformList = []
  if (list.length === 0) {
    // 本地未命中 → 三源编排（kw 完全匹配? → mg 完全匹配? → apple → 模糊兜底）
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

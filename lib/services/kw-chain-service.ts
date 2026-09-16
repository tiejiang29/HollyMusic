/**
 * 酷我 www 链路服务（歌手/专辑全链数据 + 直接可播 rid）
 *
 * 三条通道（2026-09 实测验证）：
 * 1. wapi.kuwo.cn/api/www/* —— 免 Secret（浏览器 artistAlbum 即此路径，合法客户端行为），主通道
 * 2. www.kuwo.cn/api/www/*  —— 需 Secret 头（LCG 异或算法，逆向自 kuwo 前端 da5648d.js），备通道
 * 3. searchlist.kuwo.cn/r.s —— 老接口（专辑详情 stype=albuminfo），免 Secret
 *
 * 三源架构中的酷我全链：搜歌手→歌手详情（简介/头像/热门歌/专辑）→专辑详情（曲目带 rid）。
 * rid 构造 uid=`kw-{rid}` 直接可播；歌曲入库为 kw MusicInfo，收藏/歌单/统计全兼容。
 *
 * 链路约定：全程酷我命名空间（artistid/albumid），不做跨源 ID 映射；
 * 调用方失败时用「名字应急钥匙」回落 Apple 路径（见各 API 路由）。
 */

import { searchCache } from '@/lib/cache-manager'
import { upsertMusicInfosInTransaction, getStorageSongmidForMusicInfo } from '@/lib/db'
import { logger } from '@/lib/logger'
import { appleT2S } from '@/lib/services/itunes-service'
import type { MusicInfo, QualityType } from '@/lib/types/music'

const KW_TIMEOUT = 8_000
const POLITENESS_INTERVAL = 100
const CACHE_TTL = 24 * 60 * 60 * 1000

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** Secret 依赖的 Cookie 名（kuwo 全站固定） */
const KW_COOKIE_NAME = 'Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324'

// ---------------------------------------------------------------------------
// Secret 生成（备通道 www.kuwo.cn 用；逆向自 kuwo 前端 LCG 异或混淆）
// ---------------------------------------------------------------------------

/** LCG 异或加密：Cookie 名派生随机流，逐字符异或 Cookie 值后转十六进制 */
export function generateKwSecret(cookieValue: string, cookieName = KW_COOKIE_NAME): string {
  let n = ''
  for (let i = 0; i < cookieName.length; i++) n += cookieName.charCodeAt(i).toString()
  const o = Math.floor(n.length / 5)
  const r = parseInt(n[o] + n[2 * o] + n[3 * o] + n[4 * o] + n[5 * o])
  const c = Math.ceil(cookieName.length / 2)
  const l = 2 ** 31 - 1
  const d = Math.round(1e9 * Math.random()) % 1e8
  n += d
  while (n.length > 10) n = String(parseInt(n.slice(0, 10)) + parseInt(n.slice(10)))
  let state = (r * Number(n) + c) % l
  let result = ''
  for (let i = 0; i < cookieValue.length; i++) {
    const b = cookieValue.charCodeAt(i) ^ Math.floor(state / l * 255)
    result += b < 16 ? '0' + b.toString(16) : b.toString(16)
    state = (r * state + c) % l
  }
  return result + d.toString(16).padStart(8, '0')
}

/** Cookie 缓存（Set-Cookie 过期时间很长，进程内复用；6h 强制刷新） */
let kwCookieCache: { value: string; expiresAt: number } | null = null

async function fetchKwCookie(): Promise<string | null> {
  if (kwCookieCache && kwCookieCache.expiresAt > Date.now()) return kwCookieCache.value
  try {
    const resp = await fetch('https://www.kuwo.cn/', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(KW_TIMEOUT),
      redirect: 'follow',
    })
    const setCookies = resp.headers.getSetCookie?.() || []
    const hit = setCookies.find(sc => sc.includes(KW_COOKIE_NAME))?.match(/=([^;]+)/)?.[1]
    if (hit) {
      kwCookieCache = { value: hit, expiresAt: Date.now() + 6 * 60 * 60 * 1000 }
      return hit
    }
  } catch (error) {
    logger.debug('[kw-chain] Cookie 获取失败（备通道不可用）:', error instanceof Error ? error.message : error)
  }
  return null
}

// ---------------------------------------------------------------------------
// 通用请求层：wapi 免 Secret 主通道 → www+Secret 备通道；r.s 老接口直连
// ---------------------------------------------------------------------------

/** 礼貌队列：相邻酷我请求间隔 ≥100ms（按主机分道） */
const queueTails = new Map<string, Promise<unknown>>()
function polite<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const tail = queueTails.get(host) ?? Promise.resolve()
  const run = tail.then(async () => {
    await new Promise(r => setTimeout(r, POLITENESS_INTERVAL))
    return fn()
  })
  queueTails.set(host, run.catch(() => undefined))
  return run
}

async function kwFetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.kuwo.cn/', ...headers },
    signal: AbortSignal.timeout(KW_TIMEOUT),
  })
  if (!resp.ok) throw new Error(`酷我接口 HTTP ${resp.status}`)
  return await resp.json()
}

/** www 系接口统一入口：先 wapi 免 Secret，失败再 www+Secret（两个域名同接口面） */
async function kwWwwGet<T>(path: string, params: Record<string, string | number>): Promise<T | null> {
  const qs = new URLSearchParams({
    httpsStatus: '1',
    reqId: crypto.randomUUID(),
    plat: 'web_www',
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  }).toString()

  // 主通道：wapi 免 Secret
  try {
    const j = await polite('wapi.kuwo.cn', () =>
      kwFetchJson(`https://wapi.kuwo.cn/api/www/${path}?${qs}`, {})) as { code?: number; data?: T; message?: string }
    if (j?.code === 200) return j.data ?? null
    throw new Error(`code=${j?.code} ${j?.message || ''}`)
  } catch (primaryError) {
    // 备通道：www + Secret
    try {
      const cookie = await fetchKwCookie()
      if (!cookie) throw primaryError
      const j = await polite('www.kuwo.cn', () =>
        kwFetchJson(`https://www.kuwo.cn/api/www/${path}?${qs}`, {
          Secret: generateKwSecret(cookie),
          Cookie: `${KW_COOKIE_NAME}=${cookie}`,
        })) as { code?: number; data?: T; message?: string }
      if (j?.code === 200) return j.data ?? null
      throw new Error(`备通道 code=${j?.code}`)
    } catch (fallbackError) {
      logger.warn(`[kw-chain] ${path} 双通道失败:`, fallbackError instanceof Error ? fallbackError.message : fallbackError)
      return null
    }
  }
}

/** r.s 老接口（专辑详情，免 Secret；返回单引号 JSON 需清洗） */
async function kwRsGet<T>(params: Record<string, string | number>): Promise<T | null> {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString()
  try {
    const text = await polite('searchlist.kuwo.cn', async () => {
      const resp = await fetch(`https://searchlist.kuwo.cn/r.s?${qs}`, {
        headers: { 'User-Agent': UA, Referer: 'https://www.kuwo.cn/' },
        signal: AbortSignal.timeout(KW_TIMEOUT),
      })
      if (!resp.ok) throw new Error(`r.s HTTP ${resp.status}`)
      return await resp.text()
    })
    return JSON.parse(text.replace(/'/g, '"').replace(/[\u0000-\u001f]/g, ' ')) as T
  } catch (error) {
    logger.warn('[kw-chain] r.s 请求失败:', error instanceof Error ? error.message : error)
    return null
  }
}

// ---------------------------------------------------------------------------
// 数据清洗：HTML 实体解码 + 简繁统一
// ---------------------------------------------------------------------------

const ENTITY_MAP: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** HTML 实体解码（酷我名称/简介里常见 &nbsp; &amp;） */
function decodeEntities(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .replace(/&#(\d+);/g, (_, code) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&(\w+);/g, (m, name) => ENTITY_MAP[name] ?? m)
}

/** fromCodePoint 安全版（非法码点回退原样，避免 decode 抛错炸整个请求） */
function safeCodePoint(code: number): string {
  try {
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  } catch {
    return ''
  }
}

/** 统一清洗：实体解码 + 繁→简（酷我偶有繁体如「米津玄師」） */
function clean(value: string | null | undefined): string {
  return appleT2S(decodeEntities(value)).trim()
}

/** 秒 → "mm:ss"（与 music-core kw 搜索的 interval 格式一致） */
function secsToInterval(secs: number | string | null | undefined): string {
  const n = Number(secs)
  if (!Number.isFinite(n) || n <= 0) return '00:00'
  const m = Math.floor(n / 60)
  const s = Math.floor(n % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// 卡片与详情类型
// ---------------------------------------------------------------------------

export interface KwArtistCard {
  source: 'kw'
  /** 酷我 artistid（详情/热门歌/专辑全集的钥匙） */
  artistId: string
  name: string
  /** 官方头像（star.kuwo.cn starheads） */
  pic?: string | null
  musicNum?: number
}

export interface KwAlbumCard {
  source: 'kw'
  /** 酷我 albumid（专辑详情钥匙） */
  albumId: string
  name: string
  artist: string
  /** 300px 专辑封面（img1.kuwo.cn），pic/img 同值双口径（前端统一消费 img） */
  pic: string | null
  img: string | null
  year?: string
}

export interface KwArtistInfo {
  artistId: string
  name: string
  /** 官方头像（star.kuwo.cn starheads，pic300 优先） */
  pic: string | null
  /** 同 pic（前端 ArtistDetailData.artist.img 统一口径） */
  img: string | null
  bio: string | null
  birthDate?: string
  country?: string
  musicNum?: number
  albumNum?: number
}

export interface KwAlbumDetail {
  album: {
    albumId: string
    name: string
    artist: string
    pic: string | null
    company?: string
    year?: string
  }
  /** 整张专辑曲目（kw MusicInfo，未入库；调用方批量 upsert 后附 uid） */
  tracks: MusicInfo[]
}

// ---------------------------------------------------------------------------
// 接口：搜索
// ---------------------------------------------------------------------------

/** 搜歌手：searchArtistBykeyWord（卡片自带官方头像） */
export async function searchKwArtists(keyword: string, limit = 10): Promise<KwArtistCard[]> {
  const q = keyword.trim()
  if (!q) return []
  const cacheKey = `kw:searchArtist:${q}:${limit}`
  const cached = searchCache.get(cacheKey) as KwArtistCard[] | null
  if (cached) return cached

  interface Raw { list?: Array<{ id?: number | string; name?: string; pic?: string; musicNum?: number }> }
  const data = await kwWwwGet<Raw>('search/searchArtistBykeyWord', { key: q, pn: 1, rn: Math.min(limit, 30) })
  const list = (data?.list || [])
    .filter(a => a.id != null && a.name)
    .slice(0, limit)
    .map(a => ({
      source: 'kw' as const,
      artistId: String(a.id),
      name: clean(a.name),
      pic: a.pic || null,
      ...(a.musicNum != null ? { musicNum: a.musicNum } : {}),
    }))
  if (list.length > 0) searchCache.set(cacheKey, list, CACHE_TTL)
  return list
}

/** 搜专辑：searchAlbumBykeyWord（卡片自带 300px 封面 + 发行日期） */
export async function searchKwAlbums(keyword: string, limit = 30): Promise<KwAlbumCard[]> {
  const q = keyword.trim()
  if (!q) return []
  const cacheKey = `kw:searchAlbum:${q}:${limit}`
  const cached = searchCache.get(cacheKey) as KwAlbumCard[] | null
  if (cached) return cached

  interface Raw {
    albumList?: Array<{ albumid?: number | string; album?: string; artist?: string; pic?: string; releaseDate?: string }>
  }
  const data = await kwWwwGet<Raw>('search/searchAlbumBykeyWord', { key: q, pn: 1, rn: Math.min(limit, 30) })
  const list = (data?.albumList || [])
    .filter(a => a.albumid != null && a.album)
    .slice(0, limit)
    .map(a => ({
      source: 'kw' as const,
      albumId: String(a.albumid),
      name: clean(a.album),
      artist: clean(a.artist),
      pic: a.pic || null,
      img: a.pic || null,
      ...(a.releaseDate ? { year: a.releaseDate.slice(0, 10) } : {}),
    }))
  if (list.length > 0) searchCache.set(cacheKey, list, CACHE_TTL)
  return list
}

// ---------------------------------------------------------------------------
// 接口：歌手详情三件套
// ---------------------------------------------------------------------------

/** 歌手信息：artist/artist（百科级简介 + 官方头像 + 生日/国籍） */
export async function getKwArtistInfo(artistId: string): Promise<KwArtistInfo | null> {
  const cacheKey = `kw:artistInfo:v2:${artistId}`
  const cached = searchCache.get(cacheKey) as KwArtistInfo | null
  if (cached) return cached

  interface Raw {
    id?: number; name?: string; pic?: string; pic300?: string; info?: string
    birthday?: string; country?: string; musicNum?: number; albumNum?: number
  }
  const d = await kwWwwGet<Raw>('artist/artist', { artistid: artistId })
  if (!d?.id || !d.name) return null
  const info: KwArtistInfo = {
    artistId: String(d.id),
    name: clean(d.name),
    // 头像优先 300px（pic 默认 120px，前端 artist.img 直接消费）
    pic: d.pic300 || d.pic || null,
    img: d.pic300 || d.pic || null,
    // 简介去掉 HTML 标签与实体（酷我 info 字段是富文本）
    bio: d.info ? clean(d.info.replace(/<[^>]+>/g, '')).slice(0, 800) || null : null,
    ...(d.birthday ? { birthDate: d.birthday.slice(0, 10) } : {}),
    ...(d.country ? { country: d.country } : {}),
    ...(d.musicNum != null ? { musicNum: d.musicNum } : {}),
    ...(d.albumNum != null ? { albumNum: d.albumNum } : {}),
  }
  searchCache.set(cacheKey, info, CACHE_TTL)
  return info
}

/** 音质档位展示顺序（与 tx/music-core 一致：低→高） */
const KW_QUALITY_ORDER: QualityType[] = ['128k', '320k', 'flac', 'flac24bit']

/** MINFO 单段（`level:ff,bitrate:2000,format:flac,size:32.38Mb`）→ 音质档位 */
function qualityOfMinfoSegment(seg: string): { quality: QualityType; size: string } | null {
  const format = /format:([a-z0-9]+)/i.exec(seg)?.[1]?.toLowerCase()
  const bitrate = Number(/bitrate:(\d+)/i.exec(seg)?.[1] || 0)
  const sizeMatch = /size:([\d.]+)\s*([MG])b?/i.exec(seg)
  // 与 tx 链的尺寸文案对齐（"32.38M"），缺失时留空串（历史库里已有空串约定）
  const size = sizeMatch ? `${sizeMatch[1]}${sizeMatch[2].toUpperCase()}` : ''
  if (format === 'flac') return { quality: 'flac', size }
  if (format === 'mp3') return { quality: bitrate >= 256 ? '320k' : '128k', size }
  // ogg/aac/ZP 等非本项目音质档位忽略（音源脚本也送不出这些格式）
  return null
}

/**
 * 酷我可用音质 → types/_types。
 *
 * 必须给出档位：音源管理器按 `_types[quality]` 逐档筛选，空 _types 会让该曲在
 * 酷我平台被整段跳过、同平台取址必然失败，只能依赖跨平台换源兜底（见 kwSongToMusicInfo 调用方）。
 * 数据来源优先级：MINFO 明细（r.s 专辑接口，含各档大小）→ formats 集合 → 基线档位。
 * 酷我 mp3 128k/320k 是平台基线，任何歌曲都有，故始终补上；flac 仅在明确标记时给。
 */
export function parseKwQualities(input: {
  minfo?: string | null
  formats?: string | null
  hasLossless?: boolean | string | null
}): Pick<MusicInfo, 'types' | '_types'> {
  const sizes = new Map<QualityType, string>()
  const put = (quality: QualityType, size: string) => {
    if (!sizes.has(quality)) sizes.set(quality, size)
  }

  for (const seg of (input.minfo || '').split(';')) {
    if (!seg) continue
    const hit = qualityOfMinfoSegment(seg)
    if (hit) put(hit.quality, hit.size)
  }

  if (sizes.size === 0 && input.formats) {
    const tokens = new Set(input.formats.split('|').map(t => t.trim().toUpperCase()))
    if (tokens.has('MP3128')) put('128k', '')
    if (tokens.has('MP3H')) put('320k', '')
    if (tokens.has('ALFLAC')) put('flac', '')
  }

  put('128k', '')
  put('320k', '')
  if (input.hasLossless === true || input.hasLossless === 'true') put('flac', '')

  const types = KW_QUALITY_ORDER.filter(q => sizes.has(q)).map(q => ({ type: q, size: sizes.get(q) as string }))
  const _types = Object.fromEntries(types.map(t => [t.type, { size: t.size }]))
  return { types, _types: _types as MusicInfo['_types'] }
}

/** 酷我歌曲 → kw MusicInfo（interval 格式与 music-core 对齐，uid 由入库方附加） */
export function kwSongToMusicInfo(s: {
  rid?: number | string; name?: string; artist?: string
  album?: string; duration?: number | string; albumpic?: string
  /** 音质线索：MINFO（r.s 专辑接口）/ formats 集合（同上）/ hasLossless（wapi 歌手接口） */
  minfo?: string; formats?: string; hasLossless?: boolean
}): MusicInfo | null {
  if (s.rid == null || !s.name) return null
  const { types, _types } = parseKwQualities(s)
  return {
    name: clean(s.name),
    singer: clean(s.artist) || '未知歌手',
    source: 'kw',
    songmid: String(s.rid),
    ...(s.album ? { albumName: clean(s.album) } : {}),
    interval: secsToInterval(s.duration),
    img: s.albumpic || null,
    types,
    _types,
    typeUrl: {},
  }
}

/** 歌手全部歌曲（热门度排序）：artistMusic，rn=100 一次拉热门页 */
export async function getKwArtistSongs(
  artistId: string,
  limit = 100,
): Promise<{ total: number; list: MusicInfo[] } | null> {
  const cacheKey = `kw:artistSongs:v2:${artistId}:${limit}`
  const cached = searchCache.get(cacheKey) as { total: number; list: MusicInfo[] } | null
  if (cached) return cached

  interface RawSong {
    rid?: number | string; name?: string; artist?: string
    album?: string; duration?: number | string; albumpic?: string
    hasLossless?: boolean
  }
  interface Raw { total?: number; list?: RawSong[] }
  const data = await kwWwwGet<Raw>('artist/artistMusic', {
    artistid: artistId, pn: 1, rn: Math.min(limit, 100),
  })
  const rawList = data?.list || []
  if (rawList.length === 0) return null
  const list = rawList.map(s => kwSongToMusicInfo({ ...s, hasLossless: s.hasLossless === true }))
    .filter((m): m is MusicInfo => m !== null)
  if (list.length === 0) return null
  const result = { total: data?.total ?? list.length, list }
  searchCache.set(cacheKey, result, CACHE_TTL)
  return result
}

/** 歌手专辑全集：artistAlbum（wapi 免 Secret 已验证） */
export async function getKwArtistAlbums(artistId: string, limit = 30): Promise<KwAlbumCard[]> {
  const cacheKey = `kw:artistAlbums:v2:${artistId}:${limit}`
  const cached = searchCache.get(cacheKey) as KwAlbumCard[] | null
  if (cached) return cached

  interface Raw {
    albumList?: Array<{ albumid?: number | string; album?: string; artist?: string; pic?: string; releaseDate?: string }>
  }
  const data = await kwWwwGet<Raw>('artist/artistAlbum', { artistid: artistId, pn: 1, rn: Math.min(limit, 30) })
  const list = (data?.albumList || [])
    .filter(a => a.albumid != null && a.album)
    .slice(0, limit)
    .map(a => ({
      source: 'kw' as const,
      albumId: String(a.albumid),
      name: clean(a.album),
      artist: clean(a.artist),
      pic: a.pic || null,
      img: a.pic || null,
      ...(a.releaseDate ? { year: a.releaseDate.slice(0, 10) } : {}),
    }))
  if (list.length > 0) searchCache.set(cacheKey, list, CACHE_TTL)
  return list
}

// ---------------------------------------------------------------------------
// 接口：专辑详情（r.s 老接口，一次拿全曲目 rid）
// ---------------------------------------------------------------------------

/** 专辑详情：stype=albuminfo → name/artist/musiclist(rid)/pic/company */
export async function getKwAlbumDetail(albumId: string): Promise<KwAlbumDetail | null> {
  const cacheKey = `kw:albumDetail:v2:${albumId}`
  const cached = searchCache.get(cacheKey) as KwAlbumDetail | null
  if (cached) return cached

  interface Raw {
    albumid?: number | string; name?: string; artist?: string; artistid?: number | string
    pic?: string; company?: string; releaseDate?: string; publishtime?: string
    musiclist?: Array<{
      id?: number | string; name?: string; artist?: string; duration?: number | string; album?: string
      /** 音质明细（`level:ff,bitrate:2000,format:flac,size:32.38Mb;…`）与可用格式集合，用于补齐 types */
      MINFO?: string; formats?: string
    }>
  }
  const d = await kwRsGet<Raw>({
    stype: 'albuminfo', albumid: albumId,
    show_copyright_off: 1, alflac: 1, vipver: 1, sortby: 1, newver: 1, mobi: 1,
  })
  if (!d?.musiclist || d.musiclist.length === 0) return null

  // r.s pic 常为 120px（绝对或相对路径），统一升 300px（与 searchAlbumBykeyWord 卡片同源同尺寸）
  const pic300 = (p: string) => p.startsWith('http')
    ? p.replace('/star/albumcover/120/', '/star/albumcover/300/')
    : `https://img1.kuwo.cn/star/albumcover/${p.replace(/^120\//, '300/')}`
  const pic = d.pic ? pic300(d.pic) : null
  const detail: KwAlbumDetail = {
    album: {
      albumId: String(d.albumid ?? albumId),
      name: clean(d.name),
      artist: clean(d.artist),
      pic,
      ...(d.company ? { company: clean(d.company) } : {}),
      ...((d.releaseDate || d.publishtime) ? { year: String(d.releaseDate || d.publishtime).slice(0, 10) } : {}),
    },
    tracks: d.musiclist.map(t => kwSongToMusicInfo({
      rid: t.id, name: t.name, artist: t.artist, duration: t.duration,
      albumpic: pic || undefined, album: d.name,
      minfo: t.MINFO, formats: t.formats,
    })).filter((m): m is MusicInfo => m !== null),
  }
  if (detail.tracks.length === 0) return null
  searchCache.set(cacheKey, detail, CACHE_TTL)
  return detail
}

// ---------------------------------------------------------------------------
// 组装：歌手详情整包（供 /api/artist/kw/detail 使用）
// ---------------------------------------------------------------------------

export interface KwArtistDetail {
  source: 'kw'
  artist: KwArtistInfo
  /** 热门歌（已批量入库 + 附 uid，直接可播） */
  hotSongs: Array<MusicInfo & { uid: string }>
  albums: KwAlbumCard[]
}

/** 酷我歌手详情整包：信息/热门歌/专辑三路并行 → 热门歌一次入库附 uid。缓存 1h。
 *  返回 null = 酷我链整体不可用（调用方走名字应急钥匙回落 Apple）。 */
export async function getKwArtistDetail(artistId: string): Promise<KwArtistDetail | null> {
  const cacheKey = `kw:artistDetail:v4:${artistId}`
  const cached = searchCache.get(cacheKey) as KwArtistDetail | null
  if (cached) return cached

  const [info, songs, albums] = await Promise.all([
    getKwArtistInfo(artistId),
    getKwArtistSongs(artistId, 100),
    getKwArtistAlbums(artistId, 30),
  ])
  if (!info || !songs || songs.list.length === 0) return null

  // 热门歌批量入库（单事务；失败降级逐条，与 batch-resolve 同策略）
  let stored = songs.list
  try {
    await upsertMusicInfosInTransaction(songs.list)
  } catch (error) {
    logger.warn('[kw-chain] 热门歌批量入库失败，降级逐条:', error instanceof Error ? error.message : error)
    const survivors: MusicInfo[] = []
    for (const mi of songs.list) {
      try { await upsertMusicInfosInTransaction([mi]); survivors.push(mi) } catch { /* 跳过坏数据 */ }
    }
    if (survivors.length === 0) return null
    stored = survivors
  }

  const detail: KwArtistDetail = {
    source: 'kw',
    artist: info,
    hotSongs: stored.map(mi => ({ ...mi, uid: `${mi.source}-${getStorageSongmidForMusicInfo(mi)}` })),
    albums,
  }
  searchCache.set(cacheKey, detail, 60 * 60 * 1000)
  return detail
}

/** 酷我专辑详情（可播版）：r.s 曲目一次入库附 uid。缓存 1h。
 *  返回 null = 专辑不存在或酷我链不可用。 */
export async function getKwAlbumDetailPlayable(albumId: string): Promise<{
  album: {
    albumId: string; name: string; singer: string; img: string | null
    year?: string; company?: string; trackCount: number
    profile?: { releaseDate?: string; recordLabels?: string[] }
  }
  list: Array<MusicInfo & { uid: string }>
} | null> {
  const cacheKey = `kw:albumPlayable:v2:${albumId}`
  const cached = searchCache.get(cacheKey) as Awaited<ReturnType<typeof getKwAlbumDetailPlayable>> | null
  if (cached) return cached

  const detail = await getKwAlbumDetail(albumId)
  if (!detail) return null

  let stored = detail.tracks
  try {
    await upsertMusicInfosInTransaction(detail.tracks)
  } catch (error) {
    logger.warn('[kw-chain] 专辑曲目批量入库失败，降级逐条:', error instanceof Error ? error.message : error)
    const survivors: MusicInfo[] = []
    for (const mi of detail.tracks) {
      try { await upsertMusicInfosInTransaction([mi]); survivors.push(mi) } catch { /* 跳过坏数据 */ }
    }
    if (survivors.length === 0) return null
    stored = survivors
  }

  const result = {
    album: {
      albumId: detail.album.albumId,
      name: detail.album.name,
      singer: detail.album.artist,
      img: detail.album.pic,
      trackCount: stored.length,
      ...(detail.album.year ? { year: detail.album.year } : {}),
      ...(detail.album.company ? { company: detail.album.company } : {}),
      ...((detail.album.year || detail.album.company) ? {
        profile: {
          ...(detail.album.year ? { releaseDate: detail.album.year } : {}),
          ...(detail.album.company ? { recordLabels: [detail.album.company] } : {}),
        },
      } : {}),
    },
    list: stored.map(mi => ({ ...mi, uid: `${mi.source}-${getStorageSongmidForMusicInfo(mi)}` })),
  }
  searchCache.set(cacheKey, result, 60 * 60 * 1000)
  return result
}

/** 专辑封面解析（跨源降级链的酷我段）：专辑详情 pic（缓存 24h）→
 *  按名搜专辑卡片 pic → null（路由层继续回落 Apple）。albumid 与 name 至少有其一。 */
export async function resolveKwAlbumCoverUrl(
  albumId: string | null,
  name?: string,
  singer?: string,
): Promise<string | null> {
  // 1. kw 专辑详情 pic
  if (albumId && /^\d+$/.test(albumId)) {
    const detail = await getKwAlbumDetail(albumId).catch(() => null)
    if (detail?.album.pic) return detail.album.pic
  }
  // 2. kw 搜专辑卡片 pic（专辑详情未命中/无图时）
  if (name?.trim()) {
    const cards = await searchKwAlbums(`${name.trim()} ${singer?.trim() || ''}`.trim(), 5).catch(() => [])
    const titleNorm = clean(name).toLowerCase().replace(/\s+/g, '')
    const hit = cards.find(c => {
      const t = c.name.toLowerCase().replace(/\s+/g, '')
      return !!t && (t.includes(titleNorm) || titleNorm.includes(t))
    })
    if (hit?.pic) return hit.pic
  }
  return null
}

/** 按专辑名+歌手名找酷我 albumid（本地专辑进酷我链的门；带歌手校验防同名专辑错配） */
export async function findKwAlbumId(title: string, artist: string): Promise<string | null> {
  const albums = await searchKwAlbums(`${title} ${artist}`.trim(), 10).catch(() => [])
  const titleNorm = clean(title).toLowerCase().replace(/\s+/g, '')
  const artistNorm = clean(artist).toLowerCase().replace(/\s+/g, '')
  const hit = albums.find(a => {
    const aTitle = a.name.toLowerCase().replace(/\s+/g, '')
    const aArtist = a.artist.toLowerCase().replace(/\s+/g, '')
    if (!aTitle.includes(titleNorm) && !titleNorm.includes(aTitle)) return false
    return !artistNorm || aArtist.includes(artistNorm) || artistNorm.includes(aArtist)
  })
  return hit?.albumId ?? null
}

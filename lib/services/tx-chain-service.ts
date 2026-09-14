/**
 * QQ音乐（TX）链路服务——三源架构 v3：TX 主链
 *
 * 协议身份：安卓"QQ音乐极速版"（musicu.fcg + tmeAppID=qqmusiclight，现有五源之一），
 * 全部接口免登录实测验证：
 * - 搜歌手卡    c6.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg（明文老接口，uin=0 可用；
 *              singer 区块带 mid + 官方头像 T001 直链）
 * - 搜歌        musicu.fcg DoSearchForQQMusicLite（singer[].mid/album.mid/time_public/各音质size）
 * - 专辑曲目    musicu.fcg music.musichallAlbum.AlbumSongList.GetAlbumSongList
 *              （按 albumMid 一次整张，叶惠美 11 曲实测）
 * - 封面        y.gtimg.cn 公式：专辑 T002R500x500M000{albumMid}.jpg / 歌手 T001R300x300M000{mid}.jpg
 * - MV 列表     c.y.qq.com/mv/fcgi-bin/fcg_singer_mv.fcg（singermid，明文免登录，20/页）
 * - 播放        tx-{songmid} 走现有 LX 脚本管道（换源优先级第一位）
 *
 * 已验证不可行（2026-09 预研）：
 * - 歌手简介：网页 musics.fcg 加密协议（TmeWebSec JSVMP，已破解传输层——sign+ag-1 加解密
 *   均可在 Node 复刻，外层 code=0），但 SingerDirectory 模块层登录门（subcode 860100001），
 *   简介维基兜底
 * - MV 直链：vid 经 vkey 网关全变体空 purl（腾讯视频体系另算）
 * - RS02 保底：匿名 vkey 仅 RS02 前缀（128k 试听档）放行——生产用 LX 脚本更强，仅存档
 */

import { searchCache } from '@/lib/cache-manager'
import { upsertMusicInfosInTransaction, getStorageSongmidForMusicInfo } from '@/lib/db'
import { logger } from '@/lib/logger'
import { appleT2S } from '@/lib/services/itunes-service'
import type { MusicInfo, QualityType } from '@/lib/types/music'

const TX_TIMEOUT = 10_000
const POLITENESS_INTERVAL = 150
const CACHE_TTL = 24 * 60 * 60 * 1000

const UA = 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)'
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 极速版 App 协议身份（与 music-core tx 搜索同一形态） */
const APP_COMM = { ct: 11, cv: '1003006', v: '1003006', os_ver: '12', phonetype: '0', devicelevel: '31', tmeAppID: 'qqmusiclight', nettype: 'NETWORK_WIFI' }

/** 礼貌队列：相邻 TX 请求间隔 ≥150ms（按主机分道） */
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

/** App 协议 POST（musicu.fcg） */
async function appPost<T>(reqs: Record<string, unknown>): Promise<T | null> {
  try {
    const j = await polite('u.y.qq.com', async () => {
      const resp = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.keys(reqs).length === 1 && reqs.req_0
          ? { comm: APP_COMM, req_0: reqs.req_0 }
          : { comm: APP_COMM, ...reqs }),
        signal: AbortSignal.timeout(TX_TIMEOUT),
      })
      if (!resp.ok) throw new Error(`musicu.fcg HTTP ${resp.status}`)
      return await resp.json() as T
    })
    return j
  } catch (error) {
    logger.warn('[tx-chain] musicu.fcg 请求失败:', error instanceof Error ? error.message : error)
    return null
  }
}

function clean(value: string | null | undefined): string {
  return appleT2S(value || '').trim()
}

function normKey(value: string | null | undefined): string {
  return appleT2S(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** 头像/封面公式：T001R300x300M000{singermid} / T002R500x500M000{albumMid} */
export function txPhotoUrl(kind: 'T001' | 'T002', mid: string, size = 300 | 500 as never): string {
  const s = kind === 'T001' ? 300 : 500
  return `https://y.gtimg.cn/music/photo_new/${kind}R${s}x${s}M000${mid}.jpg`
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface TxArtistCard {
  source: 'tx'
  /** QQ singer_mid（全局稳定歌手 ID） */
  artistId: string
  name: string
  /** 官方头像（T001 300px 直链，smartbox 自带） */
  pic: string | null
  img: string | null
}

export interface TxAlbumCard {
  source: 'tx'
  albumId: string
  name: string
  artist: string
  /** T002 500px 直链（公式推导） */
  pic: string | null
  img: string | null
  year?: string
}

// ---------------------------------------------------------------------------
// 接口：搜歌手（smartbox 明文老接口）
// ---------------------------------------------------------------------------

export async function searchTxArtists(keyword: string, limit = 10): Promise<TxArtistCard[]> {
  const q = keyword.trim()
  if (!q) return []
  const cacheKey = `tx:searchArtist:${q}`
  const cached = searchCache.get(cacheKey) as TxArtistCard[] | null
  if (cached) return cached

  interface Raw { code?: number; data?: { singer?: { itemlist?: Array<{ mid?: string; name?: string; pic?: string }> } } }
  try {
    const j = await polite('c6.y.qq.com', async () => {
      const resp = await fetch(`https://c6.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?_=${Date.now()}&cv=4747474&ct=24&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=1&uin=0&hostUin=0&is_xml=0&key=${encodeURIComponent(q)}`, {
        headers: { 'User-Agent': WEB_UA, accept: 'application/json', Referer: 'https://y.qq.com/' },
        signal: AbortSignal.timeout(TX_TIMEOUT),
      })
      if (!resp.ok) throw new Error(`smartbox HTTP ${resp.status}`)
      return await resp.json() as Raw
    })
    const list = (j?.data?.singer?.itemlist || [])
      .filter(s => s.mid && s.name)
      .slice(0, limit)
      .map(s => {
        // pic 是 150px 直链，升 300px（公式实测可升）
        const pic = s.pic ? s.pic.replace('T001R150x150', 'T001R300x300') : txPhotoUrl('T001', s.mid!)
        return { source: 'tx' as const, artistId: s.mid!, name: clean(s.name), pic, img: pic }
      })
    if (list.length > 0) searchCache.set(cacheKey, list, CACHE_TTL)
    return list
  } catch (error) {
    logger.warn('[tx-chain] smartbox 搜索失败:', error instanceof Error ? error.message : error)
    return []
  }
}

// ---------------------------------------------------------------------------
// 接口：搜歌（App 协议 DoSearchForQQMusicLite，与 music-core tx 同形态）
// ---------------------------------------------------------------------------

interface TxRawSong {
  mid?: string
  name?: string
  title_extra?: string
  interval?: number
  singer?: Array<{ mid?: string; name?: string }>
  album?: { mid?: string; name?: string; time_public?: string }
  file?: {
    media_mid?: string
    size_128mp3?: number; size_320mp3?: number; size_flac?: number; size_hires?: number
  }
}

async function searchTxSongsRaw(keyword: string, page = 1, limit = 30): Promise<TxRawSong[]> {
  interface Raw { code?: number; req?: { code?: number; data?: { body?: { item_song?: TxRawSong[] } } } }
  const j = await appPost<Raw>({
    req: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicLite',
      param: { query: keyword, search_type: 0, num_per_page: limit, page_num: page, nqc_flag: 0, grp: 1 },
    },
  })
  if (j?.code !== 0 || j.req?.code !== 0) return []
  return j.req?.data?.body?.item_song || []
}

/** TX 原始歌 → tx MusicInfo（songmid=mid，与 music-core tx 源同构，uid 由入库方附加） */
export function txSongToMusicInfo(item: TxRawSong): MusicInfo | null {
  if (!item.mid || !item.name || !item.file?.media_mid) return null
  const types: Array<{ type: QualityType; size: string }> = []
  const _types: Partial<Record<QualityType, { size: string }>> = {}
  const fmt = (v?: number) => {
    if (!v) return '0B'
    return `${(v / 1024 / 1024).toFixed(2)}M`
  }
  if (item.file.size_128mp3) { types.push({ type: '128k', size: fmt(item.file.size_128mp3) }); _types['128k'] = { size: fmt(item.file.size_128mp3) } }
  if (item.file.size_320mp3) { types.push({ type: '320k', size: fmt(item.file.size_320mp3) }); _types['320k'] = { size: fmt(item.file.size_320mp3) } }
  if (item.file.size_flac) { types.push({ type: 'flac', size: fmt(item.file.size_flac) }); _types.flac = { size: fmt(item.file.size_flac) } }
  if (item.file.size_hires) { types.push({ type: 'flac24bit', size: fmt(item.file.size_hires) }); _types.flac24bit = { size: fmt(item.file.size_hires) } }
  return {
    name: clean(item.name) + clean(item.title_extra || ''),
    singer: (item.singer || []).map(s => clean(s.name)).filter(Boolean).join('、') || '未知歌手',
    source: 'tx',
    songmid: item.mid,
    strMediaMid: item.file.media_mid,
    ...(item.album?.mid ? { albumId: item.album.mid, albumMid: item.album.mid } : {}),
    albumName: clean(item.album?.name) || '',
    interval: item.interval ? `${Math.floor(item.interval / 60).toString().padStart(2, '0')}:${(item.interval % 60).toString().padStart(2, '0')}` : '00:00',
    img: item.album?.mid ? txPhotoUrl('T002', item.album.mid) : null,
    types,
    _types: _types as MusicInfo['_types'],
    typeUrl: {},
  }
}

// ---------------------------------------------------------------------------
// 歌手歌曲（按 mid 精确过滤）+ 专辑聚合
// ---------------------------------------------------------------------------

/** 歌手热门歌：App 搜索 2 页×30 → singer[].mid 精确过滤（同名歌手免疫） */
export async function getTxArtistSongs(singerMid: string, nameHint: string, limit = 60): Promise<MusicInfo[] | null> {
  const cacheKey = `tx:artistSongs:${singerMid}:${limit}`
  const cached = searchCache.get(cacheKey) as MusicInfo[] | null
  if (cached) return cached

  const pages = await Promise.all([
    searchTxSongsRaw(nameHint, 1, 30),
    searchTxSongsRaw(nameHint, 2, 30),
  ])
  const own = pages.flat().filter(s =>
    s.singer?.some(x => x.mid === singerMid))
  if (own.length === 0) return null
  const list = own.slice(0, limit)
    .map(txSongToMusicInfo)
    .filter((m): m is MusicInfo => m !== null)
  if (list.length === 0) return null
  searchCache.set(cacheKey, list, CACHE_TTL)
  return list
}

/** 歌手专辑聚合：热门歌按 albumMid 去重（封面/年份公式推导） */
export async function getTxArtistAlbums(songs: MusicInfo[], limit = 30): Promise<TxAlbumCard[]> {
  const seen = new Set<string>()
  const cards: TxAlbumCard[] = []
  for (const s of songs) {
    if (!s.albumId || seen.has(s.albumId) || !s.albumName) continue
    seen.add(s.albumId)
    cards.push({
      source: 'tx',
      albumId: s.albumId,
      name: s.albumName,
      artist: s.singer,
      pic: txPhotoUrl('T002', s.albumId),
      img: txPhotoUrl('T002', s.albumId),
    })
    if (cards.length >= limit) break
  }
  return cards
}

// ---------------------------------------------------------------------------
// 专辑详情（GetAlbumSongList 一次整张，免登录实测）
// ---------------------------------------------------------------------------

export async function getTxAlbumDetail(albumMid: string): Promise<{ tracks: MusicInfo[] } | null> {
  const cacheKey = `tx:albumDetail:${albumMid}`
  const cached = searchCache.get(cacheKey) as { tracks: MusicInfo[] } | null
  if (cached) return cached

  interface RawSongInfo {
    songInfo?: {
      mid?: string; name?: string; title?: string; interval?: number
      singer?: Array<{ name?: string }>
      album?: { mid?: string; name?: string }
      file?: { media_mid?: string; size_128mp3?: number; size_320mp3?: number; size_flac?: number; size_hires?: number }
    }
  }
  interface Raw { req_0?: { code?: number; data?: { songList?: RawSongInfo[]; totalNum?: number } } }
  const j = await appPost<Raw>({
    req_0: {
      module: 'music.musichallAlbum.AlbumSongList',
      method: 'GetAlbumSongList',
      param: { albumMid, albumId: 0, begin: 0, num: 99 },
    },
  })
  const rawList = j?.req_0?.data?.songList || []
  if (rawList.length === 0) return null
  const tracks = rawList
    .map(x => x.songInfo ? txSongToMusicInfo(x.songInfo as TxRawSong) : null)
    .filter((m): m is MusicInfo => m !== null)
  if (tracks.length === 0) return null
  const result = { tracks }
  searchCache.set(cacheKey, result, CACHE_TTL)
  return result
}

// ---------------------------------------------------------------------------
// 组装：歌手详情整包
// ---------------------------------------------------------------------------

async function upsertAndAttach(musicInfos: MusicInfo[]): Promise<Array<MusicInfo & { uid: string }> | null> {
  let stored = musicInfos
  try {
    await upsertMusicInfosInTransaction(musicInfos)
  } catch (error) {
    logger.warn('[tx-chain] 批量入库失败，降级逐条:', error instanceof Error ? error.message : error)
    const survivors: MusicInfo[] = []
    for (const mi of musicInfos) {
      try { await upsertMusicInfosInTransaction([mi]); survivors.push(mi) } catch { /* 跳过坏数据 */ }
    }
    if (survivors.length === 0) return null
    stored = survivors
  }
  return stored.map(mi => ({ ...mi, uid: `${mi.source}-${getStorageSongmidForMusicInfo(mi)}` }))
}

export interface TxArtistDetail {
  source: 'tx'
  artist: TxArtistCard
  /** 热门歌（已入库 + 附 uid，tx-{songmid} 直接可播） */
  hotSongs: Array<MusicInfo & { uid: string }>
  albums: TxAlbumCard[]
}

export async function getTxArtistDetail(singerMid: string, nameHint?: string): Promise<TxArtistDetail | null> {
  const cacheKey = `tx:artistDetail:${singerMid}`
  const cached = searchCache.get(cacheKey) as TxArtistDetail | null
  if (cached) return cached

  // smartbox 拿卡片（含头像）；miss 时用 mid 公式拼头像
  const cards = await searchTxArtists(nameHint || '', 5).catch(() => [])
  const card = cards.find(c => c.artistId === singerMid) ?? {
    source: 'tx' as const, artistId: singerMid, name: clean(nameHint),
    pic: txPhotoUrl('T001', singerMid), img: txPhotoUrl('T001', singerMid),
  }
  if (!card.name) return null

  const songs = await getTxArtistSongs(singerMid, card.name)
  if (!songs || songs.length === 0) return null
  const [hotSongs, albums] = await Promise.all([
    upsertAndAttach(songs),
    Promise.resolve(getTxArtistAlbums(songs)),
  ])
  if (!hotSongs) return null

  const detail: TxArtistDetail = { source: 'tx', artist: card, hotSongs, albums }
  searchCache.set(cacheKey, detail, 60 * 60 * 1000)
  return detail
}

/** 专辑详情（可播版）：入库附 uid */
export async function getTxAlbumDetailPlayable(albumMid: string): Promise<{
  album: TxAlbumCard & { trackCount: number }
  list: Array<MusicInfo & { uid: string }>
} | null> {
  const cacheKey = `tx:albumPlayable:${albumMid}`
  const cached = searchCache.get(cacheKey) as Awaited<ReturnType<typeof getTxAlbumDetailPlayable>> | null
  if (cached) return cached

  const detail = await getTxAlbumDetail(albumMid)
  if (!detail) return null
  const list = await upsertAndAttach(detail.tracks)
  if (!list) return null
  const first = detail.tracks[0]
  const result = {
    album: {
      source: 'tx' as const,
      albumId: albumMid,
      name: first?.albumName || '',
      artist: first?.singer || '',
      pic: txPhotoUrl('T002', albumMid),
      img: txPhotoUrl('T002', albumMid),
      trackCount: list.length,
    },
    list,
  }
  searchCache.set(cacheKey, result, 60 * 60 * 1000)
  return result
}

/** 按专辑名+歌手名找 albumMid（本地专辑进 TX 链的门；歌手+专辑双校验） */
export async function findTxAlbumId(title: string, artist: string): Promise<string | null> {
  const titleNorm = normKey(title)
  const artistNorm = normKey(artist)
  if (!titleNorm) return null
  const pages = await Promise.all([
    searchTxSongsRaw(`${title} ${artist}`.trim(), 1, 30),
    searchTxSongsRaw(title, 1, 30),
  ])
  const hit = pages.flat().find(s => {
    if (!s.album?.mid) return false
    const a = normKey(s.album?.name)
    const singers = (s.singer || []).map(x => normKey(x.name)).filter(Boolean)
    if (!a.includes(titleNorm) && !titleNorm.includes(a)) return false
    if (!artistNorm) return true
    return singers.some(n => !n || n.includes(artistNorm) || artistNorm.includes(n))
  })
  return hit?.album?.mid ?? null
}

// ---------------------------------------------------------------------------
// MV 列表（fcg_singer_mv 明文老接口，免登录）
// ---------------------------------------------------------------------------

export interface TxMusicVideo {
  vid: string
  title: string
  pic: string | null
  durationSec?: number
}

export async function getTxArtistMvs(singerMid: string, limit = 12): Promise<TxMusicVideo[]> {
  const cacheKey = `tx:mvs:${singerMid}`
  const cached = searchCache.get(cacheKey) as TxMusicVideo[] | null
  if (cached) return cached
  try {
    const j = await polite('c.y.qq.com', async () => {
      const resp = await fetch(`https://c.y.qq.com/mv/fcgi-bin/fcg_singer_mv.fcg?cv=4747474&ct=24&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=1&uin=0&singermid=${encodeURIComponent(singerMid)}&cid=205360581&order=time&begin=0&num=${Math.min(limit, 20)}&cmd=1`, {
        headers: { 'User-Agent': WEB_UA, Referer: 'https://y.qq.com/' },
        signal: AbortSignal.timeout(TX_TIMEOUT),
      })
      if (!resp.ok) throw new Error(`fcg_singer_mv HTTP ${resp.status}`)
      return await resp.json() as { code?: number; data?: { list?: Array<{ vid?: string; title?: string; pic?: string; duration?: number }> } }
    })
    const list = (j?.data?.list || [])
      .filter(m => m.vid && m.title)
      .slice(0, limit)
      .map(m => ({ vid: m.vid!, title: clean(m.title), pic: m.pic || null, ...(m.duration ? { durationSec: m.duration } : {}) }))
    if (list.length > 0) searchCache.set(cacheKey, list, CACHE_TTL)
    return list
  } catch (error) {
    logger.warn('[tx-chain] MV 列表获取失败:', error instanceof Error ? error.message : error)
    return []
  }
}

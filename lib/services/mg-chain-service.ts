/**
 * 咪咕 www 链路服务（歌手/专辑全链数据 + 直接可播 songId）
 *
 * 接口面（2026-09 三份 HAR 实测，全部免登录——网页"登录墙"仅前端行为，
 * API 只需标准 channel/timestamp 头；cookie 剥除验证通过）：
 * - 搜歌手  app.u.nf.migu.cn/pc/resource/search/singer/v1.0（卡片自带 3 尺寸头像 + 百科 summary）
 * - 搜专辑  app.u.nf.migu.cn/pc/bmw/album/search/v1.0（分页，result[] 平铺）
 * - 搜歌    app.u.nf.migu.cn/pc/resource/song/item/search/v1.0（裸数组 songItem）
 * - 歌手信息/歌曲/专辑  app.c.nf.migu.cn/pc/bmw/singer/{info,song,album}（歌曲 50/页，view 结构）
 * - 专辑信息/曲目  app.c.nf.migu.cn/{resource/album/v2.0, MIGUM3.0/resource/album/song/v2.0}
 *   （信息含 summary 简介 + publishCorp 唱片公司；曲目 pageSize=200 一次整张）
 *
 * 已知坑：
 * - 专辑双 ID：老 albumId（114xxxxx）可直接查详情；column id（6009 开头，数字专辑形态）
 *   查详情返回 code=000000 但数据全空——须按专辑名搜索归一到老 albumId
 * - 歌手歌曲是 view 嵌套结构（ZJ-Singer-Song-Item.songItem 为数据体）
 * - songItem.showTags 含 vip 标记（咪咕版权口径），可播率与酷我互补
 *
 * songId/copyrightId/audioFormats 与 music-core 老 mg 源完全同构：
 * songmid=songId → uid=`mg-{songId}` 直接走现有播放管道。
 */

import { searchCache } from '@/lib/cache-manager'
import { upsertMusicInfosInTransaction, getStorageSongmidForMusicInfo } from '@/lib/db'
import { logger } from '@/lib/logger'
import { appleT2S } from '@/lib/services/itunes-service'
import type { MusicInfo, QualityType } from '@/lib/types/music'

const MG_TIMEOUT = 8_000
const POLITENESS_INTERVAL = 100
const CACHE_TTL = 24 * 60 * 60 * 1000

/** 浏览器标准头（channel/timestamp 系咪咕放行条件，登录态非必需） */
function mgHeaders(): Record<string, string> {
  return {
    accept: 'application/json, text/plain, */*',
    activityid: 'MUSIC-WWW',
    appid: 'h5',
    channel: '014X031',
    deviceid: 'ED6DBC4D-3BE0-4EAE-BF6A-17FB8D80E385',
    imei: 'h5page',
    imsi: 'h5page',
    logid: 'cfrom=&appId=h5',
    pacmtoken: '',
    platform: 'H5',
    subchannel: '014X031',
    test: '00',
    timestamp: String(Date.now()),
    ua: 'Android_migu',
    uid: '',
    Referer: 'https://music.migu.cn/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  }
}

/** 礼貌队列：相邻咪咕请求间隔 ≥100ms（按主机分道） */
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

async function mgGetJson<T>(url: string): Promise<T | null> {
  const host = new URL(url).host
  try {
    const j = await polite(host, async () => {
      const resp = await fetch(url, {
        headers: mgHeaders(),
        signal: AbortSignal.timeout(MG_TIMEOUT),
      })
      if (!resp.ok) throw new Error(`咪咕接口 HTTP ${resp.status}`)
      return await resp.json() as T
    })
    return j
  } catch (error) {
    logger.warn(`[mg-chain] ${host} 请求失败:`, error instanceof Error ? error.message : error)
    return null
  }
}

/** 数据清洗：繁→简 + 去首尾空白（咪咕偶有繁体） */
function clean(value: string | null | undefined): string {
  return appleT2S(value || '').trim()
}

/** 归一化比对键：简体+小写+去非字母数字（"完全匹配"判定用） */
function normKey(value: string | null | undefined): string {
  return appleT2S(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** 秒 → "mm:ss"（与 music-core mg 搜索 interval 格式一致） */
function secsToInterval(secs: number | string | null | undefined): string {
  const n = Number(secs)
  if (!Number.isFinite(n) || n <= 0) return '00:00'
  const m = Math.floor(n / 60)
  const s = Math.floor(n % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// songItem → MusicInfo（与 music-core 老 mg 搜索同一映射：songmid=songId）
// ---------------------------------------------------------------------------

/** 咪咕 songItem 原始结构（搜索/专辑曲目/歌手歌曲三处同构） */
interface MgSongItem {
  songId?: string | number
  songName?: string
  copyrightId?: string | number
  contentId?: string | number
  albumId?: string | number
  album?: string
  duration?: number | string
  singerList?: Array<{ name?: string }>
  singerName?: string
  img1?: string
  img2?: string
  img3?: string
  lrcUrl?: string
  audioFormats?: Array<{ formatType?: string; asize?: string | number; isize?: string | number }>
}

/** 音质映射：audioFormats.formatType → 标准 QualityInfo（PQ=128k HQ=320k SQ=flac ZQ24=flac24bit） */
function buildQualityTypes(audioFormats: MgSongItem['audioFormats']): {
  types: Array<{ type: QualityType; size: string }>
  _types: Partial<Record<QualityType, { size: string }>>
} {
  const types: Array<{ type: QualityType; size: string }> = []
  const _types: Partial<Record<QualityType, { size: string }>> = {}
  const fmtSize = (v: string | number | undefined) => {
    const n = Number(v || 0)
    if (!Number.isFinite(n) || n <= 0) return '0B'
    return `${(n / 1024 / 1024).toFixed(2)}M`
  }
  for (const f of audioFormats || []) {
    const size = fmtSize(f.asize ?? f.isize)
    const map: Record<string, QualityType> = { PQ: '128k', HQ: '320k', SQ: 'flac', ZQ24: 'flac24bit' }
    const type = f.formatType ? map[f.formatType] : undefined
    if (type) {
      types.push({ type, size })
      _types[type] = { size }
    }
  }
  return { types, _types }
}

/** 咪咕 songItem → mg MusicInfo（uid 由入库方附加；songmid=songId 与 music-core 一致） */
export function mgSongToMusicInfo(item: MgSongItem, fallbackAlbum?: { name?: string; pic?: string | null }): MusicInfo | null {
  if (!item.songId || !item.songName) return null
  let img: string | null = item.img3 || item.img2 || item.img1 || null
  if (img && !/^https?:/.test(img)) img = `https://d.musicapp.migu.cn${img}`
  if (!img && fallbackAlbum?.pic) img = fallbackAlbum.pic
  const { types, _types } = buildQualityTypes(item.audioFormats)
  return {
    name: clean(item.songName),
    singer: item.singerList?.length
      ? item.singerList.map(s => clean(s.name)).filter(Boolean).join('、') || '未知歌手'
      : clean(item.singerName) || '未知歌手',
    source: 'mg',
    songmid: String(item.songId),
    ...(item.copyrightId != null ? { copyrightId: String(item.copyrightId) } : {}),
    ...(item.albumId != null ? { albumId: String(item.albumId) } : {}),
    albumName: clean(item.album) || clean(fallbackAlbum?.name) || '',
    interval: secsToInterval(item.duration),
    img,
    ...(item.lrcUrl ? { lrcUrl: item.lrcUrl } : {}),
    types,
    _types: _types as MusicInfo['_types'],
    typeUrl: {},
  }
}

/** imgItems/imgs 取最大尺寸图（03 最大） */
function pickLargestImg(items?: Array<{ imgSizeType?: string; img?: string }>): string | null {
  if (!items?.length) return null
  const bySize = (t: string) => items.find(i => i.imgSizeType === t)?.img
  return bySize('03') || bySize('02') || items[0]?.img || null
}

// ---------------------------------------------------------------------------
// 接口：搜索（app.u.nf.migu.cn，免登录）
// ---------------------------------------------------------------------------

export interface MgArtistCard {
  source: 'mg'
  /** 咪咕 singerId（详情/歌曲/专辑全集的钥匙） */
  artistId: string
  name: string
  /** 官方头像（d.musicapp.migu.cn，3 尺寸取最大） */
  pic: string | null
}

export async function searchMgArtists(keyword: string, limit = 10): Promise<MgArtistCard[]> {
  const q = keyword.trim()
  if (!q) return []
  const cacheKey = `mg:searchArtist:${q}`
  const cached = searchCache.get(cacheKey) as MgArtistCard[] | null
  if (cached) return cached

  interface Raw { code?: string; data?: Array<{ singerId?: string | number; singer?: string; imgs?: Array<{ imgSizeType?: string; img?: string }> }> }
  const j = await mgGetJson<Raw>(`https://app.u.nf.migu.cn/pc/resource/search/singer/v1.0?text=${encodeURIComponent(q)}`)
  const list = (Array.isArray(j?.data) ? j!.data! : [])
    .filter(s => s.singerId != null && s.singer)
    .slice(0, limit)
    .map(s => ({
      source: 'mg' as const,
      artistId: String(s.singerId),
      name: clean(s.singer),
      pic: pickLargestImg(s.imgs),
    }))
  if (list.length > 0) searchCache.set(cacheKey, list, CACHE_TTL)
  return list
}

/** 按歌手名取百科简介（咪咕的简介只在搜索接口返回，singer/info 无简介；
 *  简介归属用 singerId 精确锚定，避免同名错配） */
export async function getMgArtistBio(singerId: string, name: string): Promise<string | null> {
  const cacheKey = `mg:artistBio:${singerId}`
  const cached = searchCache.get(cacheKey) as string | null
  if (cached !== null && cached !== undefined) return cached || null

  interface Raw { code?: string; data?: Array<{ singerId?: string | number; singer?: string; summary?: string }> }
  const j = await mgGetJson<Raw>(`https://app.u.nf.migu.cn/pc/resource/search/singer/v1.0?text=${encodeURIComponent(name)}`)
  const hit = (Array.isArray(j?.data) ? j!.data! : []).find(s => String(s.singerId) === singerId)
  const bio = hit?.summary ? clean(hit.summary).slice(0, 1000) || null : null
  // null 不缓存（与命中不可区分），靠上游搜索缓存兜底
  if (bio) searchCache.set(cacheKey, bio, CACHE_TTL)
  return bio
}

export interface MgAlbumCard {
  source: 'mg'
  /** 老版 albumId（114xxxxx；column id 已归一，可直接查专辑详情） */
  albumId: string
  name: string
  artist: string
  /** 3 尺寸取最大（d.musicapp.migu.cn），pic/img 同值双口径（前端统一消费 img） */
  pic: string | null
  img: string | null
  year?: string
}

export async function searchMgAlbums(keyword: string, limit = 30): Promise<MgAlbumCard[]> {
  const q = keyword.trim()
  if (!q) return []
  const cacheKey = `mg:searchAlbum:${q}:${limit}`
  const cached = searchCache.get(cacheKey) as MgAlbumCard[] | null
  if (cached) return cached

  interface RawItem { id?: string | number; resourceType?: string; name?: string; singer?: string; publishDate?: string; imgItems?: Array<{ imgSizeType?: string; img?: string }> }
  interface Raw { code?: string; data?: { totalCount?: string; result?: RawItem[] } }
  const j = await mgGetJson<Raw>(`https://app.u.nf.migu.cn/pc/bmw/album/search/v1.0?text=${encodeURIComponent(q)}&pageNo=1&pageSize=${Math.min(limit, 30)}`)
  const result = j?.data?.result || []
  // resourceType=5 为 column（数字专辑）形态，其 id 查专辑详情返回空数据——只收老 albumId（2003）
  const list = result
    .filter(a => a.id != null && a.name && a.resourceType !== '5')
    .slice(0, limit)
    .map(a => ({
      source: 'mg' as const,
      albumId: String(a.id),
      name: clean(a.name),
      artist: clean(a.singer),
      pic: pickLargestImg(a.imgItems),
      img: pickLargestImg(a.imgItems),
      ...(a.publishDate ? { year: a.publishDate.slice(0, 10) } : {}),
    }))
  if (list.length > 0) searchCache.set(cacheKey, list, CACHE_TTL)
  return list
}

// ---------------------------------------------------------------------------
// 接口：歌手详情三件套（app.c.nf.migu.cn，view 嵌套结构）
// ---------------------------------------------------------------------------

export interface MgArtistInfo {
  artistId: string
  name: string
  pic: string | null
  img: string | null
}

/** 歌手信息：singer/info/v1.1（view 结构，只有名字+头像；简介走 getMgArtistBio） */
export async function getMgArtistInfo(singerId: string): Promise<MgArtistInfo | null> {
  const cacheKey = `mg:artistInfo:${singerId}`
  const cached = searchCache.get(cacheKey) as MgArtistInfo | null
  if (cached) return cached

  interface RawItem { view?: string; txt?: string; img?: string }
  interface Raw { code?: string; data?: { contents?: Array<{ contents?: RawItem[] }> } }
  const j = await mgGetJson<Raw>(`https://app.c.nf.migu.cn/pc/bmw/singer/info/v1.1?singerId=${encodeURIComponent(singerId)}`)
  const items = (j?.data?.contents || []).flatMap(c => c.contents || [])
  const nameItem = items.find(i => i.view === 'ZJ-SingerDetail-Item')
  if (!nameItem?.txt) return null
  const info: MgArtistInfo = {
    artistId: singerId,
    name: clean(nameItem.txt),
    pic: nameItem.img || null,
    img: nameItem.img || null,
  }
  searchCache.set(cacheKey, info, CACHE_TTL)
  return info
}

/** 歌手歌曲：singer/song/v1.0 分页 50/页（并发拉前 2 页 = 100 首，view 内 songItem 为数据体） */
export async function getMgArtistSongs(
  singerId: string,
  limit = 100,
): Promise<{ total: number; list: MusicInfo[] } | null> {
  const cacheKey = `mg:artistSongs:${singerId}:${limit}`
  const cached = searchCache.get(cacheKey) as { total: number; list: MusicInfo[] } | null
  if (cached) return cached

  interface Raw { code?: string; data?: { contents?: Array<{ contents?: Array<{ view?: string; songItem?: MgSongItem }> }>; header?: { nextPageNo?: number } } }
  const pages = Math.min(Math.ceil(limit / 50), 2)
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      mgGetJson<Raw>(`https://app.c.nf.migu.cn/pc/bmw/singer/song/v1.0?pageNo=${i + 1}&singerId=${encodeURIComponent(singerId)}&type=1`)),
  )
  const items = results.flatMap(r => (r?.data?.contents || []).flatMap(c => c.contents || []))
    .filter(n => n.view === 'ZJ-Singer-Song-Item' && n.songItem)
    .map(n => n.songItem!)
  if (items.length === 0) return null
  const list = items
    .map(item => mgSongToMusicInfo(item))
    .filter((m): m is MusicInfo => m !== null)
    .slice(0, limit)
  if (list.length === 0) return null
  const result = { total: items.length >= 50 ? -1 : items.length, list }
  searchCache.set(cacheKey, result, CACHE_TTL)
  return result
}

/** 歌手专辑全集：singer/album/v1.0（data.contents 平铺 ZJ-Album-Item：txt=名/txt2=歌手/txt3=日期；
 *  column id 条目（6009 开头，resType=5）查详情为空数据 → 按名搜索归一到老 albumId，失败丢弃） */
export async function getMgArtistAlbums(singerId: string, limit = 30): Promise<MgAlbumCard[]> {
  const cacheKey = `mg:artistAlbums:${singerId}:${limit}`
  const cached = searchCache.get(cacheKey) as MgAlbumCard[] | null
  if (cached) return cached

  interface RawItem { view?: string; txt?: string; txt2?: string; txt3?: string; img?: string; resId?: string; resType?: string }
  interface Raw { code?: string; data?: { contents?: RawItem[] } }
  const pages = Math.min(Math.ceil(limit / 10), 3)
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      mgGetJson<Raw>(`https://app.c.nf.migu.cn/pc/bmw/singer/album/v1.0?pageNo=${i + 1}&singerId=${encodeURIComponent(singerId)}`)),
  )
  const items = results.flatMap(r => r?.data?.contents || [])
    .filter(n => n.view === 'ZJ-Album-Item' && n.resId && n.txt)
    .slice(0, limit + 5)

  // column id（6009 开头）不在此归一：归一需 N 次搜索请求被礼貌队列串行化（实测 22 张专辑 12s）。
  // column 卡直接透传，专辑详情路由按名字降级链（kw→mg重搜→apple）兜底——覆盖更好（column-only
  // 数字专辑也能展示，点击走其他源）且详情有 24h 缓存，冷启动 ≈2s。
  const cards: MgAlbumCard[] = items.map(it => ({
    source: 'mg' as const,
    albumId: it.resId!,
    name: clean(it.txt),
    artist: clean(it.txt2),
    pic: it.img || null,
    img: it.img || null,
    ...(/^\d{4}(-\d{2}){0,2}/.exec((it.txt3 || '').trim()) ? { year: /^\d{4}(-\d{2}){0,2}/.exec((it.txt3 || '').trim())![0] } : {}),
  })).slice(0, limit)
  if (cards.length > 0) searchCache.set(cacheKey, cards, CACHE_TTL)
  return cards
}

// ---------------------------------------------------------------------------
// 接口：专辑详情（老 albumId 直查，两接口并行）
// ---------------------------------------------------------------------------

export interface MgAlbumDetail {
  album: {
    albumId: string
    name: string
    artist: string
    pic: string | null
    /** 专辑简介（咪咕 summary，2850 字级百科内容） */
    summary: string | null
    company?: string
    year?: string
  }
  tracks: MusicInfo[]
}

/** 数字专辑（column）原生详情：resourceinfo.do（专辑元信息 + 曲目 contentId 列表，免登录）
 *  → by-contentids/v2.0 一次补全标准 songItem（时长/音质）。两请求整张，曲序以专栏为准。 */
async function getMgColumnAlbumDetail(columnId: string): Promise<MgAlbumDetail | null> {
  interface ColRaw {
    code?: string
    resource?: Array<{
      title?: string; singer?: string; publishDate?: string; summary?: string
      imgItem?: Array<{ imgSizeType?: string; img?: string }>
      songItems?: Array<{ contentId?: string | number; songId?: string | number; songName?: string }>
    }>
  }
  const j = await mgGetJson<ColRaw>(`https://app.c.nf.migu.cn/v1.0/content/resourceinfo.do?needSimple=01&resourceType=5&resourceId=${encodeURIComponent(columnId)}`)
  const meta = j?.resource?.[0]
  if (!meta?.title || !meta.songItems?.length) return null

  // by-contentids 补全（data 为索引对象；失败时用 resourceinfo 基础字段兜底，缺时长/音质）
  const contentIds = meta.songItems.map(s => s.contentId).filter(Boolean).map(String)
  interface BatchRaw { code?: string; data?: Record<string, MgSongItem> }
  const batch = contentIds.length > 0
    ? await mgGetJson<BatchRaw>(`https://app.c.nf.migu.cn/resource/song/by-contentids/v2.0?contentId=${encodeURIComponent(contentIds.join('|'))}`)
    : null
  const fullByContentId = new Map<string, MgSongItem>()
  for (const item of Object.values(batch?.data || {})) {
    if (item?.contentId != null) fullByContentId.set(String(item.contentId), item)
  }

  const pic = pickLargestImg(meta.imgItem)
  const albumMeta = {
    albumId: columnId,
    name: clean(meta.title),
    artist: clean(meta.singer),
    pic,
    summary: meta.summary ? clean(meta.summary).slice(0, 1000) || null : null,
    ...(meta.publishDate ? { year: meta.publishDate.slice(0, 10) } : {}),
  }
  const tracks = meta.songItems
    .map(item => {
      const full = item.contentId != null ? fullByContentId.get(String(item.contentId)) : undefined
      return full ?? ({ songId: item.songId, songName: item.songName } as MgSongItem)
    })
    .map(item => mgSongToMusicInfo(item, { name: albumMeta.name, pic }))
    .filter((m): m is MusicInfo => m !== null)
  if (tracks.length === 0) return null
  return { album: albumMeta, tracks }
}

export async function getMgAlbumDetail(albumId: string): Promise<MgAlbumDetail | null> {
  const cacheKey = `mg:albumDetail:v2:${albumId}`
  const cached = searchCache.get(cacheKey) as MgAlbumDetail | null
  if (cached) return cached

  // 数字专辑（column id，6009 开头）走专栏原生链；老 albumId 走传统两接口
  if (albumId.startsWith('6009')) {
    const detail = await getMgColumnAlbumDetail(albumId)
    if (detail) searchCache.set(cacheKey, detail, CACHE_TTL)
    return detail
  }

  interface AlbumInfoRaw {
    code?: string
    data?: { title?: string; singer?: string; singerId?: string; imgItems?: Array<{ imgSizeType?: string; img?: string }>; summary?: string; publishCorp?: string; publishTime?: string; publishDate?: string; totalCount?: string }
  }
  interface AlbumSongsRaw { code?: string; data?: { songList?: MgSongItem[]; totalCount?: string } }
  const [infoRaw, songsRaw] = await Promise.all([
    mgGetJson<AlbumInfoRaw>(`https://app.c.nf.migu.cn/resource/album/v2.0?albumId=${encodeURIComponent(albumId)}`),
    mgGetJson<AlbumSongsRaw>(`https://app.c.nf.migu.cn/MIGUM3.0/resource/album/song/v2.0?pageNo=1&pageSize=200&albumId=${encodeURIComponent(albumId)}`),
  ])
  // column id 假成功防御：信息为空或曲目为空均视为无效
  if (!infoRaw?.data?.title || !songsRaw?.data?.songList?.length) return null

  const pic = pickLargestImg(infoRaw.data.imgItems)
  const albumMeta = {
    albumId,
    name: clean(infoRaw.data.title),
    artist: clean(infoRaw.data.singer),
    pic,
    summary: infoRaw.data.summary ? clean(infoRaw.data.summary).slice(0, 1000) || null : null,
    ...(infoRaw.data.publishCorp ? { company: clean(infoRaw.data.publishCorp) } : {}),
    ...((infoRaw.data.publishDate || infoRaw.data.publishTime) ? { year: String(infoRaw.data.publishDate || infoRaw.data.publishTime).slice(0, 10) } : {}),
  }
  const tracks = songsRaw.data.songList
    .map(item => mgSongToMusicInfo(item, { name: albumMeta.name, pic }))
    .filter((m): m is MusicInfo => m !== null)
  if (tracks.length === 0) return null

  const detail: MgAlbumDetail = { album: albumMeta, tracks }
  searchCache.set(cacheKey, detail, CACHE_TTL)
  return detail
}

// ---------------------------------------------------------------------------
// 组装：详情整包（供 API 路由使用；入库 + 附 uid 与 kw 同策略）
// ---------------------------------------------------------------------------

async function upsertAndAttach(musicInfos: MusicInfo[]): Promise<Array<MusicInfo & { uid: string }> | null> {
  let stored = musicInfos
  try {
    await upsertMusicInfosInTransaction(musicInfos)
  } catch (error) {
    logger.warn('[mg-chain] 批量入库失败，降级逐条:', error instanceof Error ? error.message : error)
    const survivors: MusicInfo[] = []
    for (const mi of musicInfos) {
      try { await upsertMusicInfosInTransaction([mi]); survivors.push(mi) } catch { /* 跳过坏数据 */ }
    }
    if (survivors.length === 0) return null
    stored = survivors
  }
  return stored.map(mi => ({ ...mi, uid: `${mi.source}-${getStorageSongmidForMusicInfo(mi)}` }))
}

export interface MgArtistDetail {
  source: 'mg'
  artist: MgArtistInfo & { bio?: string | null }
  hotSongs: Array<MusicInfo & { uid: string }>
  albums: MgAlbumCard[]
}

/** 咪咕歌手详情整包：信息+歌曲+专辑+百科简介（简介来自搜索接口按 singerId 锚定）。缓存 1h */
export async function getMgArtistDetail(singerId: string, nameHint?: string): Promise<MgArtistDetail | null> {
  const cacheKey = `mg:artistDetail:${singerId}`
  const cached = searchCache.get(cacheKey) as MgArtistDetail | null
  if (cached) return cached

  const info = await getMgArtistInfo(singerId)
  if (!info) return null
  const [songs, albums, bio] = await Promise.all([
    getMgArtistSongs(singerId, 100),
    getMgArtistAlbums(singerId, 30),
    getMgArtistBio(singerId, nameHint || info.name),
  ])
  if (!songs || songs.list.length === 0) return null

  const hotSongs = await upsertAndAttach(songs.list)
  if (!hotSongs) return null

  const detail: MgArtistDetail = {
    source: 'mg',
    artist: { ...info, bio },
    hotSongs,
    albums,
  }
  searchCache.set(cacheKey, detail, 60 * 60 * 1000)
  return detail
}

/** 咪咕专辑详情（可播版）：两接口并行 → 批量入库附 uid。缓存 1h。
 *  album.singer 是 kw/mg/tx 详情统一的歌手字段名（咪咕上游称 artist）。 */
export async function getMgAlbumDetailPlayable(albumId: string): Promise<{
  album: MgAlbumDetail['album'] & { singer: string; trackCount: number; profile?: { releaseDate?: string; recordLabels?: string[] } }
  list: Array<MusicInfo & { uid: string }>
} | null> {
  const cacheKey = `mg:albumPlayable:v2:${albumId}`
  const cached = searchCache.get(cacheKey) as Awaited<ReturnType<typeof getMgAlbumDetailPlayable>> | null
  if (cached) return cached

  const detail = await getMgAlbumDetail(albumId)
  if (!detail) return null
  const list = await upsertAndAttach(detail.tracks)
  if (!list) return null

  const result = {
    album: {
      ...detail.album,
      singer: detail.album.artist,
      trackCount: list.length,
      ...((detail.album.year || detail.album.company) ? {
        profile: {
          ...(detail.album.year ? { releaseDate: detail.album.year } : {}),
          ...(detail.album.company ? { recordLabels: [detail.album.company] } : {}),
        },
      } : {}),
    },
    list,
  }
  searchCache.set(cacheKey, result, 60 * 60 * 1000)
  return result
}

/** 按专辑名+歌手名找咪咕 albumId（本地专辑进咪咕链的门；带歌手校验防同名错配） */
export async function findMgAlbumId(title: string, artist: string): Promise<string | null> {
  const albums = await searchMgAlbums(artist ? `${title} ${artist}` : title, 10).catch(() => [])
  const titleNorm = normKey(title)
  const artistNorm = normKey(artist)
  const hit = albums.find(a => {
    const aTitle = normKey(a.name)
    const aArtist = normKey(a.artist)
    if (!aTitle.includes(titleNorm) && !titleNorm.includes(aTitle)) return false
    return !artistNorm || !aArtist || aArtist.includes(artistNorm) || artistNorm.includes(aArtist)
  })
  return hit?.albumId ?? null
}

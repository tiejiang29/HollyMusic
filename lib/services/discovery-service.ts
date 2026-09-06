import { searchCache } from '@/lib/cache-manager'
import { getStorageSongmidForMusicInfo, upsertMusicInfosInTransaction } from '@/lib/db'
import { logger } from '@/lib/logger'
import type { MusicInfo, QualityInfo, QualityType, Song } from '@/lib/types/music'
import { createCipheriv, createHash } from 'crypto'
import { TOPLIST_BOARDS, type ToplistBoardDef } from './toplist-boards'

const QQ_MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const QQ_SINGLE_SONG_URL = 'https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg'
const CACHE_TTL = 10 * 60 * 1000
const TAG_CACHE_TTL = 60 * 60 * 1000
const REQUEST_TIMEOUT = 8_000

export interface DiscoveryToplist {
  id: string
  name: string
  description: string
  cover: string
  updateTime?: string
  source: DiscoverySource
  /** 常用榜单标记（首页横排区展示集；scope=full 时返回） */
  common?: boolean
}

export interface DiscoveryPlaylist {
  id: string
  name: string
  author: string
  description: string
  cover: string
  playCount: number
  /** 音源列表直接返回的曲目数；未返回时保持为空，避免把未知数显示成 0。 */
  songCount?: number
  source: DiscoverySource
}

export type DiscoveryPlaylistSort = 'recommend' | 'hot' | 'new' | 'collect' | 'soar'
export interface DiscoveryPlaylistFilter { tag?: string; sort?: DiscoveryPlaylistSort; keyword?: string }

/** 发现页支持的音乐平台。 */
export type DiscoverySource = 'tx' | 'wy' | 'kw' | 'kg' | 'mg'

export function isDiscoverySource(value: string | null): value is DiscoverySource {
  return value === 'tx' || value === 'wy' || value === 'kw' || value === 'kg' || value === 'mg'
}

export interface DiscoveryCollectionDetail {
  id: string
  name: string
  description: string
  cover: string
  author: string
  updateTime?: string
  tracks: Song[]
}

type QQSinger = { name?: string }
type QQFile = {
  media_mid?: string
  size_128mp3?: number
  size_320mp3?: number
  size_flac?: number
  size_hires?: number
}
type QQSong = {
  id?: number
  mid?: string
  name?: string
  title?: string
  singer?: QQSinger[]
  album?: { mid?: string; name?: string }
  interval?: number
  file?: QQFile
}

// 全量榜单清单（含各平台常用+垂直榜）迁移至 toplist-boards.ts（数据源：lx-music-desktop）。
// common 榜单沿用原有描述文案，继续作为首页"发现音乐"横排区的展示集。
function findBoardDef(source: DiscoverySource, id: string): ToplistBoardDef | undefined {
  return TOPLIST_BOARDS[source].find(item => item.id === id)
}

function getCached<T>(key: string): T | null {
  return (searchCache.get(key) as T | null) ?? null
}

function formatFileSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)}M`
}

function normalizeCover(url: string | undefined): string {
  return url?.replace(/^http:/, 'https:') ?? ''
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Referer: 'https://y.qq.com/',
        'User-Agent': 'Mozilla/5.0',
        ...init?.headers,
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`音乐平台请求失败: ${response.status}`)
    return await response.json() as T
  } finally {
    clearTimeout(timeoutId)
  }
}

async function requestMusicu<T>(body: unknown): Promise<T> {
  return fetchJson<T>(QQ_MUSICU_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function toMusicInfo(song: QQSong): MusicInfo | null {
  const songmid = song.mid?.trim()
  const mediaMid = song.file?.media_mid?.trim()
  if (!songmid || !mediaMid) return null

  const types: QualityInfo[] = []
  const qualityMap = {} as MusicInfo['_types']
  const addQuality = (type: QualityType, bytes: number | undefined) => {
    if (!bytes || bytes <= 0) return
    const size = formatFileSize(bytes)
    types.push({ type, size })
    qualityMap[type] = { size }
  }
  addQuality('128k', song.file?.size_128mp3)
  addQuality('320k', song.file?.size_320mp3)
  addQuality('flac', song.file?.size_flac)
  addQuality('flac24bit', song.file?.size_hires)

  return {
    name: song.name || song.title || '',
    singer: song.singer?.map(item => item.name || '').filter(Boolean).join('、') || '未知歌手',
    source: 'tx',
    songmid,
    songId: song.id,
    strMediaMid: mediaMid,
    albumId: song.album?.mid || '',
    albumMid: song.album?.mid || '',
    albumName: song.album?.name || '',
    interval: String(song.interval || 0),
    img: song.album?.mid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${song.album.mid}.jpg` : null,
    types,
    _types: qualityMap,
    typeUrl: {},
  }
}

async function enrichSongs(rawSongs: QQSong[]): Promise<Song[]> {
  const songs = rawSongs.map(toMusicInfo).filter((item): item is MusicInfo => item !== null)
  return enrichMusicInfos(songs)
}

async function enrichMusicInfos(musicInfos: MusicInfo[]): Promise<Song[]> {
  // 事务失败时直接向上抛出：不能把未入库、无法播放的歌曲缓存为成功详情。
  await upsertMusicInfosInTransaction(musicInfos)
  return musicInfos.map(musicInfo => ({
    ...musicInfo,
    uid: `${musicInfo.source}-${getStorageSongmidForMusicInfo(musicInfo)}`,
  }))
}

function createQualityInfo(type: QualityType, size?: number): QualityInfo {
  return { type, size: size && size > 0 ? formatFileSize(size) : '' }
}

type WyArtist = { name?: string }
type WyAlbum = { id?: number; name?: string; picUrl?: string }
type WyQuality = { size?: number }

function toWyMusicInfo(raw: {
  id?: number; name?: string; ar?: WyArtist[]; artists?: WyArtist[]; al?: WyAlbum; album?: WyAlbum
  pc?: { ar?: string; sn?: string; alb?: string }
  dt?: number; duration?: number
  l?: WyQuality; h?: WyQuality; sq?: WyQuality; hr?: WyQuality
  lMusic?: WyQuality; bMusic?: WyQuality; hMusic?: WyQuality; sqMusic?: WyQuality; hrMusic?: WyQuality
}): MusicInfo | null {
  const name = raw.pc?.sn || raw.name
  if (!raw.id || !name) return null
  const artists = raw.ar || raw.artists || []
  const album = raw.al || raw.album
  const duration = raw.dt ?? raw.duration ?? 0
  const types: QualityInfo[] = []
  const qualityMap = {} as MusicInfo['_types']
  const add = (type: QualityType, size: number | undefined) => {
    if (!size || size <= 0) return
    const info = createQualityInfo(type, size)
    types.push(info)
    qualityMap[type] = { size: info.size }
  }
  add('128k', raw.l?.size || raw.lMusic?.size || raw.bMusic?.size)
  add('320k', raw.h?.size || raw.hMusic?.size)
  add('flac', raw.sq?.size || raw.sqMusic?.size)
  add('flac24bit', raw.hr?.size || raw.hrMusic?.size)
  return {
    name,
    singer: raw.pc?.ar || artists.map(item => item.name || '').filter(Boolean).join('、') || '未知歌手',
    source: 'wy',
    songmid: String(raw.id),
    songId: raw.id,
    albumId: album?.id ? String(album.id) : '',
    albumName: raw.pc?.alb || album?.name || '',
    interval: String(Math.round(duration / 1_000)),
    img: normalizeCover(album?.picUrl) || null,
    types,
    _types: qualityMap,
    typeUrl: {},
  }
}

function toKwMusicInfo(raw: {
  id?: string | number; name?: string; artist?: string; album?: string; albumid?: string | number
  duration?: string | number; pic?: string; formats?: string
}): MusicInfo | null {
  if (!raw.id || !raw.name) return null
  const formats = raw.formats || ''
  const types: QualityInfo[] = []
  const qualityMap = {} as MusicInfo['_types']
  const add = (type: QualityType, present: boolean) => {
    if (!present) return
    types.push({ type, size: '' })
    qualityMap[type] = { size: '' }
  }
  add('128k', /MP3128|ZPGA201/.test(formats))
  add('320k', /MP3H|ZPGA501/.test(formats))
  add('flac', /ALFLAC|ZPGA714/.test(formats))
  if (types.length === 0) add('128k', true)
  return {
    name: raw.name,
    singer: raw.artist || '未知歌手',
    source: 'kw',
    songmid: String(raw.id),
    albumId: raw.albumid ? String(raw.albumid) : '',
    albumName: raw.album || '',
    interval: String(raw.duration || 0),
    img: normalizeCover(raw.pic),
    types,
    _types: qualityMap,
    typeUrl: {},
  }
}

type KgSong = {
  audio_id?: string | number
  songname?: string
  filename?: string
  authors?: Array<{ author_name?: string }>
  remark?: string
  album_id?: string | number
  duration?: string | number
  album_sizable_cover?: string
  trans_param?: { union_cover?: string }
  hash?: string
  filesize?: number
  '320filesize'?: number
  '320hash'?: string
  sqfilesize?: number
  sqhash?: string
  filesize_high?: number
  hash_high?: string
}

function toKgMusicInfo(raw: KgSong): MusicInfo | null {
  if (!raw.audio_id || !(raw.songname || raw.filename)) return null
  const types: QualityInfo[] = []
  const qualityMap = {} as MusicInfo['_types']
  const add = (type: QualityType, size: number | undefined, hash: string | undefined) => {
    if (!size || size <= 0 || !hash) return
    const info = createQualityInfo(type, size)
    types.push({ ...info, hash })
    qualityMap[type] = { size: info.size, hash }
  }
  add('128k', raw.filesize, raw.hash)
  add('320k', raw['320filesize'], raw['320hash'])
  add('flac', raw.sqfilesize, raw.sqhash)
  add('flac24bit', raw.filesize_high, raw.hash_high)
  if (types.length === 0 && raw.hash) {
    types.push({ type: '128k', size: '', hash: raw.hash })
    qualityMap['128k'] = { size: '', hash: raw.hash }
  }
  const filenameParts = raw.filename?.split(' - ') || []
  return {
    name: raw.songname || filenameParts.slice(1).join(' - ') || raw.filename || '',
    singer: raw.authors?.map(item => item.author_name || '').filter(Boolean).join('、') || filenameParts[0] || '未知歌手',
    source: 'kg',
    songmid: String(raw.audio_id),
    albumId: raw.album_id ? String(raw.album_id) : '',
    albumName: raw.remark || '',
    interval: String(raw.duration || 0),
    img: normalizeCover((raw.album_sizable_cover || raw.trans_param?.union_cover || '').replace('{size}', '400')) || null,
    hash: raw.hash,
    types,
    _types: qualityMap,
    typeUrl: {},
  }
}

type MgFormat = { formatType?: string; size?: number; androidSize?: number; isize?: number }
type MgSong = {
  songId?: string | number
  songName?: string
  artists?: Array<{ name?: string }>
  singerList?: Array<{ name?: string }>
  albumId?: string | number
  album?: string
  albumImgs?: Array<{ img?: string }>
  img1?: string
  img2?: string
  img3?: string
  duration?: string | number
  length?: string
  copyrightId?: string | number
  newRateFormats?: MgFormat[]
  audioFormats?: MgFormat[]
  lrcUrl?: string
  mrcUrl?: string
  trcUrl?: string
}

function normalizeMgCover(url: string | undefined): string {
  if (!url) return ''
  return normalizeCover(/^https?:/.test(url) ? url : `https://d.musicapp.migu.cn${url}`)
}

function toMgMusicInfo(raw: MgSong): MusicInfo | null {
  if (!raw.songId || !raw.songName) return null
  const types: QualityInfo[] = []
  const qualityMap = {} as MusicInfo['_types']
  const typeMap: Record<string, QualityType> = { PQ: '128k', HQ: '320k', SQ: 'flac', ZQ: 'flac24bit', ZQ24: 'flac24bit' }
  for (const format of raw.audioFormats || raw.newRateFormats || []) {
    const type = typeMap[format.formatType || '']
    if (!type || qualityMap[type]) continue
    const info = createQualityInfo(type, format.size || format.androidSize || format.isize)
    types.push(info)
    qualityMap[type] = { size: info.size }
  }
  if (types.length === 0) {
    types.push({ type: '128k', size: '' })
    qualityMap['128k'] = { size: '' }
  }
  const duration = typeof raw.duration === 'number'
    ? Math.round(raw.duration)
    : raw.duration || raw.length || 0
  return {
    name: raw.songName,
    singer: (raw.singerList || raw.artists || []).map(item => item.name || '').filter(Boolean).join('、') || '未知歌手',
    source: 'mg',
    songmid: String(raw.songId),
    albumId: raw.albumId ? String(raw.albumId) : '',
    albumName: raw.album || '',
    interval: String(duration),
    img: normalizeMgCover(raw.img3 || raw.img2 || raw.img1 || raw.albumImgs?.[0]?.img) || null,
    copyrightId: raw.copyrightId ? String(raw.copyrightId) : undefined,
    lrcUrl: raw.lrcUrl,
    mrcUrl: raw.mrcUrl,
    trcUrl: raw.trcUrl,
    types,
    _types: qualityMap,
    typeUrl: {},
  }
}

// ==================== 网易云 linuxapi 加密（参考洛雪 musicSdk/wy/utils/crypto.js） ====================

const LINUXAPI_KEY = Buffer.from('rFgB&h#%2?^eDg:Q', 'utf-8')

/**
 * 网易云 linuxapi 加密：AES-128-ECB（NoPadding），输出 hex 大写
 * 用于走 api/linux/forward 通道，支持大歌单和私有歌单
 */
function linuxapiEncrypt(obj: unknown): string {
  const text = JSON.stringify(obj)
  const buf = Buffer.from(text, 'utf-8')
  // 手动 PKCS7 NoPadding（补齐到 16 字节倍数，用 \0 填充——洛雪用 ECB NoPadding 即零填充）
  const padLen = 16 - (buf.length % 16)
  const padded = Buffer.concat([buf, Buffer.alloc(padLen, 0)])
  const cipher = createCipheriv('aes-128-ecb', LINUXAPI_KEY, null)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('hex').toUpperCase()
}

// ==================== 酷狗签名（参考洛雪 musicSdk/kg/util.js） ====================

const KG_WEB_KEY = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'

function kgSign(paramsStr: string): string {
  const sorted = paramsStr.split('&').sort().join('')
  return createHash('md5').update(`${KG_WEB_KEY}${sorted}${KG_WEB_KEY}`).digest('hex')
}

async function getWyPlaylistDetail(id: string, cookie?: string): Promise<DiscoveryCollectionDetail | null> {
  // 优先走洛雪的 linuxapi 通道（支持大歌单 1000 首/页 + 私有歌单 Cookie）
  const linuxResult = await getWyPlaylistDetailViaLinuxApi(id, cookie)
  if (linuxResult) return linuxResult

  // 回退到老公开 API（linuxapi 失败时兜底）
  logger.debug('[discovery] linuxapi 失败，回退到老公开 API: wy playlist', id)
  const payload = await fetchJson<{ result?: { name?: string; description?: string; coverImgUrl?: string; creator?: { nickname?: string }; tracks?: Parameters<typeof toWyMusicInfo>[0][] } }>(`https://music.163.com/api/playlist/detail?id=${encodeURIComponent(id)}`, cookie ? { headers: { Cookie: cookie, Referer: 'https://music.163.com/' } } : undefined)
  const playlist = payload.result
  if (!playlist?.tracks) return null
  return {
    id,
    name: playlist.name || '',
    description: playlist.description || '',
    cover: normalizeCover(playlist.coverImgUrl),
    author: playlist.creator?.nickname || '网易云音乐',
    tracks: await enrichMusicInfos(playlist.tracks.map(toWyMusicInfo).filter((item): item is MusicInfo => item !== null)),
  }
}

/**
 * 网易云歌单详情（洛雪 linuxapi 方案）：
 * POST music.163.com/api/linux/forward（AES-ECB 加密）→ api/v3/playlist/detail
 * 优势：1000 首/页、trackIds 全量返回、支持 Cookie 解锁私有歌单
 */
async function getWyPlaylistDetailViaLinuxApi(id: string, cookie?: string): Promise<DiscoveryCollectionDetail | null> {
  try {
    const eparams = linuxapiEncrypt({
      method: 'POST',
      url: 'https://music.163.com/api/v3/playlist/detail',
      params: { id: Number(id), n: 1000, s: 8 },
    })
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/60.0.3112.90 Safari/537.36',
      'Content-Type': 'application/x-www-form-urlencoded',
    }
    if (cookie) headers['Cookie'] = cookie

    const resp = await fetch('https://music.163.com/api/linux/forward', {
      method: 'POST',
      headers,
      body: `eparams=${eparams}`,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })
    if (!resp.ok) return null
    const body = await resp.json() as {
      code?: number
      playlist?: {
        name?: string
        description?: string
        coverImgUrl?: string
        creator?: { nickname?: string }
        trackIds?: Array<{ id: number }>
        tracks?: Parameters<typeof toWyMusicInfo>[0][]
      }
      privileges?: unknown[]
    }
    if (body.code !== 200 || !body.playlist) return null
    const pl = body.playlist

    // 如果 tracks 与 trackIds 数量匹配，直接用 tracks（1000 首以内）
    const wyTracks = pl.tracks ?? []
    if (wyTracks.length === 0 && (pl.trackIds?.length ?? 0) > 0) {
      // trackIds 存在但 tracks 为空 → 需要走 song/detail 批量拉（此处简化，留作 TODO）
      logger.debug('[discovery] wy playlist has trackIds but no tracks, count:', pl.trackIds?.length)
    }

    if (wyTracks.length === 0) return null
    return {
      id,
      name: pl.name || '',
      description: pl.description || '',
      cover: normalizeCover(pl.coverImgUrl),
      author: pl.creator?.nickname || '网易云音乐',
      tracks: await enrichMusicInfos(wyTracks.map(toWyMusicInfo).filter((item): item is MusicInfo => item !== null)),
    }
  } catch (error) {
    logger.debug('[discovery] wy linuxapi error:', error)
    return null
  }
}

async function getKwPlaylistDetail(id: string): Promise<DiscoveryCollectionDetail | null> {
  const payload = await fetchJson<{ result?: string; title?: string; info?: string; pic?: string; uname?: string; musiclist?: Parameters<typeof toKwMusicInfo>[0][] }>(`http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=${encodeURIComponent(id)}&pn=0&rn=100&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1`)
  if (payload.result !== 'ok' || !payload.musiclist) return null
  return {
    id,
    name: payload.title || '',
    description: payload.info || '',
    cover: normalizeCover(payload.pic),
    author: payload.uname || '酷我音乐',
    tracks: await enrichMusicInfos(payload.musiclist.map(toKwMusicInfo).filter((item): item is MusicInfo => item !== null)),
  }
}

async function getWyToplistDetail(id: string): Promise<DiscoveryCollectionDetail | null> {
  return getWyPlaylistDetail(id)
}

async function getKwToplistDetail(id: string): Promise<DiscoveryCollectionDetail | null> {
  const payload = await fetchJson<{ name?: string; info?: string; pic?: string; pub?: string; musiclist?: Parameters<typeof toKwMusicInfo>[0][] }>(`http://kbangserver.kuwo.cn/ksong.s?from=pc&fmt=json&pn=0&rn=100&type=bang&data=content&id=${encodeURIComponent(id)}&show_copyright_off=0&pcmp4=1&isbang=1`)
  if (!payload.musiclist) return null
  return {
    id,
    name: payload.name || '',
    description: payload.info || '',
    cover: normalizeCover(payload.pic),
    author: '酷我音乐',
    updateTime: payload.pub,
    tracks: await enrichMusicInfos(payload.musiclist.map(toKwMusicInfo).filter((item): item is MusicInfo => item !== null)),
  }
}

async function getKgToplistDetail(id: string): Promise<DiscoveryCollectionDetail | null> {
  const payload = await fetchJson<{ data?: { total?: number; info?: KgSong[] } }>(`http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=1&plat=0&pagesize=100&area_code=1&page=1&rankid=${encodeURIComponent(id)}&with_res_tag=0&show_portrait_mv=1`)
  const board = findBoardDef('kg', id)
  const songs = payload.data?.info || []
  if (songs.length === 0) return null
  return {
    id,
    name: board?.name || '酷狗音乐榜单',
    description: board?.description || '',
    cover: '',
    author: '酷狗音乐',
    tracks: await enrichMusicInfos(songs.map(toKgMusicInfo).filter((item): item is MusicInfo => item !== null)),
  }
}

async function getMgToplistDetail(id: string): Promise<DiscoveryCollectionDetail | null> {
  const payload = await fetchJson<{ code?: string; columnInfo?: { columnTitle?: string; columnUpdateTime?: string; contents?: Array<{ objectInfo?: MgSong }> } }>(`https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/querycontentbyId.do?columnId=${encodeURIComponent(id)}&needAll=0`)
  const board = findBoardDef('mg', id)
  const songs = payload.columnInfo?.contents?.map(item => item.objectInfo).filter((item): item is MgSong => Boolean(item)) || []
  if (payload.code !== '000000' || songs.length === 0) return null
  return {
    id,
    name: payload.columnInfo?.columnTitle || board?.name || '咪咕音乐榜单',
    description: board?.description || '',
    cover: '',
    author: '咪咕音乐',
    updateTime: payload.columnInfo?.columnUpdateTime,
    tracks: await enrichMusicInfos(songs.map(toMgMusicInfo).filter((item): item is MusicInfo => item !== null)),
  }
}

type KgPlaylistInfo = {
  specialid?: string | number
  specialname?: string
  nickname?: string
  intro?: string
  imgurl?: string
  playcount?: number
  songcount?: number
}

async function getKgPlaylistDetail(id: string): Promise<DiscoveryCollectionDetail | null> {
  // 优先走洛雪的签名 API（song_v2 支持分页 300/页，大歌单不截断）
  const signedResult = await getKgPlaylistDetailViaSongV2(id)
  if (signedResult) return signedResult

  // 回退到老 v3 API（签名失败时兜底）
  logger.debug('[discovery] kg song_v2 失败，回退到 v3: specialid', id)
  const [songsPayload, infoPayload] = await Promise.all([
    fetchJson<{ data?: { info?: KgSong[] } }>(`http://mobilecdnbj.kugou.com/api/v3/special/song?version=9108&specialid=${encodeURIComponent(id)}&plat=0&pagesize=100&page=1`),
    fetchJson<{ data?: KgPlaylistInfo }>(`http://mobilecdnbj.kugou.com/api/v5/special/info?specialid=${encodeURIComponent(id)}`).catch(error => {
      logger.warn('[discovery] Kugou playlist metadata request failed', error)
      return null
    }),
  ])
  const songs = songsPayload.data?.info || []
  if (songs.length === 0) return null
  const info = infoPayload?.data
  return {
    id,
    name: info?.specialname || '酷狗推荐歌单',
    description: info?.intro || '',
    cover: normalizeCover(info?.imgurl?.replace('{size}', '400')),
    author: info?.nickname || '酷狗音乐',
    tracks: await enrichMusicInfos(songs.map(toKgMusicInfo).filter((item): item is MusicInfo => item !== null)),
  }
}

/**
 * 酷狗歌单详情（洛雪签名 API 方案）：
 * info_v2 获取总数 → song_v2 分页拉全量（300/页）
 * 签名与洛雪 musicSdk/kg/songList.js 的 getUserListDetail2 一致
 */
async function getKgPlaylistDetailViaSongV2(id: string): Promise<DiscoveryCollectionDetail | null> {
  const KG_MID = '1586163242519'
  const KG_HEADERS: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38',
    Referer: 'https://m3ws.kugou.com/share/index.php',
    mid: KG_MID,
    dfid: '-',
    clienttime: KG_MID,
  }
  try {
    // 1: 获取歌单元数据（含总数）
    const infoParams = `appid=1058&specialid=0&global_specialid=${id}&format=jsonp&srcappid=2919&clientver=20000&clienttime=${KG_MID}&mid=${KG_MID}&uuid=${KG_MID}&dfid=-`
    const infoSig = kgSign(infoParams)
    const infoResp = await fetch(
      `https://mobiles.kugou.com/api/v5/special/info_v2?${infoParams}&signature=${infoSig}`,
      { headers: KG_HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT) },
    )
    if (!infoResp.ok) return null
    const infoData = (await infoResp.json()) as {
      data?: { specialname?: string; songcount?: number; nickname?: string; intro?: string; imgurl?: string }
    }
    const info = infoData?.data
    if (!info || (info.songcount ?? 0) === 0) return null
    const total = info.songcount!

    // 2: 分页拉全量歌曲（300/页）
    const allSongs: KgSong[] = []
    const pagesize = 300
    const pageCount = Math.ceil(total / pagesize)
    for (let page = 1; page <= pageCount; page++) {
      const songParams = `appid=1058&global_specialid=${id}&specialid=0&plat=0&version=8000&page=${page}&pagesize=${pagesize}&srcappid=2919&clientver=20000&clienttime=${KG_MID}&mid=${KG_MID}&uuid=${KG_MID}&dfid=-`
      const songSig = kgSign(songParams)
      const songResp = await fetch(
        `https://mobiles.kugou.com/api/v5/special/song_v2?${songParams}&signature=${songSig}`,
        { headers: KG_HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT) },
      )
      if (!songResp.ok) break
      const songData = (await songResp.json()) as { data?: { info?: KgSong[] } }
      const songs = songData?.data?.info ?? []
      allSongs.push(...songs)
      if (songs.length < pagesize) break // 最后一页
    }

    if (allSongs.length === 0) return null
    return {
      id,
      name: info.specialname || '酷狗推荐歌单',
      description: info.intro || '',
      cover: normalizeCover(info.imgurl?.replace('{size}', '400')),
      author: info.nickname || '酷狗音乐',
      tracks: await enrichMusicInfos(allSongs.map(toKgMusicInfo).filter((item): item is MusicInfo => item !== null)),
    }
  } catch (error) {
    logger.debug('[discovery] kg song_v2 error:', error)
    return null
  }
}

async function getMgPlaylistDetail(id: string): Promise<DiscoveryCollectionDetail | null> {
  const headers = { Referer: 'https://m.music.migu.cn/' }
  const [songsPayload, infoPayload] = await Promise.all([
    fetchJson<{ code?: string; data?: { songList?: MgSong[] } }>(`https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0?pageNo=1&pageSize=100&playlistId=${encodeURIComponent(id)}`, { headers }),
    fetchJson<{ code?: string; data?: { title?: string; summary?: string; ownerName?: string; imgItem?: { img?: string } } }>(`https://c.musicapp.migu.cn/MIGUM3.0/resource/playlist/v2.0?playlistId=${encodeURIComponent(id)}`, { headers }),
  ])
  const songs = songsPayload.data?.songList || []
  if (songsPayload.code !== '000000' || songs.length === 0) return null
  const info = infoPayload.data
  return {
    id,
    name: info?.title || '咪咕推荐歌单',
    description: info?.summary || '',
    cover: normalizeMgCover(info?.imgItem?.img),
    author: info?.ownerName || '咪咕音乐',
    tracks: await enrichMusicInfos(songs.map(toMgMusicInfo).filter((item): item is MusicInfo => item !== null)),
  }
}

async function getSongsByIds(ids: number[]): Promise<Song[]> {
  const uniqueIds = [...new Set(ids.filter(Number.isFinite))].slice(0, 100)
  if (uniqueIds.length === 0) return []
  const query = new URLSearchParams({ songid: uniqueIds.join(','), format: 'json' })
  const payload = await fetchJson<{ code?: number; data?: QQSong[] }>(`${QQ_SINGLE_SONG_URL}?${query}`)
  if (payload.code !== 0 || !Array.isArray(payload.data)) throw new Error('QQ 音乐未返回歌曲详情')
  const songs = await enrichSongs(payload.data)
  const order = new Map(uniqueIds.map((id, index) => [id, index]))
  return songs.sort((a, b) => (order.get(Number(a.songId)) ?? 999) - (order.get(Number(b.songId)) ?? 999))
}

async function getTxRecommendedPlaylists(limit: number, page = 1, filter: DiscoveryPlaylistFilter = {}): Promise<DiscoveryPlaylist[]> {
  const safeLimit = Math.max(1, Math.min(limit, 30))
  const safePage = Math.max(1, Math.floor(page))

  if (filter.tag) {
    const payload = await requestMusicu<{ playlist?: { code?: number; data?: { content?: { v_item?: Array<{ basic?: { tid?: number; title?: string; creator?: { nick?: string }; desc?: string; cover?: { medium_url?: string; default_url?: string }; play_cnt?: number; song_cnt?: number } }> } } } }>({
      comm: { cv: 1602, ct: 20 },
      playlist: { module: 'playlist.PlayListCategoryServer', method: 'get_category_content', param: { titleid: Number(filter.tag), category_id: Number(filter.tag), caller: '0', size: safeLimit, page: safePage - 1, use_page: 1, order: filter.sort === 'hot' ? 5 : 2, sort: filter.sort === 'hot' ? 5 : 2 } },
    })
    const records = payload.playlist?.data?.content?.v_item?.map(item => ({
      id: String(item.basic?.tid || ''), name: item.basic?.title || '', author: item.basic?.creator?.nick || 'QQ 音乐', description: item.basic?.desc || '', cover: normalizeCover(item.basic?.cover?.medium_url || item.basic?.cover?.default_url), playCount: item.basic?.play_cnt || 0, songCount: item.basic?.song_cnt || 0, source: 'tx' as const,
    })).filter(item => item.id && item.name) || []
    return records
  }
  const payload = await requestMusicu<{
    playlist?: { code?: number; data?: { v_playlist?: Array<{
      tid?: number; title?: string; cover_url_medium?: string; creator_info?: { nick?: string }
      access_num?: number; desc?: string; song_ids?: number[]
    }> } }
  }>({
    comm: { cv: 1602, ct: 20 },
    playlist: {
      module: 'playlist.PlayListPlazaServer',
      method: 'get_playlist_by_tag',
      param: { id: 10000000, sin: (safePage - 1) * safeLimit, size: safeLimit, order: filter.sort === 'hot' ? 5 : 2, cur_page: safePage },
    },
  })
  const entries = payload.playlist?.data?.v_playlist
  if (payload.playlist?.code !== 0 || !Array.isArray(entries)) throw new Error('QQ 音乐未返回推荐歌单')

  const records = entries
    .filter(item => item.tid && item.title)
    .map(item => ({
      id: String(item.tid),
      name: item.title || '',
      author: item.creator_info?.nick || 'QQ 音乐',
      description: item.desc || '',
      cover: normalizeCover(item.cover_url_medium),
      playCount: item.access_num || 0,
      songCount: item.song_ids?.length || 0,
      source: 'tx' as const,
    }))
  return records
}

/** 与 lx-music tx/songList.js 同一歌单详情端点：按 disstid 直取，不依赖列表页缓存。 */
async function getTxPlaylistDetail(id: string, cookie?: string): Promise<DiscoveryCollectionDetail | null> {
  const query = new URLSearchParams({
    type: '1', json: '1', utf8: '1', onlysong: '0', new_format: '1', disstid: id,
    loginUin: '0', hostUin: '0', format: 'json', inCharset: 'utf8', outCharset: 'utf-8',
    notice: '0', platform: 'yqq.json', needNewCode: '0',
  })
  const payload = await fetchJson<{
    code?: number
    cdlist?: Array<{ dissname?: string; logo?: string; desc?: string; nickname?: string; songlist?: QQSong[] }>
  }>(`https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?${query}`, {
    headers: {
      Origin: 'https://y.qq.com',
      ...(cookie ? { Cookie: cookie } : {}),
      Referer: `https://y.qq.com/n/yqq/playsquare/${encodeURIComponent(id)}.html`,
    },
  })
  const info = payload.cdlist?.[0]
  const songs = info?.songlist || []
  if (payload.code !== 0 || songs.length === 0) return null

  return {
    id,
    name: info?.dissname || 'QQ 音乐推荐歌单',
    description: info?.desc || '',
    cover: normalizeCover(info?.logo),
    author: info?.nickname || 'QQ 音乐',
    tracks: await enrichSongs(songs),
  }
}

async function getWyRecommendedPlaylists(limit: number, page: number, filter: DiscoveryPlaylistFilter): Promise<DiscoveryPlaylist[]> {
  const query = new URLSearchParams({ cat: filter.tag || '全部', order: filter.sort === 'hot' ? 'hot' : 'new', limit: String(limit), offset: String((page - 1) * limit) })
  const payload = await fetchJson<{ playlists?: Array<{ id?: number; name?: string; creator?: { nickname?: string }; description?: string; coverImgUrl?: string; playCount?: number; trackCount?: number }> }>(`https://music.163.com/api/playlist/list?${query}`)
  return (payload.playlists || []).filter(item => item.id && item.name).map(item => ({
    id: String(item.id),
    name: item.name || '',
    author: item.creator?.nickname || '网易云音乐',
    description: item.description || '',
    cover: normalizeCover(item.coverImgUrl),
    playCount: item.playCount || 0,
    songCount: item.trackCount || 0,
    source: 'wy',
  }))
}

async function getKwRecommendedPlaylists(limit: number, page: number, filter: DiscoveryPlaylistFilter): Promise<DiscoveryPlaylist[]> {
  if (filter.tag) {
    const [tagId, digest] = filter.tag.split('-')
    const query = new URLSearchParams({ loginUid: '0', loginSid: '0', appUid: '76039576', pn: String(page), rn: String(limit), id: tagId })
    const payload = await fetchJson<{ code?: number; data?: { data?: Array<{ id?: string | number; name?: string; uname?: string; desc?: string; img?: string; listencnt?: string | number; total?: string | number }> } }>(`http://wapi.kuwo.cn/api/pc/classify/playlist/getTagPlayList?${query}`)
    const entries = payload.data?.data || []
    if (payload.code !== 200 || !['43', '10000'].includes(digest || '')) throw new Error('酷我未返回分类歌单')
    return entries.filter(item => item.id && item.name).map(item => ({ id: String(item.id), name: item.name || '', author: item.uname || '酷我音乐', description: item.desc || '', cover: normalizeCover(item.img), playCount: Number(item.listencnt) || 0, songCount: Number(item.total) || 0, source: 'kw' }))
  }
  const query = new URLSearchParams({ loginUid: '0', loginSid: '0', appUid: '76039576', pn: String(page), rn: String(limit), order: filter.sort === 'hot' ? 'hot' : 'new' })
  const payload = await fetchJson<{ code?: number; data?: { data?: Array<{ id?: string | number; name?: string; uname?: string; desc?: string; img?: string; listencnt?: string | number; total?: string | number }> } }>(`http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList?${query}`)
  const entries = payload.data?.data || []
  if (payload.code !== 200) throw new Error('酷我未返回推荐歌单')
  return entries.filter(item => item.id && item.name).map(item => ({
    id: String(item.id),
    name: item.name || '',
    author: item.uname || '酷我音乐',
    description: item.desc || '',
    cover: normalizeCover(item.img),
    playCount: Number(item.listencnt) || 0,
    songCount: Number(item.total) || 0,
    source: 'kw',
  }))
}

type KgPlaylistSummary = {
  specialid?: string | number
  specialname?: string
  nickname?: string
  intro?: string
  img?: string
  imgurl?: string
  total_play_count?: string | number
  play_count?: string | number
  songcount?: string | number
  song_count?: string | number
}

function parseKgCount(value: string | number | undefined): number {
  if (typeof value === 'number') return value
  if (!value) return 0
  const match = String(value).match(/^([\d.]+)\s*([万亿])?$/)
  if (!match) return Number(value) || 0
  const number = Number(match[1])
  return match[2] === '亿' ? Math.round(number * 100_000_000) : match[2] === '万' ? Math.round(number * 10_000) : number
}

/** 与 lxserver kg/songList.js 的歌单广场接口一致，支持连续分页。 */
async function getKgRecommendedPlaylists(limit: number, page: number, filter: DiscoveryPlaylistFilter): Promise<DiscoveryPlaylist[]> {
  const sortId = ({ recommend: '5', hot: '6', new: '7', collect: '3', soar: '8' } as Record<DiscoveryPlaylistSort, string>)[filter.sort || 'recommend']
  const payload = await fetchJson<{ status?: number; special_db?: KgPlaylistSummary[] }>(`http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_ajax=1&cdn=cdn&t=${sortId}&c=${encodeURIComponent(filter.tag || '')}&p=${page}`)
  const entries = (payload.special_db || []).filter(item => item.specialid && item.specialname).slice(0, limit)
  if (payload.status !== 1) throw new Error('酷狗未返回推荐歌单')

  return entries.map(item => {
    const songCount = Number(item.songcount || item.song_count)
    return {
      id: String(item.specialid),
      name: item.specialname || '',
      author: item.nickname || '酷狗音乐',
      description: item.intro || '',
      cover: normalizeCover((item.img || item.imgurl || '').replace('{size}', '400')),
      playCount: parseKgCount(item.total_play_count || item.play_count),
      ...(songCount > 0 ? { songCount } : {}),
      source: 'kg',
    }
  })
}

type MgPlaylistNode = {
  contents?: MgPlaylistNode[]
  resType?: string | number
  resId?: string | number
  txt?: string
  txt2?: string
  img?: string
}

function collectMgRecommendedPlaylists(nodes: MgPlaylistNode[], playlists: DiscoveryPlaylist[] = [], ids = new Set<string>()): DiscoveryPlaylist[] {
  for (const node of nodes) {
    if (node.contents) collectMgRecommendedPlaylists(node.contents, playlists, ids)
    const id = node.resId ? String(node.resId) : ''
    if (String(node.resType) !== '2021' || !id || !node.txt || ids.has(id)) continue
    ids.add(id)
    playlists.push({
      id,
      name: node.txt,
      author: '咪咕音乐',
      description: node.txt2 || '',
      cover: normalizeMgCover(node.img),
      playCount: 0,
      source: 'mg',
    })
  }
  return playlists
}

async function getMgRecommendedPlaylists(limit: number, page: number, filter: DiscoveryPlaylistFilter): Promise<DiscoveryPlaylist[]> {
  if (filter.tag) {
    const payload = await fetchJson<{ code?: string; data?: { contentItemList?: Array<{ itemList?: Array<{ title?: string; imageUrl?: string; logEvent?: { contentId?: string }; barList?: Array<{ title?: string }> }> }> } }>(`https://app.c.nf.migu.cn/pc/v1.0/template/musiclistplaza-listbytag/release?pageNumber=${page}&templateVersion=2&tagId=${encodeURIComponent(filter.tag)}`)
    if (payload.code !== '000000') throw new Error('咪咕未返回分类歌单')
    const entries = (payload.data?.contentItemList || []).flatMap(group => group.itemList || []).filter(item => item.logEvent?.contentId && item.title).slice(0, limit)
    // 列表接口没有曲目数：不为每一项额外请求详情，避免首页产生 N+1 请求。
    return entries.map(item => ({
      id: item.logEvent?.contentId || '',
      name: item.title || '',
      author: '咪咕音乐',
      description: '',
      cover: normalizeMgCover(item.imageUrl),
      playCount: parseKgCount(item.barList?.[0]?.title),
      source: 'mg' as const,
    }))
  }
  const payload = await fetchJson<{ code?: string; data?: { contents?: MgPlaylistNode[] } }>(`https://app.c.nf.migu.cn/pc/bmw/page-data/playlist-square-recommend/v1.0?templateVersion=2&pageNo=${page}`)
  if (payload.code !== '000000') throw new Error('咪咕未返回推荐歌单')
  return collectMgRecommendedPlaylists(payload.data?.contents || []).slice(0, limit)
}

// ===== 榜单封面 =====
// 榜单封面变化低频，长 TTL 缓存；失败不缓存（下次请求自然重试），取不到的榜单回退前端渐变占位。
const TOPLIST_COVER_TTL = 60 * 60 * 1000
/** single-flight：同 key 并发共享同一 Promise，防止缓存过期瞬间多用户击穿上游。 */
const pendingToplistCovers = new Map<string, Promise<Map<string, string>>>()

async function getWyToplistCovers(): Promise<Map<string, string>> {
  const payload = await fetchJson<{ list?: Array<{ id?: number; coverImgUrl?: string }> }>('https://music.163.com/api/toplist/detail')
  const covers = new Map<string, string>()
  for (const item of payload.list || []) {
    if (item.id && item.coverImgUrl) covers.set(String(item.id), normalizeCover(item.coverImgUrl))
  }
  return covers
}

async function getKgToplistCovers(): Promise<Map<string, string>> {
  const payload = await fetchJson<{ data?: { info?: Array<{ rankid?: number | string; imgurl?: string }> } }>('http://mobilecdnbj.kugou.com/api/v5/rank/list?version=9108&plat=0&showtype=2&parentid=0&apiver=6&area_code=1&withsong=1')
  const covers = new Map<string, string>()
  for (const item of payload.data?.info || []) {
    if (item.rankid && item.imgurl) covers.set(String(item.rankid), normalizeCover(item.imgurl.replace('{size}', '240')))
  }
  return covers
}

async function getKwToplistCovers(): Promise<Map<string, string>> {
  // 封面仅覆盖常用榜单（全量 43 个逐个请求太重；榜单页列表为纯文字形态不强依赖封面）
  const results = await Promise.allSettled(TOPLIST_BOARDS.kw.filter(b => b.common).map(async board => {
    const payload = await fetchJson<{ pic?: string }>(`http://kbangserver.kuwo.cn/ksong.s?from=pc&fmt=json&pn=0&rn=1&type=bang&data=content&id=${encodeURIComponent(board.id)}&show_copyright_off=0&pcmp4=1&isbang=1`)
    return [board.id, normalizeCover(payload.pic || '')] as const
  }))
  const covers = collectCovers(results)
  // 部分榜单只返回残缺的目录 URL（如 .../BangPic/），下发给前端只会 404，剔除后走占位
  for (const [id, cover] of covers) {
    if (cover.endsWith('/')) covers.delete(id)
  }
  return covers
}

async function getTxToplistCovers(): Promise<Map<string, string>> {
  const results = await Promise.allSettled(TOPLIST_BOARDS.tx.filter(b => b.common).map(async board => {
    const payload = await requestMusicu<{ toplist?: { data?: { data?: { headPicUrl?: string } } } }>({
      toplist: {
        module: 'musicToplist.ToplistInfoServer',
        method: 'GetDetail',
        param: { topid: Number(board.id), num: 1, period: '' },
      },
      comm: { uin: 0, format: 'json', ct: 20, cv: 1859 },
    })
    return [board.id, normalizeCover(payload.toplist?.data?.data?.headPicUrl || '')] as const
  }))
  return collectCovers(results)
}

type MgRankNode = { rankId?: string | number; imageUrl?: string; imgUrl?: string; image?: string; img?: string; contents?: MgRankNode[] }

function collectMgRankCovers(nodes: MgRankNode[], covers: Map<string, string> = new Map()): Map<string, string> {
  for (const node of nodes) {
    if (node.contents) collectMgRankCovers(node.contents, covers)
    if (!node.rankId) continue
    const cover = normalizeMgCover(node.imageUrl || node.imgUrl || node.image || node.img || '')
    if (cover) covers.set(String(node.rankId), cover)
  }
  return covers
}

async function getMgToplistCovers(): Promise<Map<string, string>> {
  const payload = await fetchJson<{ code?: string; data?: { contents?: MgRankNode[] } }>('https://app.c.nf.migu.cn/pc/bmw/rank/rank-index/v1.0', {
    headers: {
      Referer: 'https://app.c.nf.migu.cn/',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 5.1.1; Nexus 6 Build/LYZ28E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/59.0.3071.115 Mobile Safari/537.36',
      channel: '0146921',
    },
  })
  if (payload.code !== '000000') throw new Error('咪咕未返回榜单列表')
  return collectMgRankCovers(payload.data?.contents || [])
}

function collectCovers(results: PromiseSettledResult<readonly [string, string]>[]): Map<string, string> {
  const covers = new Map<string, string>()
  for (const result of results) {
    if (result.status !== 'fulfilled') continue // 单项失败不拖垮整批
    const [id, cover] = result.value
    if (cover) covers.set(id, cover)
  }
  return covers
}

const toplistCoverFetchers: Record<DiscoverySource, () => Promise<Map<string, string>>> = {
  wy: getWyToplistCovers,
  tx: getTxToplistCovers,
  kw: getKwToplistCovers,
  kg: getKgToplistCovers,
  mg: getMgToplistCovers,
}

async function getToplistCovers(source: DiscoverySource): Promise<Map<string, string>> {
  const cacheKey = `discovery:v1:${source}:toplist-covers`
  const cached = getCached<Map<string, string>>(cacheKey)
  if (cached) return cached
  const existing = pendingToplistCovers.get(cacheKey)
  if (existing) return existing

  const pending = toplistCoverFetchers[source]()
    .then(covers => {
      searchCache.set(cacheKey, covers, TOPLIST_COVER_TTL)
      return covers
    })
    .catch(error => {
      logger.warn(`[discovery] fetch ${source} toplist covers failed, fallback to placeholder covers`, error)
      return new Map<string, string>()
    })
    .finally(() => pendingToplistCovers.delete(cacheKey))
  pendingToplistCovers.set(cacheKey, pending)
  return pending
}

export async function getToplists(
  source: DiscoverySource = 'tx',
  scope: 'common' | 'full' = 'common',
): Promise<DiscoveryToplist[]> {
  const covers = await getToplistCovers(source)
  return TOPLIST_BOARDS[source]
    .filter(board => scope === 'full' || board.common)
    .map(board => ({
      id: board.id,
      name: board.name,
      description: board.description ?? '',
      cover: covers.get(board.id) || '',
      source,
      ...(board.common ? { common: true as const } : {}),
    }))
}

async function fetchToplistDetail(source: DiscoverySource, id: string): Promise<DiscoveryCollectionDetail | null> {
  const board = findBoardDef(source, id)
  if (!board) return null
  // v2：网易云公开接口字段已更新，避免复用旧字段映射写入的缓存。
  const cacheKey = `discovery:v2:${source}:toplist:${id}`
  const cached = getCached<DiscoveryCollectionDetail>(cacheKey)
  if (cached) return cached

  if (source === 'wy') {
    const detail = await getWyToplistDetail(id)
    if (detail) searchCache.set(cacheKey, detail, CACHE_TTL)
    return detail
  }
  if (source === 'kw') {
    const detail = await getKwToplistDetail(id)
    if (detail) searchCache.set(cacheKey, detail, CACHE_TTL)
    return detail
  }
  if (source === 'kg') {
    const detail = await getKgToplistDetail(id)
    if (detail) searchCache.set(cacheKey, detail, CACHE_TTL)
    return detail
  }
  if (source === 'mg') {
    const detail = await getMgToplistDetail(id)
    if (detail) searchCache.set(cacheKey, detail, CACHE_TTL)
    return detail
  }

  const payload = await requestMusicu<{
    toplist?: { code?: number; data?: { data?: {
      title?: string; intro?: string; headPicUrl?: string; updateTime?: string; song?: Array<{ songId?: number }>
    } } }
  }>({
    toplist: {
      module: 'musicToplist.ToplistInfoServer',
      method: 'GetDetail',
      param: { topid: Number(id), num: 100, period: '' },
    },
    comm: { uin: 0, format: 'json', ct: 20, cv: 1859 },
  })
  const data = payload.toplist?.data?.data
  const songIds = data?.song?.map(item => item.songId || 0).filter(Boolean) || []
  if (payload.toplist?.code !== 0 || songIds.length === 0) throw new Error('QQ 音乐未返回榜单歌曲')
  const detail: DiscoveryCollectionDetail = {
    id,
    name: data?.title || board.name,
    description: data?.intro?.replace(/<br\s*\/?>/gi, '\n') || board.description || '',
    cover: normalizeCover(data?.headPicUrl),
    author: 'QQ 音乐',
    updateTime: data?.updateTime,
    tracks: await getSongsByIds(songIds),
  }
  searchCache.set(cacheKey, detail, CACHE_TTL)
  return detail
}

export async function getToplistDetail(source: DiscoverySource, id: string): Promise<DiscoveryCollectionDetail | null> {
  const detail = await fetchToplistDetail(source, id)
  // kg/mg 榜单接口不返回封面，用第一首歌封面兜底
  if (detail && !detail.cover) detail.cover = normalizeCover(detail.tracks[0]?.img || '')
  return detail
}

export async function getRecommendedPlaylists(source: DiscoverySource = 'tx', limit = 12, page = 1, filter: DiscoveryPlaylistFilter = {}): Promise<DiscoveryPlaylist[]> {
  const safeLimit = Math.max(1, Math.min(limit, 30))
  const safePage = Math.max(1, Math.floor(page))
  // v7：所有渠道的歌单列表均不再逐项请求详情，避免首页产生 N+1 请求。
  const cacheKey = `discovery:v7:${source}:playlist-list:${safeLimit}:${safePage}:${filter.tag || ''}:${filter.sort || 'recommend'}:${filter.keyword || ''}`
  const cached = getCached<DiscoveryPlaylist[]>(cacheKey)
  if (cached) return cached
  if (source === 'wy') {
    const playlists = await getWyRecommendedPlaylists(safeLimit, safePage, filter)
    searchCache.set(cacheKey, playlists, CACHE_TTL)
    return playlists
  }
  if (source === 'kw') {
    const playlists = await getKwRecommendedPlaylists(safeLimit, safePage, filter)
    searchCache.set(cacheKey, playlists, CACHE_TTL)
    return playlists
  }
  if (source === 'kg') {
    const playlists = await getKgRecommendedPlaylists(safeLimit, safePage, filter)
    searchCache.set(cacheKey, playlists, CACHE_TTL)
    return playlists
  }
  if (source === 'mg') {
    const playlists = await getMgRecommendedPlaylists(safeLimit, safePage, filter)
    searchCache.set(cacheKey, playlists, CACHE_TTL)
    return playlists
  }
  if (source === 'tx') {
    const playlists = await getTxRecommendedPlaylists(safeLimit, safePage, filter)
    searchCache.set(cacheKey, playlists, CACHE_TTL)
    return playlists
  }
  throw new Error('Unsupported discovery source')
}

export async function getRecommendedPlaylistDetail(source: DiscoverySource, id: string, cookie?: string): Promise<DiscoveryCollectionDetail | null> {
  // 带 cookie（访问私有歌单）时完全绕过缓存：
  // 私人歌单内容不能写入公共缓存键（多用户实例下会泄露给其他用户）
  const useCache = !cookie
  const cacheKey = `discovery:v2:${source}:playlist:${id}`
  const cached = useCache ? getCached<DiscoveryCollectionDetail>(cacheKey) : null
  if (cached) return cached
  if (source === 'wy') {
    const detail = await getWyPlaylistDetail(id, cookie)
    if (detail && useCache) searchCache.set(cacheKey, detail, CACHE_TTL)
    return detail
  }
  if (source === 'kw') {
    const detail = await getKwPlaylistDetail(id)
    if (detail) searchCache.set(cacheKey, detail, CACHE_TTL)
    return detail
  }
  if (source === 'kg') {
    const detail = await getKgPlaylistDetail(id)
    if (detail) searchCache.set(cacheKey, detail, CACHE_TTL)
    return detail
  }
  if (source === 'mg') {
    const detail = await getMgPlaylistDetail(id)
    if (detail) searchCache.set(cacheKey, detail, CACHE_TTL)
    return detail
  }
  const detail = await getTxPlaylistDetail(id, cookie)
  if (!detail) return null
  if (useCache) searchCache.set(cacheKey, detail, CACHE_TTL)
  return detail
}

// ==================== 歌单广场标签（接口与解析照搬 lx-music-desktop musicSdk/*/songList.js） ====================

export interface PlaylistTag { id: string; name: string }
export interface PlaylistTagGroup { name: string; list: PlaylistTag[] }
export interface PlaylistTagsResult { hotTag: PlaylistTag[]; tags: PlaylistTagGroup[] }

type TxTagItem = { id?: number | string; name?: string }
type TxTagGroup = { group_name?: string; v_item?: TxTagItem[] }

async function getTxPlaylistTags(): Promise<PlaylistTagsResult> {
  // musicu.fcg playlist.PlaylistAllCategoriesServer（洛雪 tx.songList tagsUrl）
  const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg?loginUin=0&hostUin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=wk_v15.json&needNewCode=0&data=' + encodeURIComponent(JSON.stringify({ tags: { method: 'get_all_categories', param: { qq: '' }, module: 'playlist.PlaylistAllCategoriesServer' } }))
  const payload = await fetchJson<{ tags?: { data?: { v_group?: TxTagGroup[] } } }>(url, { headers: { Referer: 'https://y.qq.com/' } })
  const toTag = (item: TxTagItem): PlaylistTag | null => {
    const id = String(item.id ?? '')
    return id && item.name ? { id, name: item.name } : null
  }
  const groups = payload.tags?.data?.v_group || []
  return {
    hotTag: groups.flatMap(g => g.v_item || []).map(toTag).filter((t): t is PlaylistTag => t !== null).slice(0, 10),
    tags: groups.map(g => ({
      name: g.group_name || '',
      list: (g.v_item || []).map(toTag).filter((t): t is PlaylistTag => t !== null),
    })).filter(g => g.name && g.list.length > 0),
  }
}

async function getWyPlaylistTags(): Promise<PlaylistTagsResult> {
  // music.163.com/api/playlist/hottags 明文 GET（洛雪走 weapi；linux/forward 对该接口返回 400，明文实测可用）
  const payload = await fetchJson<{ code?: number; tags?: Array<{ playlistTag?: { name?: string } }> }>('https://music.163.com/api/playlist/hottags', { headers: { Referer: 'https://music.163.com/' } })
  if (payload.code !== 200) throw new Error('网易未返回热门标签')
  return {
    hotTag: (payload.tags || []).map(t => ({ id: t.playlistTag?.name || '', name: t.playlistTag?.name || '' })).filter(t => t.name).slice(0, 10),
    tags: [], // 分类全量目录对 UI 无用，只保留热门标签（与洛雪广场页高频用法一致）
  }
}

async function getKwPlaylistTags(): Promise<PlaylistTagsResult> {
  // wapi.kuwo.cn getRcmTagList（洛雪 kw.songList hotTagUrl）——id 需带 digest 后缀（getTagPlayList 用 id-digest）
  const payload = await fetchJson<{ code?: number; data?: Array<{ data?: Array<{ id?: number | string; digest?: number | string; name?: string }> }> }>('http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmTagList?loginUid=0&loginSid=0&appUid=76039576')
  if (payload.code !== 200) throw new Error('酷我未返回标签')
  const items = payload.data?.[0]?.data || []
  return {
    hotTag: items.slice(0, 10).map(item => ({ id: `${item.id}-${item.digest}`, name: item.name || '' })).filter(t => t.name),
    tags: [],
  }
}

async function getKgPlaylistTags(): Promise<PlaylistTagsResult> {
  // www2.kugou.kugou.com getSpecial?is_smarty=1：实测返回 JSON，
  // data.hotTag.data 为按键索引对象（special_id 即广场列表的 c= 参数）。
  const payload = await fetchJson<{ status?: number; data?: { hotTag?: { data?: Record<string, { special_id?: string | number; special_name?: string }> } } }>('http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_smarty=1&cdn=cdn')
  const items = Object.values(payload.data?.hotTag?.data || {})
  const tags = items
    .map(item => ({ id: String(item.special_id ?? ''), name: item.special_name || '' }))
    .filter(t => t.id && t.name)
  if (tags.length === 0) throw new Error('酷狗未返回标签')
  return { hotTag: tags.slice(0, 10), tags: [] }
}

async function getMgPlaylistTags(): Promise<PlaylistTagsResult> {
  // app.c.nf.migu.cn musiclistplaza-taglist（洛雪 mg.songList tagsUrl）
  const payload = await fetchJson<{ code?: string; data?: Array<{ header?: { title?: string }; content?: Array<{ texts?: string[] }> }> }>('https://app.c.nf.migu.cn/pc/v1.0/template/musiclistplaza-taglist/release', { headers: { Referer: 'https://m.music.migu.cn/' } })
  if (payload.code !== '000000') throw new Error('咪咕未返回标签')
  const columns = payload.data || []
  const hot = columns[0]?.content || []
  return {
    hotTag: hot.map(item => ({ id: item.texts?.[1] || '', name: item.texts?.[0] || '' })).filter(t => t.id && t.name).slice(0, 10),
    tags: columns.slice(1).map(col => ({
      name: col.header?.title || '',
      list: (col.content || []).map(item => ({ id: item.texts?.[1] || '', name: item.texts?.[0] || '' })).filter(t => t.id && t.name),
    })).filter(g => g.name && g.list.length > 0),
  }
}

export async function getPlaylistTags(source: DiscoverySource = 'tx'): Promise<PlaylistTagsResult> {
  const cacheKey = `discovery:v1:${source}:playlist-tags`
  const cached = getCached<PlaylistTagsResult>(cacheKey)
  if (cached) return cached
  const result = source === 'wy' ? await getWyPlaylistTags()
    : source === 'kw' ? await getKwPlaylistTags()
    : source === 'kg' ? await getKgPlaylistTags()
    : source === 'mg' ? await getMgPlaylistTags()
    : await getTxPlaylistTags()
  searchCache.set(cacheKey, result, TAG_CACHE_TTL)
  return result
}

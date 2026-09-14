/**
 * Apple Music amp-api 服务（三源架构三期：Apple tier 内部升级，对外契约不变）
 *
 * 接口面（2026-09 HAR 抓包 + 直连重放验证）：
 * - 搜索   amp-api-edge /v1/catalog/cn/search（term + types，format[resources]=map）
 * - 歌手   amp-api /v1/catalog/cn/artists/{id}（浏览器参数一次返回：bio/生日/官方头像/
 *          24 热门歌（30s 试听）/35 专辑/10 MV（30s 预告 m4v 直链））
 * - 专辑   amp-api /v1/catalog/cn/albums/{id}（曲目 + 专业乐评 editorialNotes）
 *
 * 鉴权：网页 JS 包内嵌的公共 Bearer JWT（Chrome HAR 导出会脱敏 Authorization 头，
 * 实际必带）。本服务从 music.apple.com 首页 JS 包自动提取 token 并缓存（约 2 个月
 * 有效期，过期 401 自动重取），可用环境变量 APPLE_AMP_TOKEN 固定覆盖。
 *
 * 可播性：整曲需订阅 Media-Token（不涉及）；免费资产=歌曲 30s 试听 m4a、MV 30s 预告
 * m4v（video-ssl.itunes.apple.com 渐进直链，实测免鉴权）、歌手 hero 动态视频 mp4。
 * Apple 在三源中的角色不变：元数据权威 + 降级链末位，非播放源。
 */

import { searchCache } from '@/lib/cache-manager'
import { logger } from '@/lib/logger'
import { appleT2S } from '@/lib/services/itunes-service'

const AMP_TIMEOUT = 10_000
const POLITENESS_INTERVAL = 200
const CACHE_TTL = 24 * 60 * 60 * 1000
const TOKEN_CACHE_KEY = 'apple:amp:token:v1'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 礼貌队列：相邻 amp-api 请求间隔 ≥200ms */
let queueTail: Promise<unknown> = Promise.resolve()
function polite<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(async () => {
    await new Promise(r => setTimeout(r, POLITENESS_INTERVAL))
    return fn()
  })
  queueTail = run.catch(() => undefined)
  return run
}

// ---------------------------------------------------------------------------
// Token 管理：JS 包提取 + 缓存 + 401 自动重取
// ---------------------------------------------------------------------------

/** 从 music.apple.com 首页 JS 包提取公共 Bearer JWT */
export async function fetchAmpToken(): Promise<string | null> {
  try {
    const page = await fetch('https://music.apple.com/cn/browse', {
      headers: { 'User-Agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(AMP_TIMEOUT),
    })
    const html = await page.text()
    const jsPath = [...html.matchAll(/src="(\/assets\/index~[^"]+\.js)"/g)].map(m => m[1])[0]
    if (!jsPath) throw new Error('未找到首页 JS 包')
    const code = await (await fetch('https://music.apple.com' + jsPath, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(AMP_TIMEOUT),
    })).text()
    const token = code.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/)?.[0]
    if (!token) throw new Error('JS 包内未找到 token')
    return token
  } catch (error) {
    logger.warn('[apple-amp] token 提取失败:', error instanceof Error ? error.message : error)
    return null
  }
}

/** 取 token：环境变量固定覆盖 → 内存/缓存（7 天）→ 现场提取 */
async function getAmpToken(): Promise<string | null> {
  if (process.env.APPLE_AMP_TOKEN) return process.env.APPLE_AMP_TOKEN
  const cached = searchCache.get(TOKEN_CACHE_KEY) as string | null
  if (cached) return cached
  const token = await fetchAmpToken()
  if (token) searchCache.set(TOKEN_CACHE_KEY, token, 7 * 24 * 60 * 60 * 1000)
  return token
}

async function ampGet<T>(host: 'amp-api.music.apple.com' | 'amp-api-edge.music.apple.com', pathAndQuery: string): Promise<T | null> {
  const attempt = async (token: string) => {
    const resp = await polite(async () => fetch(`https://${host}${pathAndQuery}`, {
      headers: {
        'User-Agent': UA,
        Origin: 'https://music.apple.com',
        Referer: 'https://music.apple.com/',
        accept: '*/*',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(AMP_TIMEOUT),
    }))
    if (resp.status === 401) throw Object.assign(new Error('token 失效'), { status: 401 })
    if (!resp.ok) throw new Error(`amp-api HTTP ${resp.status}`)
    return await resp.json() as T
  }
  try {
    const token = await getAmpToken()
    if (!token) return null
    return await attempt(token)
  } catch (error) {
    // 401 → 丢弃缓存 token 重取一次（约 2 个月过期的自动续命）
    if (error instanceof Error && (error as Error & { status?: number }).status === 401) {
      const fresh = await fetchAmpToken()
      if (fresh) {
        searchCache.set(TOKEN_CACHE_KEY, fresh, 7 * 24 * 60 * 60 * 1000)
        try { return await attempt(fresh) } catch { /* 落入总捕获 */ }
      }
    }
    logger.warn(`[apple-amp] ${pathAndQuery.split('?')[0]} 请求失败:`, error instanceof Error ? error.message : error)
    return null
  }
}

// ---------------------------------------------------------------------------
// 工具：artwork 模板 → 具体尺寸 URL（mzstatic {w}x{h}{c}.{f} 模板）
// ---------------------------------------------------------------------------

export function artworkUrl(artwork: { url?: string } | null | undefined, size = '400x400bb'): string | null {
  if (!artwork?.url) return null
  return artwork.url.replace('{w}x{h}{c}.{f}', `${size}.jpg`).replace('{w}x{h}{f}', `${size}.jpg`)
}

function clean(value: string | null | undefined): string {
  return appleT2S(value || '').trim()
}

/** 归一化比对键：简体+小写+去非字母数字（搜索结果锚定用） */
function normKey(value: string | null | undefined): string {
  return appleT2S(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface AmpArtistCard {
  source: 'apple'
  artistId: string
  name: string
  genre?: string
  /** 官方头像（mzstatic artwork，老 iTunes Search API 歌手实体没有的） */
  pic?: string | null
}

export interface AmpAlbumCard {
  source: 'apple'
  albumId: string
  name: string
  artist: string
  img: string | null
  year?: string
}

export interface AmpMusicVideo {
  id: string
  name: string
  artist: string
  /** 封面（mzstatic） */
  artwork: string | null
  durationSec: number
  releaseDate?: string
  /** 30 秒预告（video-ssl.itunes.apple.com 渐进 m4v，免鉴权直链） */
  previewUrl: string | null
}

export interface AmpArtistDetail {
  artist: {
    artistId: string
    name: string
    genre?: string
    bio: string | null
    birthDate?: string
    img: string | null
  }
  /** 热门 24 首（元数据：歌名+歌手+时长+30s 试听，无可播完整 id） */
  topSongs: Array<{ title: string; artist: string; secs: number | null; previewUrl: string | null }>
  albums: AmpAlbumCard[]
  musicVideos: AmpMusicVideo[]
}

interface AmpSongAttrs {
  name?: string; artistName?: string; durationInMillis?: number
  previews?: Array<{ url?: string }>
  trackNumber?: number; discNumber?: number
}
interface AmpVideoAttrs {
  name?: string; artistName?: string; durationInMillis?: number; releaseDate?: string
  artwork?: { url?: string }
  previews?: Array<{ url?: string; hlsUrl?: string }>
}
interface AmpAlbumAttrs {
  name?: string; artistName?: string; releaseDate?: string
  artwork?: { url?: string }
  editorialNotes?: { short?: string; standard?: string }
  trackCount?: number
}

// ---------------------------------------------------------------------------
// 接口：搜索（之前未打通的 search，浏览器参数已破解）
// ---------------------------------------------------------------------------

export async function searchAmpArtists(keyword: string, limit = 10): Promise<AmpArtistCard[]> {
  const q = keyword.trim()
  if (!q) return []
  const cacheKey = `apple:amp:searchArtist:v2:${q}`
  const cached = searchCache.get(cacheKey) as AmpArtistCard[] | null
  if (cached) return cached

  const sp = new URLSearchParams({
    'art[url]': 'f', 'extend': 'artistUrl', 'format[resources]': 'map',
    'fields[artists]': 'url,name,artwork',
    'include[songs]': 'artists',
    'l': 'zh-Hans-CN', 'limit': '21', 'omit[resource]': 'autos',
    'platform': 'web', 'relate[songs]': 'albums',
    'term': q, 'types': 'artists,albums,songs', 'with': 'serverBubbles',
  })
  interface RawEntity { id?: string; attributes?: { name?: string; artwork?: { url?: string }; genreNames?: string[] } }
  interface Raw { resources?: { artists?: Record<string, RawEntity> }; results?: { artist?: { data?: RawEntity[] } } }
  const j = await ampGet<Raw>('amp-api-edge.music.apple.com', '/v1/catalog/cn/search?' + sp.toString())
  // format[resources]=map：实体在 resources.artists（id→实体）；results.artist 仅 href。
  // map 无序且混入歌曲关联歌手——按「精确名字 > 名字包含」排序锚定搜索词
  const k = normKey(q)
  const rank = (name: string | undefined) => {
    const n = normKey(name)
    if (!n) return 2
    if (n === k) return 0
    if (n.includes(k) || k.includes(n)) return 1
    return 2
  }
  const data = Object.values(j?.resources?.artists ?? {})
    .map(e => ({ ...e, id: e.id ?? '' }))
    .filter(a => a.id && a.attributes?.name)
    .sort((a, b) => rank(a.attributes!.name) - rank(b.attributes!.name))
  const list = data
    .slice(0, limit)
    .map(a => ({
      source: 'apple' as const,
      artistId: String(a.id),
      name: clean(a.attributes!.name),
      ...(a.attributes!.genreNames?.length ? { genre: clean(a.attributes!.genreNames[0]) } : {}),
      pic: artworkUrl(a.attributes!.artwork),
    }))
  if (list.length > 0) searchCache.set(cacheKey, list, CACHE_TTL)
  return list
}

// ---------------------------------------------------------------------------
// 接口：歌手详情（浏览器参数逐字固化；一发全包：bio/生日/头像/24热歌/35专辑/10MV）
// ---------------------------------------------------------------------------

/** artists/{id} 精简参数（浏览器全集实测易超时；此组直连验证 200/约500ms，
 *  返回 top-songs×24 + full-albums + music-videos×10 + bornOrFormed + artwork。
 *  注：cn 目录 artistBio 普遍为空，bio 仍由维基提供） */
const ARTIST_PARAMS = '?art%5Burl%5D=c%2Cf&extend=artistBio%2CbornOrFormed%2CeditorialArtwork%2CextendedAssetUrls&format%5Bresources%5D=map&include%5Bmusic-videos%5D=artists&include%5Bsongs%5D=artists%2Calbums&l=zh-Hans-CN&limit%5Bartists%3Atop-songs%5D=24&meta%5Balbums%3Atracks%5D=popularity&omit%5Bresource%5D=autos&platform=web&views=top-songs%2Cmusic-videos%2Cfull-albums%2Csingles'

interface AmpResources {
  artists?: Record<string, { attributes?: { name?: string; genreNames?: string[]; artistBio?: { short?: string; standard?: string }; bornOrFormed?: string; artwork?: { url?: string }; editorialVideo?: Record<string, { video?: string }> } }>
  songs?: Record<string, { attributes?: AmpSongAttrs }>
  albums?: Record<string, { attributes?: AmpAlbumAttrs }>
  'music-videos'?: Record<string, { attributes?: AmpVideoAttrs }>
}

export async function getAmpArtistDetail(artistId: string): Promise<AmpArtistDetail | null> {
  const cacheKey = `apple:amp:artistDetail:${artistId}`
  const cached = searchCache.get(cacheKey) as AmpArtistDetail | null
  if (cached) return cached

  interface Raw { data?: Array<{ id?: string; type?: string }>; resources?: AmpResources }
  const j = await ampGet<Raw>('amp-api.music.apple.com', `/v1/catalog/cn/artists/${encodeURIComponent(artistId)}${ARTIST_PARAMS}`)
  const res = j?.resources
  const artist = res?.artists?.[artistId]?.attributes
  if (!artist?.name) return null

  // 热门歌：songs 资源池即 top-songs（map 无序，按 trackNumber 不可靠——top songs 无序号，
  // amp 返回顺序即热门度，直接按对象顺序取）
  const topSongs = Object.values(res?.songs || {}).map(s => s.attributes).filter(Boolean).map(a => ({
    title: clean(a!.name),
    artist: clean(a!.artistName),
    secs: a!.durationInMillis ? Math.round(a!.durationInMillis / 1000) : null,
    previewUrl: a!.previews?.[0]?.url ?? null,
  })).filter(s => s.title)

  const albums = Object.values(res?.albums || {}).map(a => a.attributes).filter(Boolean).map(a => ({
    source: 'apple' as const,
    albumId: '',
    name: clean(a!.name),
    artist: clean(a!.artistName),
    img: artworkUrl(a!.artwork, '300x300bb'),
    ...(a!.releaseDate ? { year: a!.releaseDate } : {}),
  })).filter(a => a.name)
  // albumId 需要资源键（map 的 key 即 id）
  const albumIds = Object.keys(res?.albums || {})
  albumIds.forEach((id, i) => { if (albums[i]) albums[i].albumId = id })

  const musicVideos = Object.entries(res?.['music-videos'] || {}).map(([id, v]) => {
    const a = v.attributes
    if (!a?.name) return null
    return {
      id,
      name: clean(a.name),
      artist: clean(a.artistName),
      artwork: artworkUrl(a.artwork, '640x360bb'),
      durationSec: a.durationInMillis ? Math.round(a.durationInMillis / 1000) : 0,
      ...(a.releaseDate ? { releaseDate: a.releaseDate } : {}),
      previewUrl: a.previews?.[0]?.url ?? null,
    } as AmpMusicVideo
  }).filter((v): v is AmpMusicVideo => v !== null)

  const bioRaw = artist.artistBio?.standard || artist.artistBio?.short || null
  const detail: AmpArtistDetail = {
    artist: {
      artistId,
      name: clean(artist.name),
      ...(artist.genreNames?.length ? { genre: clean(artist.genreNames[0]) } : {}),
      bio: bioRaw ? clean(bioRaw).slice(0, 800) || null : null,
      ...(artist.bornOrFormed ? { birthDate: artist.bornOrFormed.slice(0, 10) } : {}),
      img: artworkUrl(artist.artwork, '600x600bb'),
    },
    topSongs,
    albums,
    musicVideos,
  }
  searchCache.set(cacheKey, detail, CACHE_TTL)
  return detail
}

// ---------------------------------------------------------------------------
// 接口：专辑详情（editorialNotes 专业乐评）
// ---------------------------------------------------------------------------

const ALBUM_PARAMS = '?art%5Burl%5D=f&extend=editorialNotes%2CextendedAssetUrls&fields%5Bartists%5D=name%2Curl&format%5Bresources%5D=map&include%5Bsongs%5D=artists%2Calbums&l=zh-Hans-CN&meta%5Balbums%3Atracks%5D=popularity&platform=web&views=more-by-artist'

export async function getAmpAlbumDetail(collectionId: string): Promise<{
  album: { collectionId: string; title: string; artist: string; year?: string; img: string | null; trackCount: number; bio?: string | null }
  tracks: Array<{ title: string; artist: string; secs: number | null; disc: number; position: number }>
} | null> {
  const cacheKey = `apple:amp:albumDetail:${collectionId}`
  const cached = searchCache.get(cacheKey) as Awaited<ReturnType<typeof getAmpAlbumDetail>> | null
  if (cached) return cached

  interface Raw { resources?: AmpResources }
  const j = await ampGet<Raw>('amp-api.music.apple.com', `/v1/catalog/cn/albums/${encodeURIComponent(collectionId)}${ALBUM_PARAMS}`)
  const res = j?.resources
  const albumAttrs = res?.albums?.[collectionId]?.attributes
  if (!albumAttrs?.name) return null

  const notes = albumAttrs.editorialNotes?.standard || albumAttrs.editorialNotes?.short || null
  const tracks = Object.values(res?.songs || {}).map(s => s.attributes).filter(Boolean).map(a => ({
    title: clean(a!.name),
    artist: clean(a!.artistName),
    secs: a!.durationInMillis ? Math.round(a!.durationInMillis / 1000) : null,
    disc: a!.discNumber ?? 1,
    position: a!.trackNumber ?? 0,
  })).filter(t => t.title).sort((a, b) => a.disc - b.disc || a.position - b.position)

  const result = {
    album: {
      collectionId,
      title: clean(albumAttrs.name),
      artist: clean(albumAttrs.artistName),
      ...(albumAttrs.releaseDate ? { year: albumAttrs.releaseDate } : {}),
      img: artworkUrl(albumAttrs.artwork, '600x600bb'),
      trackCount: albumAttrs.trackCount ?? tracks.length,
      ...(notes ? { bio: clean(notes).slice(0, 1000) } : {}),
    },
    tracks,
  }
  searchCache.set(cacheKey, result, CACHE_TTL)
  return result
}

/**
 * 按歌手名取 MV 列表（跨链通用增强：kw/mg/apple 任何歌手页都可挂视频区）。
 * 搜索拿 artistId → artists 详情的 music-videos（30s 预告 m4v 直链）。缓存 24h。
 */
export async function getAmpArtistMvsByName(name: string, limit = 12): Promise<AmpMusicVideo[]> {
  const q = name.trim()
  if (!q) return []
  const cacheKey = `apple:amp:mvs:v2:${q}`
  const cached = searchCache.get(cacheKey) as AmpMusicVideo[] | null
  if (cached) return cached

  const artists = await searchAmpArtists(q, 3)
  const hit = artists.find(a => a.name === q) ?? artists[0]
  if (!hit) return []
  const detail = await getAmpArtistDetail(hit.artistId)
  const mvs = (detail?.musicVideos || []).slice(0, limit)
  if (mvs.length > 0) searchCache.set(cacheKey, mvs, CACHE_TTL)
  return mvs
}

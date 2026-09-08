/**
 * 猜我喜欢（Guess You Like）推荐服务
 *
 * v1 算法：content-based —— 带时间衰减的歌手亲和度画像 + 本地库召回 +
 * 确定性抖动排序。无 AI、无上游请求、无新表，全部同步计算。
 *
 * 画像信号（按强度）：
 *   收藏的歌     权重 5（显式表态，不衰减）
 *   歌单里的歌   权重 3（主动收集，不衰减）
 *   播放过       ln(1 + playCount) × 2^(−距今天数/14)（半衰期 14 天）
 *
 * 排序：score = Σ(候选歌匹配到的歌手亲和度) + 专辑亲和加成 + jitter。
 * jitter 用 mulberry32 PRNG，种子 = hash(username + 当天日期)：
 * 同一用户同一天结果稳定（"每日"语义），第二天自动换血。
 * 排序后执行歌手多样性约束（每个歌手最多 2 首），分页从完整榜切片。
 *
 * 冷启动兜底：画像为空时回退 getRandomMusicInfoList 两级抽取（白名单 → 全库）。
 */
import { prisma, getRandomMusicInfoList, getStorageSongmidForMusicInfo } from '@/lib/db'
import { getSearchSources } from '@/lib/search-config'
import { logger } from '@/lib/logger'
import type { MusicInfo, Song } from '@/lib/types/music'

// ============ 可调参数 ============
const FAVORITE_WEIGHT = 5
const PLAYLIST_WEIGHT = 3
/** 播放权重半衰期（天）：两周前的播放影响力减半 */
const HALF_LIFE_DAYS = 14
/** 亲和度低于此值的歌手不参与召回（≈ 一次播放衰减后的量级） */
const ARTIST_AFFINITY_THRESHOLD = 0.3
/** 参与召回的 Top 歌手数 */
const TOP_ARTISTS = 15
/** 专辑亲和加成 */
const ALBUM_BONUS = 2
/** 参与专辑加成的专辑数上限 */
const TOP_ALBUMS = 10
/** 候选池上限 */
const MAX_CANDIDATES = 300
/** 完整推荐榜上限（分页从这份榜切片） */
const MAX_RANKED = 200
/** 歌手多样性：同一歌手在榜内最多出现次数 */
const MAX_PER_ARTIST = 2
/** jitter 幅度：只够打乱同分段位，不影响大局 */
const JITTER_SCALE = 2

const SINGER_SPLIT_RE = /[、，,;；]+|\s+feat\.?\s+|\s+ft\.?\s+/i

// ============ 纯函数（导出供单测） ============

/** 拆分合唱歌手串 "A、B" / "A, B" / "A feat. B" → 去重后的歌手数组。
 * 刻意不按 "/" 拆：保护 AC/DC 这类名字本身含斜杠的乐队。 */
export function splitSinger(raw: string | null | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(SINGER_SPLIT_RE)) {
    const name = part.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** FNV-1a 32 位字符串哈希（PRNG 种子用，不涉安全） */
export function hashSeed(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32：可复现的小型 PRNG，同种子同序列 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 服务器本地时区的日期键（"每日"的"日"以服务器时区为准，不用 UTC） */
export function dayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 播放时间衰减因子：半衰期 HALF_LIFE_DAYS，未来时间按 0 天算 */
export function recencyDecay(playedAt: Date, now = new Date()): number {
  const days = Math.max(0, (now.getTime() - playedAt.getTime()) / 86_400_000)
  return Math.pow(2, -days / HALF_LIFE_DAYS)
}

export interface AffinityContext {
  /** 歌手 → 亲和度 */
  artistAffinity: Map<string, number>
  /** 专辑名 → 亲和度 */
  albumAffinity: Map<string, number>
  /** 已知的歌（历史 ∪ 收藏 ∪ 歌单），排序阶段剔除 */
  knownUids: Set<string>
  /** 画像里是否至少有一个有效信号 */
  personalized: boolean
}

/** 排序候选：返回带 reason 的完整榜（已做多样性约束与剔除） */
export function rankCandidates(
  candidates: MusicInfo[],
  ctx: AffinityContext,
  username: string,
  date = dayKey(),
  opts?: { includePlayed?: boolean },
): Array<Song & { reason: string }> {
  const known = opts?.includePlayed ? new Set<string>() : ctx.knownUids
  const rand = mulberry32(hashSeed(`${username}:${date}`))

  const scored = candidates
    .map(mi => {
      const uid = `${mi.source}-${getStorageSongmidForMusicInfo(mi)}`
      // 匹配到的歌手取各自亲和度求和；主歌手 = 亲和度最高者（推荐理由用）
      let bestArtist = ''
      let bestAffinity = 0
      let artistSum = 0
      for (const artist of splitSinger(mi.singer)) {
        const a = ctx.artistAffinity.get(artist)
        if (a === undefined) continue
        artistSum += a
        if (a > bestAffinity) {
          bestAffinity = a
          bestArtist = artist
        }
      }
      const albumBonus = mi.albumName ? (ctx.albumAffinity.get(mi.albumName) ?? 0) : 0
      const score = artistSum + albumBonus + rand() * JITTER_SCALE
      return { mi, uid, score, reason: bestArtist }
    })
    .filter(item => !known.has(item.uid) && item.reason)
    .sort((a, b) => b.score - a.score)

  // 歌手多样性：贪心选取，每个主歌手最多 MAX_PER_ARTIST 首；
  // 被上限卡掉的歌进 deferred，第二轮按分数序补在榜尾——
  // 避免画像里歌手太少时整个榜单被截断到只剩寥寥几首
  const perArtist = new Map<string, number>()
  const ranked: Array<Song & { reason: string }> = []
  const deferred: typeof scored = []
  for (const item of scored) {
    if (ranked.length >= MAX_RANKED) break
    const n = (perArtist.get(item.reason) ?? 0) + 1
    if (n > MAX_PER_ARTIST) {
      deferred.push(item)
      continue
    }
    perArtist.set(item.reason, n)
    ranked.push({ ...item.mi, uid: item.uid, reason: `因为你常听 ${item.reason}` })
  }
  for (const item of deferred) {
    if (ranked.length >= MAX_RANKED) break
    ranked.push({ ...item.mi, uid: item.uid, reason: `因为你常听 ${item.reason}` })
  }
  return ranked
}

// ============ IO（画像构建与召回） ============

/** 通过 musicInfoId 批量取 MusicInfo（历史/歌单条目走这条路径） */
async function loadMusicInfoByIds(ids: number[]): Promise<Map<number, MusicInfo>> {
  const map = new Map<number, MusicInfo>()
  if (ids.length === 0) return map
  const rows = await prisma.musicInfo.findMany({
    where: { id: { in: ids } },
  })
  for (const row of rows) {
    try {
      map.set(row.id, JSON.parse(row.data) as MusicInfo)
    } catch {
      // data 列解析失败的行跳过
    }
  }
  return map
}

/** 通过 uid（source-存储songmid）批量取 MusicInfo（收藏没有 musicInfoId 关联） */
async function loadMusicInfoByUids(uids: string[]): Promise<Map<string, MusicInfo>> {
  const map = new Map<string, MusicInfo>()
  if (uids.length === 0) return map
  const pairs = uids
    .map(u => {
      const idx = u.indexOf('-')
      return idx > 0 ? { source: u.slice(0, idx), songmid: u.slice(idx + 1) } : null
    })
    .filter((p): p is { source: string; songmid: string } => p !== null)
  // 收藏量级为几十，OR 复合键查询安全
  const rows = await prisma.musicInfo.findMany({
    where: { OR: pairs.map(p => ({ source: p.source, songmid: p.songmid })) },
  })
  for (const row of rows) {
    try {
      map.set(`${row.source}-${row.songmid}`, JSON.parse(row.data) as MusicInfo)
    } catch {
      // 同上
    }
  }
  return map
}

/** 构建用户画像：歌手/专辑亲和度 + 已知歌曲集合 */
export async function buildAffinityContext(username: string, userId: number): Promise<AffinityContext> {
  const artistAffinity = new Map<string, number>()
  const albumAffinity = new Map<string, number>()
  const knownUids = new Set<string>()
  let personalized = false
  const now = new Date()

  const addAffinity = (mi: MusicInfo, weight: number) => {
    for (const artist of splitSinger(mi.singer)) {
      artistAffinity.set(artist, (artistAffinity.get(artist) ?? 0) + weight)
    }
    personalized = true
  }

  // 1) 播放历史：ln(1+playCount) × 时间衰减
  const history = await prisma.playHistory.findMany({
    where: { username },
    select: { id: true, musicInfoId: true, songmid: true, playCount: true, playedAt: true },
  })
  const histInfo = await loadMusicInfoByIds(
    history.map(h => h.musicInfoId).filter((id): id is number => id !== null),
  )
  for (const h of history) {
    const mi = h.musicInfoId !== null ? histInfo.get(h.musicInfoId) : undefined
    if (!mi) continue
    if (h.songmid) knownUids.add(h.songmid)
    addAffinity(mi, Math.log(1 + h.playCount) * recencyDecay(h.playedAt, now))
  }

  // 2) 收藏：固定权重，不衰减
  const favorites = await prisma.favorite.findMany({
    where: { userId, itemType: 'song' },
    select: { itemId: true },
  })
  const favInfo = await loadMusicInfoByUids(favorites.map(f => f.itemId))
  for (const f of favorites) {
    knownUids.add(f.itemId)
    const mi = favInfo.get(f.itemId)
    if (mi) addAffinity(mi, FAVORITE_WEIGHT)
  }

  // 3) 用户歌单：固定权重，不衰减
  const playlists = await prisma.playlist.findMany({
    where: { username },
    select: { id: true },
  })
  if (playlists.length > 0) {
    const entries = await prisma.playlistEntry.findMany({
      where: { playlistId: { in: playlists.map(p => p.id) } },
      select: { id: true, musicInfoId: true, songmid: true },
    })
    const entryInfo = await loadMusicInfoByIds(
      entries.map(e => e.musicInfoId).filter((id): id is number => id !== null),
    )
    for (const e of entries) {
      if (e.songmid) knownUids.add(e.songmid)
      const mi = e.musicInfoId !== null ? entryInfo.get(e.musicInfoId) : undefined
      if (mi) {
        knownUids.add(`${mi.source}-${getStorageSongmidForMusicInfo(mi)}`)
        addAffinity(mi, PLAYLIST_WEIGHT)
      }
    }
  }

  // 4) 专辑亲和：收藏歌 + 播放次数最多的歌所在专辑
  const albumSongs: MusicInfo[] = []
  for (const mi of favInfo.values()) albumSongs.push(mi)
  const topPlayed = [...histInfo.entries()]
    .sort((a, b) => {
      const ha = history.find(h => h.musicInfoId === a[0])?.playCount ?? 0
      const hb = history.find(h => h.musicInfoId === b[0])?.playCount ?? 0
      return hb - ha
    })
    .slice(0, TOP_ALBUMS)
  for (const [id] of topPlayed) {
    const mi = histInfo.get(id)
    if (mi) albumSongs.push(mi)
  }
  const albumNames = [...new Set(albumSongs.map(mi => mi.albumName).filter((n): n is string => !!n))]
  for (const album of albumNames.slice(0, TOP_ALBUMS)) {
    albumAffinity.set(album, ALBUM_BONUS)
  }

  return { artistAffinity, albumAffinity, knownUids, personalized }
}

/** 召回候选：Top 歌手的库内歌 + 亲和专辑的歌，去重后截断 */
export async function recallCandidates(ctx: AffinityContext, allowedSources: string[]): Promise<MusicInfo[]> {
  const artists = [...ctx.artistAffinity.entries()]
    .filter(([, a]) => a >= ARTIST_AFFINITY_THRESHOLD)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_ARTISTS)
    .map(([name]) => name)

  const albumNames = [...ctx.albumAffinity.keys()].slice(0, TOP_ALBUMS)

  // 单次 OR 查询拉全量候选（歌手 contains 是模糊匹配，同歌多歌手串会自然重叠，靠 uid 去重）
  const artistClauses = artists.map(name => ({ singer: { contains: name } }))
  const albumClauses = albumNames.map(name => ({ albumName: name }))
  const rows = await prisma.musicInfo.findMany({
    where: {
      source: { in: allowedSources },
      OR: [...artistClauses, ...albumClauses],
    },
    take: MAX_CANDIDATES,
  })
  const parsed: MusicInfo[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    try {
      const mi = JSON.parse(row.data) as MusicInfo
      const uid = `${row.source}-${row.songmid}`
      if (seen.has(uid)) continue
      seen.add(uid)
      parsed.push(mi)
    } catch {
      // data 列解析失败的行跳过
    }
  }
  return parsed
}

// ============ 当日缓存 ============

interface DailyCacheEntry {
  date: string
  ranked: Array<Song & { reason: string }>
}
const dailyCache = new Map<string, DailyCacheEntry>()
const DAILY_CACHE_MAX = 50

function readDailyCache(username: string): DailyCacheEntry | null {
  const hit = dailyCache.get(username)
  if (hit && hit.date === dayKey()) return hit
  dailyCache.delete(username)
  return null
}

function writeDailyCache(username: string, ranked: Array<Song & { reason: string }>): void {
  if (dailyCache.size >= DAILY_CACHE_MAX && !dailyCache.has(username)) {
    // 淘汰最早的条目（Map 保持插入序）
    const oldest = dailyCache.keys().next().value
    if (oldest !== undefined) dailyCache.delete(oldest)
  }
  dailyCache.set(username, { date: dayKey(), ranked })
}

// ============ 对外入口 ============

export interface GuessResult {
  list: Array<Song & { reason: string }>
  page: number
  size: number
  /** 服务器本地日期键（结果按日稳定） */
  date: string
  /** true = 基于用户画像；false = 冷启动随机兜底 */
  personalized: boolean
}

/**
 * 猜我喜欢：画像 → 召回 → 排序 → 分页；画像为空回退随机。
 * 结果按 (username, 当天) 缓存，同一天内分页切片稳定。
 */
export async function guessYouLike(
  username: string,
  userId: number,
  opts?: { size?: number; page?: number; includePlayed?: boolean },
): Promise<GuessResult> {
  const size = Math.max(1, Math.min(Math.floor(opts?.size ?? 30), 100))
  const page = Math.max(1, Math.min(Math.floor(opts?.page ?? 1), 10))
  const date = dayKey()

  const cached = readDailyCache(username)
  let ranked = cached?.ranked
  let personalized = true

  if (!ranked) {
    const allowedSources = getSearchSources()
    const ctx = await buildAffinityContext(username, userId)
    if (!ctx.personalized) {
      personalized = false
      // 冷启动：直接随机兜底（不缓存，等画像出现后自然切换）
      const fallback = await getRandomMusicInfoList(Math.min(size * page, 100), allowedSources)
      const list = fallback.map(mi => ({
        ...mi,
        uid: `${mi.source}-${getStorageSongmidForMusicInfo(mi)}`,
        reason: '为你随机推荐',
      }))
      return { list: list.slice((page - 1) * size, page * size), page, size, date, personalized }
    }
    const candidates = await recallCandidates(ctx, allowedSources)
    ranked = rankCandidates(candidates, ctx, username, date, { includePlayed: opts?.includePlayed })
    writeDailyCache(username, ranked)
    logger.info(`[guess] ${username} 画像就绪: 候选 ${candidates.length} → 榜单 ${ranked.length}`)
  }

  return {
    list: ranked.slice((page - 1) * size, page * size),
    page,
    size,
    date,
    personalized,
  }
}

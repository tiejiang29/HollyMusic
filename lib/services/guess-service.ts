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
 * 冷启动兜底：画像为空时回退随机池——推荐白名单优先，不足 FALLBACK_POOL_TARGET
 * 从全库确定性补齐；池子按 (username, 当天) 种子洗牌并写入当日缓存，
 * 与个性化路径共用同一套分页切片，保证同一天内刷新不变、翻页不重叠。
 */
import { prisma, getStorageSongmidForMusicInfo } from '@/lib/db'
import { getSearchSources } from '@/lib/search-config'
import { logger } from '@/lib/logger'
import { dedupeByIdentity, splitSinger, songIdentity } from '@/lib/song-identity'
import type { MusicInfo, Song } from '@/lib/types/music'

// 同曲归并工具位于 lib/song-identity.ts，此处再导出维持既有引用路径
export { splitSinger, songIdentity }

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
/** 冷启动兜底池目标规模：白名单不足时从全库补齐，支撑整日翻页不重叠 */
const FALLBACK_POOL_TARGET = 100
/** 歌手多样性：同一歌手在榜内最多出现次数 */
const MAX_PER_ARTIST = 2
/** jitter 幅度：只够打乱同分段位，不影响大局 */
const JITTER_SCALE = 2

// ============ 纯函数（导出供单测） ============

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

/** Fisher–Yates 洗牌：随机源由调用方注入（mulberry32），同种子同序，不修改原数组 */
export function shuffle<T>(items: T[], rand: () => number): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

export interface AffinityContext {
  /** 歌手 → 亲和度 */
  artistAffinity: Map<string, number>
  /** 专辑名 → 亲和度 */
  albumAffinity: Map<string, number>
  /** 已知的歌（历史 ∪ 收藏 ∪ 歌单），排序阶段剔除 */
  knownUids: Set<string>
  /** 已知歌曲的跨副本标识（songIdentity），听过 A 源副本就不推 B 源同曲 */
  knownIdentities: Set<string>
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
  const knownSongs = opts?.includePlayed ? new Set<string>() : ctx.knownIdentities
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
    .filter(item => !known.has(item.uid) && !knownSongs.has(songIdentity(item.mi)) && item.reason)
    .sort((a, b) => b.score - a.score)

  // 同一首歌多副本（跨音源 / 同音源多版本）只保留一份；没封面的副本让位给有封面的
  const unique = dedupeByIdentity(scored, s => s.mi).sort((a, b) => b.score - a.score)

  // 歌手多样性：贪心选取，每个主歌手最多 MAX_PER_ARTIST 首；
  // 被上限卡掉的歌进 deferred，第二轮按分数序补在榜尾——
  // 避免画像里歌手太少时整个榜单被截断到只剩寥寥几首
  const perArtist = new Map<string, number>()
  const ranked: Array<Song & { reason: string }> = []
  const deferred: typeof unique = []
  for (const item of unique) {
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
  const knownIdentities = new Set<string>()
  let personalized = false
  const now = new Date()

  const addAffinity = (mi: MusicInfo, weight: number) => {
    for (const artist of splitSinger(mi.singer)) {
      artistAffinity.set(artist, (artistAffinity.get(artist) ?? 0) + weight)
    }
    knownIdentities.add(songIdentity(mi))
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

  return { artistAffinity, albumAffinity, knownUids, knownIdentities, personalized }
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

/**
 * 冷启动兜底池：推荐白名单优先，不足 FALLBACK_POOL_TARGET 时按 id 倒序从全库补齐。
 * 两种取数都是确定性的（不做随机抽样），当日缓存失效或进程重启后重算仍得同一批歌，
 * 洗牌顺序由 (username, 当天) 种子决定——兜底路径因此与个性化路径一样按日稳定。
 */
async function loadFallbackPool(
  allowedSources: string[],
): Promise<Array<{ mi: MusicInfo; uid: string }>> {
  // 与 getRandomMusicInfoList 同语义：空数组视为不过滤音源
  const srcFilter = allowedSources.length > 0 ? { source: { in: allowedSources } } : {}
  const parseRows = (rows: Array<{ source: string; songmid: string; data: string | null }>) =>
    rows.flatMap(row => {
      try {
        return [{ mi: JSON.parse(row.data ?? '') as MusicInfo, uid: `${row.source}-${row.songmid}` }]
      } catch {
        // data 列解析失败的行跳过
        return []
      }
    })

  const wlRows = await prisma.musicInfo.findMany({ where: { isRecommended: true, ...srcFilter } })
  let pool = parseRows(wlRows)
  if (pool.length < FALLBACK_POOL_TARGET) {
    const restRows = await prisma.musicInfo.findMany({
      where: { id: { notIn: wlRows.map(r => r.id) }, ...srcFilter },
      orderBy: { id: 'desc' },
      take: FALLBACK_POOL_TARGET - pool.length,
    })
    pool = pool.concat(parseRows(restRows))
  }

  // 同一首歌多副本（跨音源 / 同音源多版本）只保留一份；没封面的副本让位给有封面的
  return dedupeByIdentity(pool, p => p.mi)
}

// ============ 当日缓存 ============

interface DailyCacheEntry {
  date: string
  ranked: Array<Song & { reason: string }>
  personalized: boolean
}
const dailyCache = new Map<string, DailyCacheEntry>()
const DAILY_CACHE_MAX = 50

function readDailyCache(username: string): DailyCacheEntry | null {
  const hit = dailyCache.get(username)
  if (hit && hit.date === dayKey()) return hit
  dailyCache.delete(username)
  return null
}

function writeDailyCache(
  username: string,
  ranked: Array<Song & { reason: string }>,
  personalized: boolean,
): void {
  if (dailyCache.size >= DAILY_CACHE_MAX && !dailyCache.has(username)) {
    // 淘汰最早的条目（Map 保持插入序）
    const oldest = dailyCache.keys().next().value
    if (oldest !== undefined) dailyCache.delete(oldest)
  }
  dailyCache.set(username, { date: dayKey(), ranked, personalized })
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
  // 缓存命中时沿用写入时的标记，否则兜底结果会被误报成画像推荐
  let personalized = cached?.personalized ?? true

  if (!ranked) {
    const allowedSources = getSearchSources()
    const ctx = await buildAffinityContext(username, userId)
    if (ctx.personalized) {
      const candidates = await recallCandidates(ctx, allowedSources)
      ranked = rankCandidates(candidates, ctx, username, date, { includePlayed: opts?.includePlayed })
      logger.info(`[guess] ${username} 画像就绪: 候选 ${candidates.length} → 榜单 ${ranked.length}`)
    } else {
      personalized = false
      // 冷启动兜底：确定性池 + 洗牌，同样写当日缓存——不缓存的话每次请求
      // 独立抽样，同一天内刷新会变脸、翻页会重叠，违背"按日稳定"的对外承诺
      const pool = await loadFallbackPool(allowedSources)
      ranked = shuffle(pool, mulberry32(hashSeed(`guess-fallback:${username}:${date}`)))
        .slice(0, FALLBACK_POOL_TARGET)
        .map(({ mi, uid }) => ({ ...mi, uid, reason: '为你随机推荐' }))
      logger.info(`[guess] ${username} 冷启动兜底: 池 ${pool.length} → 榜单 ${ranked.length}`)
    }
    writeDailyCache(username, ranked, personalized)
  }

  return {
    list: ranked.slice((page - 1) * size, page * size),
    page,
    size,
    date,
    personalized,
  }
}

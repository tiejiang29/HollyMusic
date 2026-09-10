/**
 * 猜我喜欢（Guess You Like）推荐服务
 *
 * v2 算法：在 v1 content-based 基础上引入歌曲级播放统计（lib/services/play-stats.ts）——
 * 同一首歌跨音源/同源多副本的播放计数先按歌曲标识合并（totalPlays = Σ 副本计数），
 * 画像信号全部先落到"这首歌"上，再统一聚合进歌手/专辑亲和度：
 *
 *   播放   ln(1 + totalPlays) × 2^(−距最近一次天数/14)（半衰期 14 天）
 *   收藏   权重 5（显式表态，不衰减；同一首歌多份副本只计一次）
 *   歌单   权重 3（主动收集，不衰减；同上）
 * 专辑加成 = ALBUM_BONUS × ln(1 + 专辑内歌曲分之和)，重听越狠加成越大。
 *
 * 排序：score = Σ(候选歌匹配到的歌手亲和度) + 专辑亲和加成 + jitter。
 * jitter 用 mulberry32 PRNG，种子 = hash(username + 当天日期)：
 * 同一用户同一天结果稳定（"每日"语义），第二天自动换血。
 * 排序后执行歌手多样性约束（每个歌手最多 2 首），分页从完整榜切片。
 *
 * 冷启动兜底：画像为空时回退随机池——推荐白名单优先，不足 FALLBACK_POOL_TARGET
 * 从全库确定性补齐；画像存在但榜单不足请求 size（画像太窄被剔除后枯竭）时，
 * 用同一池子补足到 size，理由标「为你随机推荐」。池子按 (username, 当天) 种子
 * 洗牌并写入当日缓存，与个性化路径共用同一套分页切片，保证同一天内刷新不变、翻页不重叠。
 */
import { prisma, getStorageSongmidForMusicInfo } from '@/lib/db'
import { getSearchSources } from '@/lib/search-config'
import { logger } from '@/lib/logger'
import { dedupeByIdentity, splitSinger, songIdentity } from '@/lib/song-identity'
import {
  mergePlayRows,
  loadMusicInfoByIds,
  loadMusicInfoByUids,
  loadUnresolvedByUid,
} from '@/lib/services/play-stats'
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

/**
 * 构建用户画像：歌手/专辑亲和度 + 已知歌曲集合。
 * v2：播放/收藏/歌单三类信号先合并到歌曲级（同一首歌跨副本不再各自为战），
 * 最后统一聚合进歌手/专辑亲和度。
 */
export async function buildAffinityContext(username: string, userId: number): Promise<AffinityContext> {
  const artistAffinity = new Map<string, number>()
  const albumAffinity = new Map<string, number>()
  const knownUids = new Set<string>()
  const knownIdentities = new Set<string>()
  let personalized = false
  const now = new Date()

  // 歌曲级信号表（v2 核心）：合并键 → { 分数, 代表副本 }。
  // 播放分由 mergePlayRows 结果先写入；收藏/歌单等显式信号对同一首歌
  // （同一合并键）只加一次——v1 里同一首歌的两份副本会各加一次 5 分
  const songSignals = new Map<string, { score: number; mi: MusicInfo }>()
  const explicitSeen = { favorite: new Set<string>(), playlist: new Set<string>() }
  const signalKey = (mi: MusicInfo) => {
    const identity = songIdentity(mi)
    // 歌名歌手都缺失无法归并的行回退副本 uid，避免不同歌落进同一个空键
    return identity === '|' ? `${mi.source}-${getStorageSongmidForMusicInfo(mi)}` : identity
  }
  const addExplicitSignal = (mi: MusicInfo, weight: number, kind: 'favorite' | 'playlist') => {
    const key = signalKey(mi)
    const seen = explicitSeen[kind]
    if (seen.has(key)) return
    seen.add(key)
    const cur = songSignals.get(key)
    if (cur) cur.score += weight
    else songSignals.set(key, { score: weight, mi })
    knownIdentities.add(songIdentity(mi))
    personalized = true
  }

  // 1) 播放历史：副本计数合并 → ln(1+这首歌听的总次数) × 时间衰减
  const history = await prisma.playHistory.findMany({
    where: { username },
    select: { id: true, musicInfoId: true, songmid: true, playCount: true, playedAt: true },
  })
  // 已知歌曲先按行收齐：解析失败的行也不进推荐
  for (const h of history) {
    if (h.songmid) knownUids.add(h.songmid)
  }
  const infoById = await loadMusicInfoByIds(
    history.map(h => h.musicInfoId).filter((id): id is number => id !== null),
  )
  const infoByUid = await loadUnresolvedByUid(history, infoById)
  for (const s of mergePlayRows(history, infoById, infoByUid)) {
    songSignals.set(s.key, {
      score: Math.log(1 + s.totalPlays) * recencyDecay(s.lastPlayedAt, now),
      mi: s.mi,
    })
    knownIdentities.add(songIdentity(s.mi))
    personalized = true
  }

  // 2) 收藏：固定权重，不衰减；同一首歌多份副本只计一次显式权重
  const favorites = await prisma.favorite.findMany({
    where: { userId, itemType: 'song' },
    select: { itemId: true },
  })
  const favInfo = await loadMusicInfoByUids(favorites.map(f => f.itemId))
  for (const f of favorites) {
    knownUids.add(f.itemId)
    const mi = favInfo.get(f.itemId)
    if (mi) addExplicitSignal(mi, FAVORITE_WEIGHT, 'favorite')
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
        addExplicitSignal(mi, PLAYLIST_WEIGHT, 'playlist')
      }
    }
  }

  // 4) 聚合：歌手亲和 = 歌手各歌分数之和；专辑加成 = ALBUM_BONUS × ln(1+专辑Σ)。
  //    入选专辑按"专辑内已知歌的分数总和"排序取 TOP_ALBUMS——重听越狠加成越大
  //    （v1 是与强度无关的固定加成）
  const albumScores = new Map<string, number>()
  for (const { score, mi } of songSignals.values()) {
    for (const artist of splitSinger(mi.singer)) {
      artistAffinity.set(artist, (artistAffinity.get(artist) ?? 0) + score)
    }
    if (mi.albumName) {
      albumScores.set(mi.albumName, (albumScores.get(mi.albumName) ?? 0) + score)
    }
  }
  const topAlbums = [...albumScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_ALBUMS)
  for (const [name, sum] of topAlbums) {
    albumAffinity.set(name, ALBUM_BONUS * Math.log(1 + sum))
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

/**
 * 榜单补足：画像歌手/专辑太少时召回有限，再经已知歌剔除与跨源去重，
 * 榜单可能远短于请求的 size。复用冷启动确定性池补齐——跳过用户已知的歌
 * （knownUids/knownIdentities）与榜内已有的歌，补进来的都是没听过的；
 * 洗牌种子含 (username, 当天)，补足结果随当日缓存一起按日稳定。
 */
async function topUpRanked(
  ranked: Array<Song & { reason: string }>,
  size: number,
  ctx: AffinityContext,
  allowedSources: string[],
  username: string,
  date: string,
): Promise<Array<Song & { reason: string }>> {
  const seenUids = new Set(ranked.map(s => s.uid))
  const seenIdentities = new Set(
    ranked.map(s => songIdentity(s)).filter(id => id !== '|'),
  )
  const pool = shuffle(
    await loadFallbackPool(allowedSources),
    mulberry32(hashSeed(`guess-topup:${username}:${date}`)),
  )
  for (const { mi, uid } of pool) {
    if (ranked.length >= size) break
    if (ctx.knownUids.has(uid) || seenUids.has(uid)) continue
    const identity = songIdentity(mi)
    if (identity !== '|' && (ctx.knownIdentities.has(identity) || seenIdentities.has(identity))) continue
    seenUids.add(uid)
    if (identity !== '|') seenIdentities.add(identity)
    ranked.push({ ...mi, uid, reason: '为你随机推荐' })
  }
  return ranked
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
      // 画像太窄时榜单可能远短于请求的 size（召回少 + 已知歌剔除 + 跨源去重），
      // 用兜底池补足到 size——补足发生在写当日缓存前，当日稳定与翻页语义不受影响
      if (ranked.length < size) {
        const before = ranked.length
        ranked = await topUpRanked(ranked, size, ctx, allowedSources, username, date)
        logger.info(`[guess] ${username} 榜单补足: ${before} → ${ranked.length}`)
      }
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

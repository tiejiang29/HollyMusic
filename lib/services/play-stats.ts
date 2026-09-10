/**
 * 歌曲播放统计层（猜你喜欢 v2 数据底座）
 *
 * PlayHistory 是"每用户每副本一行"的计数器（@@unique([username, songmid])，
 * songmid 存 source-存储songmid 形式的 uid）：同一首歌在 kw 听 5 次、wy 听 3 次
 * 就是两行。本模块把行级计数按歌曲标识（songIdentity = 归一化歌名|歌手集合）
 * 合并成"这个人把这首歌听了多少次"的歌曲级视图——totalPlays 跨副本求和、
 * lastPlayedAt 取最近一次、代表副本优先带封面。
 *
 * guess-service v2 的画像构建与 GET /api/stats/song-plays 数据出口共用此层；
 * loadMusicInfoByIds / loadMusicInfoByUids 两个 MusicInfo 批量解析器也放这里
 * （guess-service 反向引用，避免循环依赖）。
 */
import { prisma, getStorageSongmidForMusicInfo } from '@/lib/db'
import { songIdentity } from '@/lib/song-identity'
import type { MusicInfo } from '@/lib/types/music'

/** 行级播放计数（PlayHistory 子集字段） */
export interface PlayRow {
  musicInfoId: number | null
  /** uid（source-存储songmid），reportPlay 必写 */
  songmid: string | null
  playCount: number
  playedAt: Date
}

/** 歌曲级播放统计（跨副本合并后的一条） */
export interface SongPlayStat {
  /** 合并键：songIdentity；歌名歌手都缺失导致空标识时回退副本 uid */
  key: string
  /** 代表副本（优先带封面） */
  mi: MusicInfo
  /** 代表副本 uid（source-存储songmid） */
  uid: string
  /** 合并进来的副本行数 */
  copies: number
  /** 这个人把这首歌听的总次数（全部副本 playCount 之和） */
  totalPlays: number
  /** 最近一次播放时间（全部副本取 max） */
  lastPlayedAt: Date
}

/**
 * 把行级播放计数合并成歌曲级统计（纯函数，导出供单测）。
 * 解析不到 MusicInfo 的行跳过（与 v1 画像一致的跳过语义）。
 */
export function mergePlayRows(
  rows: PlayRow[],
  infoById: Map<number, MusicInfo>,
  infoByUid: Map<string, MusicInfo>,
): SongPlayStat[] {
  interface Group {
    totalPlays: number
    lastPlayedAt: Date
    copies: number
    mi: MusicInfo
    uid: string
  }
  const groups = new Map<string, Group>()
  for (const row of rows) {
    const mi =
      (row.musicInfoId !== null ? infoById.get(row.musicInfoId) : undefined) ??
      (row.songmid ? infoByUid.get(row.songmid) : undefined)
    if (!mi) continue
    const uid = row.songmid ?? `${mi.source}-${getStorageSongmidForMusicInfo(mi)}`
    const identity = songIdentity(mi)
    const key = identity === '|' ? uid : identity
    const g = groups.get(key)
    if (!g) {
      groups.set(key, { totalPlays: row.playCount, lastPlayedAt: row.playedAt, copies: 1, mi, uid })
      continue
    }
    g.totalPlays += row.playCount
    g.copies += 1
    if (row.playedAt > g.lastPlayedAt) g.lastPlayedAt = row.playedAt
    // 代表副本让位：没封面的让给有封面的（与 dedupeByIdentity 同语义）
    if (!g.mi.img && mi.img) {
      g.mi = mi
      g.uid = uid
    }
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, ...g }))
    .sort(
      (a, b) =>
        b.totalPlays - a.totalPlays ||
        b.lastPlayedAt.getTime() - a.lastPlayedAt.getTime() ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
}

/** 通过 musicInfoId 批量取 MusicInfo（历史/歌单条目走这条路径） */
export async function loadMusicInfoByIds(ids: number[]): Promise<Map<number, MusicInfo>> {
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
export async function loadMusicInfoByUids(uids: string[]): Promise<Map<string, MusicInfo>> {
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

/** 历史行里 musicInfoId 解析不到（缺关联或行已删）的，按 songmid uid 兜底取 MusicInfo */
export async function loadUnresolvedByUid(
  rows: PlayRow[],
  infoById: Map<number, MusicInfo>,
): Promise<Map<string, MusicInfo>> {
  const uids = new Set<string>()
  for (const r of rows) {
    if (r.songmid && (r.musicInfoId === null || !infoById.has(r.musicInfoId))) uids.add(r.songmid)
  }
  return loadMusicInfoByUids([...uids])
}

/**
 * 某用户的歌曲级播放统计：全部 PlayHistory 行 → MusicInfo 解析（id 优先、
 * songmid 兜底）→ 按歌曲标识合并。按 totalPlays 降序。
 */
export async function getUserSongPlays(username: string): Promise<SongPlayStat[]> {
  const rows = await prisma.playHistory.findMany({
    where: { username },
    select: { musicInfoId: true, songmid: true, playCount: true, playedAt: true },
  })
  const infoById = await loadMusicInfoByIds(
    rows.map(r => r.musicInfoId).filter((id): id is number => id !== null),
  )
  const infoByUid = await loadUnresolvedByUid(rows, infoById)
  return mergePlayRows(rows, infoById, infoByUid)
}

/**
 * 播放历史 service
 *
 * 使用 Prisma PlayHistory 表。
 * 上报时先定位歌曲行（缺失才用上报载荷建形），再写历史记录，保证 musicInfoId 可关联。
 *
 * 去重策略（商业项目主流做法）：
 *   同一用户同一首歌只保留一条记录（@@unique([username, songmid])）。
 *   再次播放时 upsert 更新 playedAt 为当前时间，自然"移动到顶部"，
 *   避免历史列表出现重复项，也修复了 SongRow 多行同时高亮的问题。
 *
 * 上限策略：
 *   每用户最多 MAX_HISTORY_PER_USER 条（默认 500），超过则删除最旧的记录，
 *   保证数据库行数可控、查询性能稳定。
 */

import * as dbAPI from '../db'
import { prisma, getStorageSongmidForMusicInfo } from '../db'
import { songIdentity } from '../song-identity'
import { logger } from '../logger'
import type { MusicInfo } from '../types/music'

/** 每用户历史记录上限，超出则 FIFO 淘汰最旧记录。可通过环境变量覆盖。 */
const MAX_HISTORY_PER_USER = Number(process.env.MAX_HISTORY_PER_USER) || 500

export interface HistoryEntry {
  id: number
  songId: string | null
  musicInfo: MusicInfo | null
  playedAt: string
  /** 累计播放次数（重复播放累加），猜我喜欢与前端"常听"展示用 */
  playCount: number
}

/**
 * 定位这首歌在库里的规范行，只有库里确实没有时才用上报载荷建形。
 *
 * 上报载荷往往只是客户端手里的那部分字段（安卓壳的 Song 只有 7 个键，没有
 * hash/types/copyrightId/mrcUrl），而 upsert 的 checksum 分支是整行覆盖 ——
 * 直接写会把入库时的完整行刷成薄行（实测毁掉 101 行的标识列）。
 * kg 还要多跳一步：它的存储键是 FileHash，缺 hash 的载荷算不出键，
 * 于是每次手机播放酷狗歌都会另起一行 Audioid 键的重复行，故按同款歌组找回带 hash 的那份。
 */
async function locateReportTarget(
  musicInfo: MusicInfo,
): Promise<{ songmid: string; id: number | null }> {
  const storageSongmid = getStorageSongmidForMusicInfo(musicInfo)
  const exact = await findTargetRow(musicInfo.source, storageSongmid)
  if (exact) return exact

  if (musicInfo.source === 'kg' && !musicInfo.hash) {
    // 同款歌组一般只有几行，取回来在 JS 里比：kg 的 data.songmid 在不同入库路径下
    // 有数字也有字符串（music-search.js 未 String() 转换），SQL 侧的模式匹配靠不住。
    const siblings = await prisma.musicInfo.findMany({
      where: { source: 'kg', identity: songIdentity(musicInfo), hash: { gt: '' } },
      orderBy: { id: 'asc' },
      take: 20,
      select: { id: true, songmid: true, data: true },
    })
    // 先要 Audioid 相同的那一份（同一版本），退一步才认同款歌的任意副本
    const sameVersion = siblings.find(s => {
      try {
        return String((JSON.parse(s.data) as MusicInfo).songmid) === String(musicInfo.songmid)
      } catch {
        return false
      }
    })
    const sibling = sameVersion ?? siblings[0]
    if (sibling) return { id: sibling.id, songmid: sibling.songmid }
  }

  await dbAPI.upsertMusicInfo(musicInfo)
  // 以库为准回读（P2002 竞争下别的请求可能刚建好同一行）
  return (await findTargetRow(musicInfo.source, storageSongmid))
    ?? { songmid: storageSongmid, id: null }
}

async function findTargetRow(source: string, songmid: string) {
  return prisma.musicInfo.findUnique({
    where: { source_songmid: { source, songmid } },
    select: { id: true, songmid: true },
  })
}

/**
 * 上报一次播放。
 *
 * 1. 定位歌曲行（库里已有就不写库，见 locateReportTarget）
 * 2. upsert 历史记录：已存在则更新 playedAt（移动到顶部），不存在则新建
 * 3. 超过上限时删除该用户最旧的记录
 */
export async function reportPlay(username: string, musicInfo: MusicInfo): Promise<void> {
  // 1) 定位歌曲行，顺带拿到行 id 与真正的存储键（kg 薄载荷会被纠正到 FileHash 行）
  const target = await locateReportTarget(musicInfo)
  const songId = `${musicInfo.source}-${target.songmid}`

  // 2) upsert 历史：已存在则更新 playedAt（移动到顶部）并累加 playCount，不存在则新建
  await prisma.playHistory.upsert({
    where: { username_songmid: { username, songmid: songId } },
    create: {
      username,
      musicInfoId: target.id,
      songmid: songId,
    },
    update: {
      playedAt: new Date(),
      musicInfoId: target.id,
      playCount: { increment: 1 },
    },
  })
  logger.debug(`[history] reported play: ${songId} for ${username}`)

  // 3) 上限裁剪：超过 MAX_HISTORY_PER_USER 则删除最旧的记录
  await trimHistory(username)
}

/**
 * 删除该用户超出上限的最旧历史记录。
 * 取最旧的 (count - MAX) 条，按 playedAt 升序删除。
 */
async function trimHistory(username: string): Promise<void> {
  const count = await prisma.playHistory.count({ where: { username } })
  if (count <= MAX_HISTORY_PER_USER) return

  const overflow = count - MAX_HISTORY_PER_USER
  const oldest = await prisma.playHistory.findMany({
    where: { username },
    orderBy: { playedAt: 'asc' },
    take: overflow,
    select: { id: true },
  })
  if (oldest.length === 0) return

  await prisma.playHistory.deleteMany({
    where: { id: { in: oldest.map(r => r.id) } },
  })
  logger.info(`[history] trimmed ${oldest.length} oldest entries for ${username}`)
}

/**
 * 查询播放历史（按时间倒序），逐条富化 MusicInfo。
 */
export async function listHistory(
  username: string,
  opts?: { limit?: number; offset?: number }
): Promise<{ list: HistoryEntry[]; total: number }> {
  const limit = opts?.limit ?? 100
  const offset = opts?.offset ?? 0

  const rows = await prisma.playHistory.findMany({
    where: { username },
    orderBy: { playedAt: 'desc' },
    take: limit,
    skip: offset,
  })
  const total = await prisma.playHistory.count({ where: { username } })

  const list: HistoryEntry[] = []
  for (const row of rows) {
    const musicInfo = row.songmid ? await dbAPI.resolveMusicInfoById(row.songmid) : null
    list.push({
      id: row.id,
      songId: row.songmid,
      musicInfo,
      playedAt: row.playedAt.toISOString(),
      playCount: row.playCount,
    })
  }

  return { list, total }
}

/**
 * 清空用户的播放历史。
 */
export async function clearHistory(username: string): Promise<{ deleted: number }> {
  const res = await prisma.playHistory.deleteMany({ where: { username } })
  logger.info(`[history] cleared ${res.count} entries for ${username}`)
  return { deleted: res.count }
}

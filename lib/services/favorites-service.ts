/**
 * 收藏 service
 *
 * 复用 lib/favorites.ts 的数据层（starItems/unstarItems/listFavorites），
 * 在其之上做 song id 解析与 MusicInfo 富化，返回原始数据（非 XML）。
 *
 * song id 统一为 source-{存储songmid}，与 db.resolveMusicInfoById 的解析口径一致。
 *
 * 专辑收藏（itemType='album'）：专辑是平台数据（tx/kw/mg/apple 的 albumId），
 * 不在本站 MusicInfo 库里，无法靠 itemId 回查富化 —— 因此收藏时随行落一份展示快照
 * （name/singer/img），列表直接读快照，不触上游。
 */

import { PrismaClient } from '../generated/prisma'
import { starItems, unstarItems, listFavorites } from '../favorites'
import * as dbAPI from '../db'
import { getStorageSongmidForMusicInfo } from '../db'
import { logger } from '../logger'
import type { MusicInfo } from '../types/music'

const prisma = new PrismaClient()

export interface FavoriteSong {
  songId: string
  source: string | null
  starredAt: string
  musicInfo: MusicInfo | null
}

/** 收藏的专辑（快照形态，可直接渲染专辑卡） */
export interface FavoriteAlbum {
  albumId: string
  source: string | null
  name: string
  singer: string | null
  img: string | null
  starredAt: string
}

/**
 * 解析 song id（source-songmid）中的 source 平台。
 */
function parseSourceFromSongId(songId: string): string | null {
  if (!songId || !songId.includes('-')) return null
  const idx = songId.indexOf('-')
  const src = songId.substring(0, idx)
  return src || null
}

/**
 * 收藏一首歌。
 */
export async function starSong(userId: number, songId: string): Promise<{ starred: true }> {
  const source = parseSourceFromSongId(songId)
  await starItems(userId, [{ itemType: 'song', itemId: songId, source }])
  logger.info(`[favorites] starred ${songId} for user ${userId}`)
  return { starred: true }
}

/**
 * 取消收藏一首歌。
 */
export async function unstarSong(userId: number, songId: string): Promise<{ starred: false }> {
  await unstarItems(userId, [{ itemType: 'song', itemId: songId }])
  logger.info(`[favorites] unstarred ${songId} for user ${userId}`)
  return { starred: false }
}

/**
 * 检查是否已收藏。
 */
export async function checkStarred(userId: number, songId: string): Promise<boolean> {
  const row = await prisma.favorite.findFirst({
    where: { userId, itemType: 'song', itemId: songId },
    select: { id: true },
  })
  return !!row
}

/**
 * 获取收藏列表（按收藏时间倒序），逐条富化 MusicInfo。
 */
export async function listFavoriteSongs(
  userId: number,
  opts?: { limit?: number; offset?: number }
): Promise<{ list: FavoriteSong[]; total: number }> {
  const limit = opts?.limit ?? 200
  const offset = opts?.offset ?? 0

  const rows = await listFavorites(userId, { itemType: 'song', limit, offset })
  const total = await prisma.favorite.count({ where: { userId, itemType: 'song' } })

  const list: FavoriteSong[] = []
  for (const row of rows) {
    const musicInfo = await dbAPI.resolveMusicInfoById(row.itemId)
    // 用 musicInfo 重算 songId，保证与搜索/随机等出口一致
    const songId = musicInfo
      ? `${musicInfo.source}-${getStorageSongmidForMusicInfo(musicInfo)}`
      : row.itemId
    list.push({
      songId,
      source: row.source,
      starredAt: row.createdAt.toISOString(),
      musicInfo,
    })
  }

  return { list, total }
}

/** 收藏入参：albumId 是平台专辑 id（tx/kw/mg 的 albumId / Apple collectionId），source 是平台名 */
export interface StarAlbumInput {
  albumId: string
  source?: string | null
  name?: string | null
  singer?: string | null
  img?: string | null
}

/**
 * 收藏一张专辑。快照字段（name/singer/img）随行落库，重复收藏时刷新快照。
 */
export async function starAlbum(userId: number, input: StarAlbumInput): Promise<{ starred: true }> {
  await starItems(userId, [{
    itemType: 'album',
    itemId: input.albumId,
    source: input.source ?? null,
    name: input.name ?? null,
    singer: input.singer ?? null,
    img: input.img ?? null,
  }])
  logger.info(`[favorites] starred album ${input.source || '?'}-${input.albumId} for user ${userId}`)
  return { starred: true }
}

/**
 * 取消收藏专辑。source 传了就精确删该平台的记录，不传则删该专辑 id 下的全部平台记录。
 */
export async function unstarAlbum(
  userId: number,
  albumId: string,
  source?: string | null,
): Promise<{ starred: false; deleted: number }> {
  const { deleted } = await unstarItems(userId, [{ itemType: 'album', itemId: albumId, source: source ?? null }])
  logger.info(`[favorites] unstarred album ${albumId} for user ${userId} (${deleted} rows)`)
  return { starred: false, deleted }
}

/** 检查专辑是否已收藏 */
export async function checkAlbumStarred(
  userId: number,
  albumId: string,
  source?: string | null,
): Promise<boolean> {
  const row = await prisma.favorite.findFirst({
    where: { userId, itemType: 'album', itemId: albumId, ...(source ? { source } : {}) },
    select: { id: true },
  })
  return !!row
}

/**
 * 收藏专辑列表（按收藏时间倒序）。直接读快照，不回查上游。
 * 没有快照的历史行（早期 Subsonic 星标只存了 id）name 退化为 id。
 */
export async function listFavoriteAlbums(
  userId: number,
  opts?: { limit?: number; offset?: number }
): Promise<{ list: FavoriteAlbum[]; total: number }> {
  const limit = opts?.limit ?? 200
  const offset = opts?.offset ?? 0

  const rows = await listFavorites(userId, { itemType: 'album', limit, offset })
  const total = await prisma.favorite.count({ where: { userId, itemType: 'album' } })

  const list: FavoriteAlbum[] = rows.map(row => ({
    albumId: row.itemId,
    source: row.source,
    name: row.name || row.itemId,
    singer: row.singer,
    img: row.img,
    starredAt: row.createdAt.toISOString(),
  }))

  return { list, total }
}

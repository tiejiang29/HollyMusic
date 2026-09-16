import crypto from 'crypto'
import { PrismaClient } from './generated/prisma'

const prisma = new PrismaClient()

export type ItemType = 'song' | 'album' | 'artist'
/**
 * 收藏条目。
 * name/singer/img 是**展示快照**，只有专辑收藏需要：专辑是平台数据，不在本站曲库里，
 * 无法像歌曲那样靠 itemId 回查富化（详见 prisma/schema.prisma 的 Favorite 注释）。
 * 歌曲收藏不传这三个字段，行为与从前完全一致。
 */
export type FavoriteItem = {
  itemType: ItemType
  itemId: string
  source?: string | null
  name?: string | null
  singer?: string | null
  img?: string | null
}

export async function getOrCreateUserByName(username: string) {
  const name = (username || '').trim()
  if (!name) throw new Error('username required')

  let user = await prisma.user.findUnique({ where: { username: name } })
  if (!user) {
    user = await prisma.user.create({ data: { username: name } })
  }
  return user
}

export async function verifyTForUser(username: string, t: string | null | undefined, s: string | null | undefined): Promise<boolean> {
  if (!t || !s) return false
  const name = (username || '').trim()
  if (!name) return false

  const user = await prisma.user.findUnique({ where: { username: name }, select: { subsonicSecret: true } })
  if (!user || !user.subsonicSecret) return false

  const expected = crypto.createHash('md5').update(String(user.subsonicSecret) + String(s)).digest('hex')
  try {
    const a = Buffer.from(expected, 'hex')
    const b = Buffer.from(String(t), 'hex')
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function starItems(userId: number, items: FavoriteItem[]) {
  if (!items || items.length === 0) return { created: 0 }

  // Use upsert for each item to make operation idempotent (Prisma v5 doesn't support skipDuplicates)
  // Note: We try upsert first; if unique constraint fails (e.g., when source is null in SQLite),
  // we fall back to checking existence
  let created = 0
  for (const item of items) {
    try {
      const source = item.source ?? null
      const existing = await prisma.favorite.findFirst({
        where: { userId, itemType: item.itemType, itemId: item.itemId, source },
      })
      if (!existing) {
        await prisma.favorite.create({
          data: {
            userId,
            itemType: item.itemType,
            itemId: item.itemId,
            source,
            name: item.name ?? null,
            singer: item.singer ?? null,
            img: item.img ?? null,
          },
        })
        created++
      } else if (item.name || item.singer || item.img) {
        // 已收藏过：刷新展示快照（专辑名/封面可能在上游变过），不改变收藏时间
        await prisma.favorite.update({
          where: { id: existing.id },
          data: { name: item.name ?? null, singer: item.singer ?? null, img: item.img ?? null },
        })
      }
    } catch (err) {
      // ignore constraint/uniqueness errors
      console.warn('[starItems] error for item', item, err)
    }
  }
  return { created }
}

export async function unstarItems(userId: number, items: FavoriteItem[]) {
  if (!items || items.length === 0) {
    console.warn('[unstarItems] Warning: called with empty items array')
    return { deleted: 0 }
  }

  let totalDeleted = 0

  for (const item of items) {
    if (!item.itemId) {
      console.warn('[unstarItems] Warning: item without itemId', item)
      continue
    }

    // 删除匹配 userId + itemType + itemId 的记录；显式传了 source 时再按平台收窄。
    // 必须带上 itemType：本站 song id 与 Subsonic 专辑 id 同为 `source-{key}` 形态，
    // 可能是同一个字符串，只按 itemId 删会把另一种类型的收藏一起删掉。
    const source = item.source ?? null
    const res = await prisma.favorite.deleteMany({
      where: {
        userId,
        itemType: item.itemType,
        itemId: item.itemId,
        ...(source ? { source } : {}),
      },
    })
    console.log('[unstarItems] Deleted', res.count, 'records for userId', userId, 'itemId', item.itemId)
    totalDeleted += res.count
  }

  console.log('[unstarItems] Total deleted:', totalDeleted)
  return { deleted: totalDeleted }
}

export async function listFavorites(userId: number, opts?: { itemType?: ItemType; limit?: number; offset?: number }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { userId }
  if (opts?.itemType) where.itemType = opts.itemType

  const rows = await prisma.favorite.findMany({ where, orderBy: { createdAt: 'desc' }, take: opts?.limit ?? 100, skip: opts?.offset ?? 0 })
  return rows
}

// note: user-specific helpers (like updateLastLogin) moved to lib/user.ts
const favoritesApi = {
  getOrCreateUserByName,
  verifyTForUser,
  starItems,
  unstarItems,
  listFavorites,
}

export default favoritesApi

/**
 * lib/favorites.ts 测试
 *
 * 重点守专辑收藏引入快照后的两条数据层约定：
 * 1. starItems 落展示快照（name/singer/img），重复收藏时刷新快照但不改收藏时间；
 *    歌曲收藏不带快照，行为与从前完全一致（不做多余 update）。
 * 2. unstarItems 必须按 itemType 收窄 —— 本站 song id 与 Subsonic 专辑 id 同为
 *    `source-{key}` 形态，可能是同一个字符串，只按 itemId 删会误删另一类型的收藏。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { findFirst, create, update, deleteMany } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
}))

vi.mock('./generated/prisma', () => ({
  PrismaClient: class {
    favorite = { findFirst, create, update, deleteMany }
    user = { findUnique: vi.fn() }
  },
  Prisma: {},
}))

const { starItems, unstarItems } = await import('./favorites')

beforeEach(() => {
  findFirst.mockReset()
  create.mockReset()
  update.mockReset()
  deleteMany.mockReset()
  create.mockResolvedValue({ id: 1 })
  update.mockResolvedValue({ id: 1 })
  deleteMany.mockResolvedValue({ count: 1 })
})

describe('starItems 的展示快照', () => {
  it('收藏专辑时把 name/singer/img 一并落库', async () => {
    findFirst.mockResolvedValueOnce(null)

    const { created } = await starItems(1, [{
      itemType: 'album',
      itemId: 't1-album-9',
      source: 'tx',
      name: '范特西',
      singer: '周杰伦',
      img: 'http://img/f.jpg',
    }])

    expect(created).toBe(1)
    expect(create.mock.calls[0][0].data).toEqual({
      userId: 1,
      itemType: 'album',
      itemId: 't1-album-9',
      source: 'tx',
      name: '范特西',
      singer: '周杰伦',
      img: 'http://img/f.jpg',
    })
  })

  it('重复收藏同一专辑时刷新快照，不新建记录', async () => {
    findFirst.mockResolvedValueOnce({ id: 42 })

    const { created } = await starItems(1, [{
      itemType: 'album',
      itemId: 't1-album-9',
      source: 'tx',
      name: '范特西（新封面）',
      singer: '周杰伦',
      img: 'http://img/new.jpg',
    }])

    expect(created).toBe(0)
    expect(create).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { name: '范特西（新封面）', singer: '周杰伦', img: 'http://img/new.jpg' },
    })
  })

  it('歌曲收藏不带快照：重复收藏不会触发多余的 update', async () => {
    findFirst.mockResolvedValueOnce({ id: 7 })

    await starItems(1, [{ itemType: 'song', itemId: 'tx-abc', source: 'tx' }])

    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('歌曲首次收藏落库时快照字段为 null（列存在但不参与）', async () => {
    findFirst.mockResolvedValueOnce(null)

    await starItems(1, [{ itemType: 'song', itemId: 'tx-abc', source: 'tx' }])

    expect(create.mock.calls[0][0].data).toMatchObject({
      itemType: 'song',
      name: null,
      singer: null,
      img: null,
    })
  })
})

describe('unstarItems 的删除口径', () => {
  it('未传 source 时按 itemType + itemId 删除（不跨类型误删）', async () => {
    await unstarItems(1, [{ itemType: 'album', itemId: 'tx-abc' }])

    // 关键：itemType 必须出现在 where 里。本站 song id 与专辑 id 可能同形，
    // 只按 { userId, itemId } 删会把另一类型的收藏一起清掉。
    expect(deleteMany.mock.calls[0][0].where).toEqual({
      userId: 1,
      itemType: 'album',
      itemId: 'tx-abc',
    })
  })

  it('显式传 source 时再按平台收窄', async () => {
    await unstarItems(1, [{ itemType: 'album', itemId: 'tx-abc', source: 'tx' }])

    expect(deleteMany.mock.calls[0][0].where).toEqual({
      userId: 1,
      itemType: 'album',
      itemId: 'tx-abc',
      source: 'tx',
    })
  })

  it('累计多条删除数并跳过没有 itemId 的条目', async () => {
    deleteMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 })

    const { deleted } = await unstarItems(1, [
      { itemType: 'song', itemId: 'tx-a' },
      { itemType: 'song', itemId: '' },
      { itemType: 'artist', itemId: 'ar-1' },
    ])

    expect(deleted).toBe(3)
    expect(deleteMany).toHaveBeenCalledTimes(2)
  })
})

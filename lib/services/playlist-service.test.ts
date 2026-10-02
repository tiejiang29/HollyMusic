/**
 * lib/services/playlist-service.ts 测试
 *
 * 重点守 createPlaylist 的 collected 口径：默认自建=false，
 * 导入/副本类调用（import / import-remote）必须显式传 true 才能进「收藏歌单」分组。
 * 回归背景：平台歌单导入曾裸调 createPlaylist，副本落在「自建歌单」里。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  playlistCreate, playlistFindUnique, playlistUpdate,
  entryFindFirst, entryFindMany, entryCreateMany, entryCount,
  musicInfoFindMany, transaction,
} = vi.hoisted(() => ({
  playlistCreate: vi.fn(),
  playlistFindUnique: vi.fn(),
  playlistUpdate: vi.fn(),
  entryFindFirst: vi.fn(),
  entryFindMany: vi.fn(),
  entryCreateMany: vi.fn(),
  entryCount: vi.fn(),
  musicInfoFindMany: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../generated/prisma', () => ({
  PrismaClient: class {
    playlist = { create: playlistCreate, findUnique: playlistFindUnique, update: playlistUpdate }
    playlistEntry = {
      findFirst: entryFindFirst, findMany: entryFindMany,
      createMany: entryCreateMany, count: entryCount,
    }
    musicInfo = { findMany: musicInfoFindMany }
    $transaction = transaction
  },
  Prisma: {},
}))
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { createPlaylist, addSongsToPlaylist, PlaylistError } = await import('./playlist-service')

beforeEach(() => {
  playlistCreate.mockReset()
  // 回显入参，便于断言落库字段
  playlistCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 1,
    name: data.name,
    username: data.username,
    owner: data.owner,
    comment: (data.comment as string | null) ?? null,
    isPublic: data.isPublic,
    collected: data.collected,
    songCount: data.songCount,
    duration: data.duration,
    coverArt: null,
    createdAt: new Date('2026-09-16T00:00:00Z'),
    allowedUsers: [],
  }))
})

describe('createPlaylist 的 collected 口径', () => {
  it('默认自建：collected 落 false', async () => {
    const summary = await createPlaylist('tester', '我的歌单')
    const data = playlistCreate.mock.calls[0][0].data
    expect(data.collected).toBe(false)
    expect(summary.collected).toBe(false)
  })

  it('导入/副本：显式传 { collected: true } 时落 true', async () => {
    const summary = await createPlaylist('tester', '平台歌单副本', { collected: true })
    const data = playlistCreate.mock.calls[0][0].data
    expect(data.collected).toBe(true)
    expect(summary.collected).toBe(true)
  })

  it('自建与副本的其它字段口径一致（owner=自己、默认私有）', async () => {
    await createPlaylist('tester', 'x', { collected: true })
    const data = playlistCreate.mock.calls[0][0].data
    expect(data).toMatchObject({ username: 'tester', owner: 'tester', isPublic: false, songCount: 0 })
  })
})

describe('addSongsToPlaylist 改批量 + 单事务', () => {
  // 改前的形状：每首 3 次串行往返（findFirst 查重 + findUnique 解析 + create），
  // dev 实测 300 首 = 3239ms；并且 position 在 JS 侧自增、没有事务，
  // 三批并发打同一歌单会撞 @@unique([playlistId, position])（实测两批 500、只落 120 条）。
  const uid = (n: number) => `kw-${n}`
  /** many(300) = kw-1..kw-300；many([1,2]) = kw-1、kw-2 */
  const many = (countOrIds: number | number[]) =>
    (Array.isArray(countOrIds) ? countOrIds : Array.from({ length: countOrIds }, (_, i) => i + 1)).map(uid)

  beforeEach(() => {
    for (const fn of [playlistFindUnique, playlistUpdate, entryFindFirst, entryFindMany,
      entryCreateMany, entryCount, musicInfoFindMany, transaction]) fn.mockReset()

    playlistFindUnique.mockResolvedValue({ username: 'tester' })
    entryFindFirst.mockResolvedValue({ position: 10 })
    entryCount.mockResolvedValue(0)
    entryCreateMany.mockResolvedValue({ count: 0 })
    playlistUpdate.mockResolvedValue({})
    // 查重那一次 findMany 返回"歌单里已有"的 songmid，刷统计那一次返回条目明细
    entryFindMany.mockImplementation(async (args: { select?: { songmid: true }; include?: unknown }) =>
      args.select ? [] : [])
    musicInfoFindMany.mockImplementation(async ({ where }: { where: { source: string; songmid: { in: string[] } } }) =>
      [...where.songmid.in].map(m => ({ id: Number(m) + 500, songmid: m })))
    transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ playlistEntry: { findFirst: entryFindFirst, createMany: entryCreateMany } }))
  })

  const rows = () => entryCreateMany.mock.calls[0]?.[0]?.data ?? []

  it('300 首一次事务、一次 createMany，往返次数与歌曲数无关', async () => {
    await addSongsToPlaylist(7, 'tester', many(300))

    expect(transaction).toHaveBeenCalledTimes(1)
    expect(entryCreateMany).toHaveBeenCalledTimes(1)
    expect(rows().length).toBe(300)
    // 按源分组：300 首同源于是一次；MusicInfo 反查只在批量入口做一次
    expect(musicInfoFindMany).toHaveBeenCalledTimes(1)
    expect(entryFindMany).toHaveBeenCalledTimes(2) // 查重 + 刷统计，不是每首一次
  })

  it('position 从"事务内重读的尾部"连续接上', async () => {
    entryFindFirst.mockResolvedValue({ position: 41 })
    await addSongsToPlaylist(7, 'tester', many([1, 2, 3]))

    expect(rows().map(r => r.position)).toEqual([42, 43, 44])
    expect(rows().every(r => r.playlistId === 7 && r.addedBy === 'tester')).toBe(true)
  })

  it('空歌单（还没有条目）从 1 开始编号', async () => {
    entryFindFirst.mockResolvedValue(null)
    await addSongsToPlaylist(7, 'tester', many([1, 2]))
    expect(rows().map(r => r.position)).toEqual([1, 2])
  })

  it('已在歌单里的歌不再插入，同批重复 uid 与空白项只算一次', async () => {
    entryFindMany.mockImplementation(async (args: { select?: { songmid: true }; include?: unknown }) =>
      args.select ? [{ songmid: 'kw-2' }] : [])

    await addSongsToPlaylist(7, 'tester', ['kw-1', 'kw-2', 'kw-1', '  ', 'kw-3', 'kw-3'])

    expect(rows().map(r => r.songmid)).toEqual(['kw-1', 'kw-3'])
    expect(rows().map(r => r.position)).toEqual([11, 12])
  })

  it('musicInfoId 用批量反查回来的行主键；库里没有这首歌时落 null 但条目照插', async () => {
    musicInfoFindMany.mockImplementation(async ({ where }: { where: { source: string; songmid: { in: string[] } } }) =>
      where.songmid.in.includes('1') ? [{ id: 501, songmid: '1' }] : [])

    await addSongsToPlaylist(7, 'tester', many([1, 2]))

    expect(rows()).toMatchObject([{ songmid: 'kw-1', musicInfoId: 501 }, { songmid: 'kw-2', musicInfoId: null }])
  })

  it('非 owner 判 403，且不发任何批量查询', async () => {
    playlistFindUnique.mockResolvedValue({ username: 'someone-else' })

    await expect(addSongsToPlaylist(7, 'tester', many([1, 2]))).rejects.toBeInstanceOf(PlaylistError)
    expect(transaction).not.toHaveBeenCalled()
    expect(entryFindMany).not.toHaveBeenCalled()
    expect(musicInfoFindMany).not.toHaveBeenCalled()
  })

  it('全是重复项时也照刷统计（与改前"无论有没有新增都 refresh"一致）', async () => {
    entryFindMany.mockImplementation(async (args: { select?: { songmid: true }; include?: unknown }) =>
      args.select ? [{ songmid: 'kw-1' }] : [])

    await addSongsToPlaylist(7, 'tester', many([1]))

    expect(entryCreateMany).not.toHaveBeenCalled()
    expect(playlistUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 }, data: expect.objectContaining({ songCount: 0 }) }),
    )
  })

  it('空输入直接走到刷统计，不起事务', async () => {
    await addSongsToPlaylist(7, 'tester', [])

    expect(transaction).not.toHaveBeenCalled()
    expect(entryCreateMany).not.toHaveBeenCalled()
    expect(playlistUpdate).toHaveBeenCalledTimes(1)
  })
})

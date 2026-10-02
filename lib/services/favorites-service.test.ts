/**
 * lib/services/favorites-service.ts 测试（专辑分支 + 歌曲列表的批量反查）
 *
 * 守专辑收藏的三条口径：
 * 1. starAlbum 走 itemType='album' 并把展示快照透传给数据层（专辑不在本站曲库，
 *    列表渲染全靠这份快照，丢了就只能显示 id）。
 * 2. listFavoriteAlbums 直接读快照；早期 Subsonic 星标只存了 id 的行 name 退化为 id。
 * 3. unstarAlbum 传了 source 时按平台精确删除。
 *
 * 另有 listFavoriteSongs 的批量口径：安卓收藏页一次要 500 条，
 * 逐条 await 反查就是 500 次查库（N+1），必须一次批量搞定。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { findFirst, count, getMusicInfoMapByIds } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  count: vi.fn(),
  getMusicInfoMapByIds: vi.fn(async () => new Map<string, unknown>()),
}))

vi.mock('../generated/prisma', () => ({
  PrismaClient: class {
    favorite = { findFirst, count }
  },
  Prisma: {},
}))

const { starItems, unstarItems, listFavorites } = vi.hoisted(() => ({
  starItems: vi.fn(async () => ({ created: 1 })),
  unstarItems: vi.fn(async () => ({ deleted: 1 })),
  listFavorites: vi.fn(async () => []),
}))

vi.mock('../favorites', () => ({ starItems, unstarItems, listFavorites }))
vi.mock('../db', () => ({
  // prisma 现由 lib/db 统一提供（本 service 不再自建客户端）
  prisma: { favorite: { findFirst, count } },
  resolveMusicInfoById: vi.fn(),
  getMusicInfoMapByIds,
  getStorageSongmidForMusicInfo: vi.fn((mi: { source: string; songmid: string; hash?: string }) =>
    mi.source === 'kg' && mi.hash ? String(mi.hash) : String(mi.songmid)),
}))
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { starAlbum, unstarAlbum, checkAlbumStarred, listFavoriteAlbums, listFavoriteSongs } = await import('./favorites-service')

beforeEach(() => {
  findFirst.mockReset()
  count.mockReset()
  starItems.mockClear()
  unstarItems.mockClear()
  listFavorites.mockClear()
})

describe('starAlbum', () => {
  it('按 itemType=album 写库，并把展示快照透传下去', async () => {
    await starAlbum(1, {
      albumId: 't1-album-9',
      source: 'tx',
      name: '范特西',
      singer: '周杰伦',
      img: 'http://img/f.jpg',
    })

    expect(starItems).toHaveBeenCalledWith(1, [{
      itemType: 'album',
      itemId: 't1-album-9',
      source: 'tx',
      name: '范特西',
      singer: '周杰伦',
      img: 'http://img/f.jpg',
    }])
  })

  it('来源/快照缺省时落 null，不写 undefined', async () => {
    await starAlbum(1, { albumId: 'kw-album-1' })

    expect(starItems.mock.calls[0][1][0]).toEqual({
      itemType: 'album',
      itemId: 'kw-album-1',
      source: null,
      name: null,
      singer: null,
      img: null,
    })
  })
})

describe('unstarAlbum', () => {
  it('把 albumId 与 source 一起交给数据层做精确删除', async () => {
    unstarItems.mockResolvedValueOnce({ deleted: 1 })

    const res = await unstarAlbum(1, 't1-album-9', 'tx')

    expect(unstarItems).toHaveBeenCalledWith(1, [{ itemType: 'album', itemId: 't1-album-9', source: 'tx' }])
    expect(res).toEqual({ starred: false, deleted: 1 })
  })

  it('不传 source 时交给数据层按 id 删该专辑的全部平台记录', async () => {
    await unstarAlbum(1, 't1-album-9')

    expect(unstarItems).toHaveBeenCalledWith(1, [{ itemType: 'album', itemId: 't1-album-9', source: null }])
  })
})

describe('checkAlbumStarred', () => {
  it('按 userId + album 类型查询，传了 source 再收窄', async () => {
    findFirst.mockResolvedValueOnce({ id: 5 })

    await expect(checkAlbumStarred(1, 't1-album-9', 'tx')).resolves.toBe(true)
    expect(findFirst.mock.calls[0][0].where).toEqual({
      userId: 1,
      itemType: 'album',
      itemId: 't1-album-9',
      source: 'tx',
    })
  })

  it('没有记录时返回 false', async () => {
    findFirst.mockResolvedValueOnce(null)
    await expect(checkAlbumStarred(1, 'nope')).resolves.toBe(false)
  })
})

describe('listFavoriteAlbums', () => {
  it('直接读快照拼专辑卡，不回查上游', async () => {
    listFavorites.mockResolvedValueOnce([{
      itemId: 't1-album-9',
      source: 'tx',
      name: '范特西',
      singer: '周杰伦',
      img: 'http://img/f.jpg',
      createdAt: new Date('2026-09-16T08:00:00Z'),
    }])
    count.mockResolvedValueOnce(1)

    const { list, total } = await listFavoriteAlbums(1)

    expect(total).toBe(1)
    expect(list).toEqual([{
      albumId: 't1-album-9',
      source: 'tx',
      name: '范特西',
      singer: '周杰伦',
      img: 'http://img/f.jpg',
      starredAt: '2026-09-16T08:00:00.000Z',
    }])
  })

  it('早期只存了 id 的行：name 退化为 id，歌手/封面为空', async () => {
    listFavorites.mockResolvedValueOnce([{
      itemId: 'tx-abc123',
      source: null,
      name: null,
      singer: null,
      img: null,
      createdAt: new Date('2026-09-16T08:00:00Z'),
    }])
    count.mockResolvedValueOnce(1)

    const { list } = await listFavoriteAlbums(1)

    expect(list[0]).toMatchObject({ albumId: 'tx-abc123', name: 'tx-abc123', singer: null, img: null })
  })

  it('只取 album 类型的行（不把歌曲收藏混进来）', async () => {
    listFavorites.mockResolvedValueOnce([])
    count.mockResolvedValueOnce(0)

    await listFavoriteAlbums(1, { limit: 10, offset: 20 })

    expect(listFavorites).toHaveBeenCalledWith(1, { itemType: 'album', limit: 10, offset: 20 })
    expect(count.mock.calls[0][0].where).toEqual({ userId: 1, itemType: 'album' })
  })
})

describe('listFavoriteSongs 的 MusicInfo 反查', () => {
  const favRow = (i: number, itemId = `kw-${2000 + i}`) => ({
    id: i,
    itemId,
    source: itemId.slice(0, itemId.indexOf('-')),
    createdAt: new Date(1790000000000 - i * 1000),
  })

  beforeEach(() => {
    getMusicInfoMapByIds.mockReset().mockResolvedValue(new Map())
    listFavorites.mockResolvedValue([])
    count.mockResolvedValue(0)
  })

  it('500 条收藏只做一次批量反查，不逐条 await', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => favRow(i))
    listFavorites.mockResolvedValueOnce(rows as never)
    count.mockResolvedValueOnce(500)

    const { list, total } = await listFavoriteSongs(7, { limit: 500, offset: 0 })

    expect(getMusicInfoMapByIds).toHaveBeenCalledTimes(1)
    expect(getMusicInfoMapByIds).toHaveBeenCalledWith(rows.map(r => r.itemId))
    expect(list).toHaveLength(500)
    expect(total).toBe(500)
  })

  it('命中时用 musicInfo 重算 songId（kg 带 hash 落 FileHash 键），查不到的退回原 itemId', async () => {
    const rows = [favRow(0, 'kg-1083058434'), favRow(1, 'tx-002NmjQb'), favRow(2, 'kw-9999')]
    listFavorites.mockResolvedValueOnce(rows as never)
    getMusicInfoMapByIds.mockResolvedValueOnce(new Map<string, unknown>([
      ['kg-1083058434', { source: 'kg', songmid: '1083058434', hash: 'FILEHASHAAA' }],
      ['tx-002NmjQb', { source: 'tx', songmid: '002NmjQb' }],
    ]) as never)

    const { list } = await listFavoriteSongs(7)

    expect(list.map(e => e.songId)).toEqual(['kg-FILEHASHAAA', 'tx-002NmjQb', 'kw-9999'])
    expect(list[2].musicInfo).toBeNull()
    expect(list[0].starredAt).toBe(rows[0].createdAt.toISOString())
  })
})

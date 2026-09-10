/**
 * lib/services/play-stats.ts 单元测试
 *
 * 覆盖：跨副本合并（totalPlays 求和 / lastPlayedAt 取最近 / copies 计行数）、
 * 空标识回退 uid 键、代表副本选封面、排序、无法解析行跳过，
 * 以及 getUserSongPlays 的 id 优先 + songmid 兜底解析链路。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStorageSongmidForMusicInfo, prisma } = vi.hoisted(() => ({
  getStorageSongmidForMusicInfo: vi.fn((mi: { songmid: string }) => mi.songmid),
  prisma: {
    musicInfo: { findMany: vi.fn() },
    playHistory: { findMany: vi.fn() },
  },
}))

vi.mock('@/lib/db', () => ({ getStorageSongmidForMusicInfo, prisma }))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { mergePlayRows, getUserSongPlays, loadMusicInfoByIds, loadMusicInfoByUids } = await import('./play-stats')

import { songIdentity } from '@/lib/song-identity'
import type { MusicInfo } from '@/lib/types/music'

/** 构造最小合法 MusicInfo */
function mi(over: Partial<MusicInfo> & { name: string; singer: string; songmid: string }): MusicInfo {
  return {
    source: 'wy',
    interval: '200',
    types: [],
    _types: {} as MusicInfo['_types'],
    typeUrl: {},
    ...over,
  } as MusicInfo

}

/** 构造最小 PlayHistory 行 */
function row(over: {
  musicInfoId?: number | null
  songmid?: string | null
  playCount: number
  playedAt: Date
}) {
  return { musicInfoId: null, songmid: null, ...over }
}

describe('mergePlayRows', () => {
  const kwCopy = mi({ name: '晴天', singer: '周杰伦', songmid: 'kw1', source: 'kw', img: 'http://x/kw.jpg' })
  const wyCopy = mi({ name: '晴天', singer: '周杰伦', songmid: 'w1', source: 'wy' })

  it('跨副本合并：totalPlays 求和、lastPlayedAt 取最近、copies 计行数', () => {
    const t1 = new Date('2026-09-01T00:00:00Z')
    const t2 = new Date('2026-09-05T00:00:00Z')
    const stats = mergePlayRows(
      [
        row({ musicInfoId: 11, songmid: 'kw-kw1', playCount: 5, playedAt: t1 }),
        row({ musicInfoId: 12, songmid: 'wy-w1', playCount: 3, playedAt: t2 }),
      ],
      new Map([
        [11, kwCopy],
        [12, wyCopy],
      ]),
      new Map(),
    )
    expect(stats).toHaveLength(1)
    expect(stats[0].totalPlays).toBe(8)
    expect(stats[0].copies).toBe(2)
    expect(stats[0].lastPlayedAt).toBe(t2)
    expect(stats[0].key).toBe(songIdentity(kwCopy))
    expect(stats[0].mi).toBe(kwCopy) // 代表副本 = 有封面的那份
    expect(stats[0].uid).toBe('kw-kw1')
  })

  it('歌名歌手都缺失时空标识回退副本 uid 键，不同歌不落同一个键', () => {
    const blank = mi({ name: '', singer: '', songmid: 'b1', source: 'kg' })
    const named = mi({ name: '正常歌', singer: 'N', songmid: 'n1', source: 'kg' })
    const stats = mergePlayRows(
      [
        row({ musicInfoId: null, songmid: 'kg-b1', playCount: 2, playedAt: new Date() }),
        row({ musicInfoId: null, songmid: 'kg-n1', playCount: 1, playedAt: new Date() }),
      ],
      new Map(),
      new Map([
        ['kg-b1', blank],
        ['kg-n1', named],
      ]),
    )
    expect(stats).toHaveLength(2)
    expect(stats.find(s => s.mi === blank)?.key).toBe('kg-b1')
  })

  it('代表副本优先有封面，封面副本不在首位也能胜出', () => {
    const noImg = mi({ name: '同曲', singer: 'S', songmid: 'a1', source: 'kg' })
    const withImg = mi({ name: '同曲', singer: 'S', songmid: 'b1', source: 'wy', img: 'http://x/b.jpg' })
    const stats = mergePlayRows(
      [
        row({ musicInfoId: 1, songmid: 'kg-a1', playCount: 1, playedAt: new Date() }),
        row({ musicInfoId: 2, songmid: 'wy-b1', playCount: 1, playedAt: new Date() }),
      ],
      new Map([
        [1, noImg],
        [2, withImg],
      ]),
      new Map(),
    )
    expect(stats[0].mi).toBe(withImg)
    expect(stats[0].uid).toBe('wy-b1')
  })

  it('解析不到 MusicInfo 的行跳过（v1 语义）；空输入返回空数组', () => {
    const stats = mergePlayRows(
      [row({ musicInfoId: null, songmid: 'wy-ghost', playCount: 9, playedAt: new Date() })],
      new Map(),
      new Map(),
    )
    expect(stats).toEqual([])
    expect(mergePlayRows([], new Map(), new Map())).toEqual([])
  })

  it('按 totalPlays 降序，并列时最近播放在前', () => {
    const a = mi({ name: 'A', singer: 'S', songmid: 'a' })
    const b = mi({ name: 'B', singer: 'S', songmid: 'b' })
    const c = mi({ name: 'C', singer: 'S', songmid: 'c' })
    const t1 = new Date('2026-09-01T00:00:00Z')
    const t2 = new Date('2026-09-05T00:00:00Z')
    const stats = mergePlayRows(
      [
        row({ musicInfoId: 1, songmid: 'wy-a', playCount: 5, playedAt: t1 }),
        row({ musicInfoId: 2, songmid: 'wy-b', playCount: 5, playedAt: t2 }),
        row({ musicInfoId: 3, songmid: 'wy-c', playCount: 9, playedAt: t1 }),
      ],
      new Map([
        [1, a],
        [2, b],
        [3, c],
      ]),
      new Map(),
    )
    expect(stats.map(s => s.key)).toEqual([songIdentity(c), songIdentity(b), songIdentity(a)])
  })
})

describe('loadMusicInfoByIds / loadMusicInfoByUids', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('空入参不查库', async () => {
    expect((await loadMusicInfoByIds([])).size).toBe(0)
    expect((await loadMusicInfoByUids([])).size).toBe(0)
    expect(prisma.musicInfo.findMany).not.toHaveBeenCalled()
  })

  it('data 解析失败的行跳过；uid 键 = source-songmid', async () => {
    const good = mi({ name: '好歌', singer: 'G', songmid: 'g1' })
    prisma.musicInfo.findMany.mockResolvedValue([
      { id: 1, source: 'wy', songmid: 'g1', data: JSON.stringify(good) },
      { id: 2, source: 'wy', songmid: 'g2', data: 'not-json' },
    ])
    const byId = await loadMusicInfoByIds([1, 2])
    expect(byId.size).toBe(1)
    expect(byId.get(1)?.name).toBe('好歌')
    const byUid = await loadMusicInfoByUids(['wy-g1'])
    expect(byUid.get('wy-g1')?.name).toBe('好歌')
  })
})

describe('getUserSongPlays', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prisma.musicInfo.findMany.mockResolvedValue([])
  })

  it('id 解析 + songmid 兜底，返回合并后的歌曲级统计', async () => {
    const played = mi({ name: '常听', singer: 'P', songmid: 'p1' })
    const orphan = mi({ name: '孤儿', singer: 'O', songmid: 'o1', source: 'kg' })
    prisma.playHistory.findMany.mockResolvedValue([
      { id: 1, musicInfoId: 11, songmid: 'wy-p1', playCount: 2, playedAt: new Date('2026-09-01T00:00:00Z') },
      { id: 2, musicInfoId: null, songmid: 'kg-o1', playCount: 1, playedAt: new Date('2026-09-02T00:00:00Z') },
    ])
    prisma.musicInfo.findMany
      .mockResolvedValueOnce([{ id: 11, source: 'wy', songmid: 'p1', data: JSON.stringify(played) }])
      .mockResolvedValueOnce([{ source: 'kg', songmid: 'o1', data: JSON.stringify(orphan) }])

    const stats = await getUserSongPlays('stats-user')
    expect(stats).toHaveLength(2)
    expect(stats[0].totalPlays).toBe(2) // 按 totalPlays 降序
    // 第一次查询按 id，第二次是 orphan 行的 uid 兜底
    expect(prisma.musicInfo.findMany).toHaveBeenCalledTimes(2)
    expect(prisma.musicInfo.findMany.mock.calls[0][0].where).toEqual({ id: { in: [11] } })
    expect(prisma.musicInfo.findMany.mock.calls[1][0].where).toEqual({
      OR: [{ source: 'kg', songmid: 'o1' }],
    })
  })

  it('无历史时直接返回空数组，不触发 MusicInfo 查询', async () => {
    prisma.playHistory.findMany.mockResolvedValue([])
    expect(await getUserSongPlays('nobody')).toEqual([])
    expect(prisma.musicInfo.findMany).not.toHaveBeenCalled()
  })
})

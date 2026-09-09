import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStorageSongmidForMusicInfo, prisma } = vi.hoisted(() => ({
  getStorageSongmidForMusicInfo: vi.fn((mi: { songmid: string }) => mi.songmid),
  prisma: {
    musicInfo: { findMany: vi.fn() },
    playHistory: { findMany: vi.fn() },
    favorite: { findMany: vi.fn() },
    playlist: { findMany: vi.fn() },
    playlistEntry: { findMany: vi.fn() },
  },
}))

vi.mock('@/lib/db', () => ({ getStorageSongmidForMusicInfo, prisma }))
vi.mock('@/lib/search-config', () => ({ getSearchSources: vi.fn(() => ['tx', 'wy']) }))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const {
  splitSinger, hashSeed, mulberry32, dayKey, recencyDecay, songIdentity,
  rankCandidates, buildAffinityContext, guessYouLike, shuffle,
} = await import('./guess-service')

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

describe('splitSinger', () => {
  it('按顿号/逗号/分号/feat 拆分并去空格去重', () => {
    expect(splitSinger('周杰伦、费玉清')).toEqual(['周杰伦', '费玉清'])
    expect(splitSinger('A, B；C;D')).toEqual(['A', 'B', 'C', 'D'])
    expect(splitSinger('A feat. B')).toEqual(['A', 'B'])
    expect(splitSinger('A feat B')).toEqual(['A', 'B'])
    expect(splitSinger('A、A')).toEqual(['A'])
    expect(splitSinger('  A  、  B ')).toEqual(['A', 'B'])
  })

  it('不按斜杠拆分（保护 AC/DC 这类乐队名），空值返回空数组', () => {
    expect(splitSinger('AC/DC')).toEqual(['AC/DC'])
    expect(splitSinger(null)).toEqual([])
    expect(splitSinger('')).toEqual([])
    expect(splitSinger('、、')).toEqual([])
  })
})

describe('songIdentity', () => {
  it('忽略大小写/空格/分隔标点，跨音源副本得到同标识', () => {
    expect(songIdentity({ name: '恼人的秋风 (Live)', singer: '那英、肖战' }))
      .toBe(songIdentity({ name: '恼人的秋风(Live)', singer: '那英，肖战' }))
    expect(songIdentity({ name: 'A', singer: 'X' })).not.toBe(songIdentity({ name: 'A', singer: 'Y' }))
    expect(songIdentity({ name: 'A', singer: 'X' })).not.toBe(songIdentity({ name: 'B', singer: 'X' }))
  })
})

describe('mulberry32 / hashSeed / dayKey / recencyDecay', () => {
  it('同种子序列一致，不同种子序列不同', () => {
    const a1 = mulberry32(hashSeed('user:2026-09-08'))
    const a2 = mulberry32(hashSeed('user:2026-09-08'))
    const b = mulberry32(hashSeed('user:2026-09-09'))
    const s1 = [a1(), a1(), a1()]
    const s2 = [a2(), a2(), a2()]
    const s3 = [b(), b(), b()]
    expect(s1).toEqual(s2)
    expect(s1).not.toEqual(s3)
  })

  it('dayKey 用服务器本地时区', () => {
    expect(dayKey(new Date(2026, 8, 8, 23, 59, 59))).toBe('2026-09-08')
    expect(dayKey(new Date(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01')
  })

  it('recencyDecay：当天为 1，半衰期 14 天后约 0.5，未来时间按 0 天算', () => {
    const now = new Date(2026, 8, 8, 12, 0, 0)
    expect(recencyDecay(now, now)).toBeCloseTo(1)
    expect(recencyDecay(new Date(now.getTime() - 14 * 86_400_000), now)).toBeCloseTo(0.5, 5)
    expect(recencyDecay(new Date(now.getTime() + 86_400_000), now)).toBe(1)
  })
})

describe('shuffle', () => {
  it('同种子同序，不修改原数组', () => {
    const src = [1, 2, 3, 4, 5]
    const a = shuffle(src, mulberry32(42))
    const b = shuffle(src, mulberry32(42))
    expect(a).toEqual(b)
    expect(src).toEqual([1, 2, 3, 4, 5])
  })

  it('不同种子产生不同排列，但元素集合不变', () => {
    const src = Array.from({ length: 50 }, (_, i) => i)
    const a = shuffle(src, mulberry32(1))
    const b = shuffle(src, mulberry32(2))
    expect(a).not.toEqual(b)
    expect([...a].sort((x, y) => x - y)).toEqual(src)
    expect([...b].sort((x, y) => x - y)).toEqual(src)
  })
})

describe('rankCandidates', () => {
  const ctx = {
    artistAffinity: new Map([['周杰伦', 5], ['费玉清', 2], ['那英', 3], ['薛之谦', 4]]),
    albumAffinity: new Map([['范特西', 2]]),
    knownUids: new Set(['wy-known']),
    knownIdentities: new Set<string>(),
    personalized: true,
  }

  it('按亲和度排序，理由取亲和度最高的匹配歌手，无匹配的歌被丢弃', () => {
    const cands = [
      mi({ name: '双截棍', singer: '周杰伦', songmid: 'a' }),
      mi({ name: '千里之外', singer: '周杰伦、费玉清', songmid: 'b' }),
      mi({ name: '无关的歌', singer: '陌生人', songmid: 'c' }),
    ]
    const ranked = rankCandidates(cands, ctx, 'u1')
    // 千里之外匹配到 5+2=7 高于双截棍的 5（jitter 幅度 2 不足以逆转）
    expect(ranked[0].name).toBe('千里之外')
    expect(ranked[0].reason).toBe('因为你常听 周杰伦')
    expect(ranked[0].uid).toBe('wy-b')
    expect(ranked.map(s => s.name)).not.toContain('无关的歌')
  })

  it('剔除已知的歌；includePlayed 时不剔除', () => {
    const cands = [
      mi({ name: '历史里听过', singer: '周杰伦', songmid: 'known' }),
      mi({ name: '新歌', singer: '周杰伦', songmid: 'fresh' }),
    ]
    // 两首同亲和度，jitter 会打乱二者相对顺序，按集合断言
    expect(rankCandidates(cands, ctx, 'u1').map(s => s.name).sort()).toEqual(['新歌'])
    expect(rankCandidates(cands, ctx, 'u1', undefined, { includePlayed: true }).map(s => s.name).sort()).toEqual([
      '历史里听过', '新歌',
    ])
  })

  it('同一首歌多副本只保留一份，优先保留有封面的副本', () => {
    const cands = [
      mi({ name: '恼人的秋风', singer: '那英', songmid: 'kg-a' }),
      mi({ name: '恼人的秋风', singer: '那英', songmid: 'kg-b' }),
      mi({ name: '恼人的秋风', singer: '那英', songmid: 'c', source: 'wy', img: 'http://x/1.jpg' }),
    ]
    const ranked = rankCandidates(cands, ctx, 'u1')
    expect(ranked).toHaveLength(1)
    expect(ranked[0].uid).toBe('wy-c') // 有封面的副本胜出
  })

  it('听过某首歌后，其它音源的同一首也被剔除；includePlayed 时放开', () => {
    const played = mi({ name: '演员', singer: '薛之谦', songmid: 'wy-1' })
    const ctxWithKnown = {
      ...ctx,
      knownUids: new Set(['wy-1', 'kg-2']),
      knownIdentities: new Set([songIdentity(played)]),
    }
    const cands = [
      mi({ name: '演员', singer: '薛之谦', songmid: 'kg-2' }), // 另一音源的同一首
      mi({ name: '别的歌', singer: '薛之谦', songmid: 'kg-3' }),
    ]
    expect(rankCandidates(cands, ctxWithKnown, 'u1').map(s => s.name)).toEqual(['别的歌'])
    const incl = rankCandidates(cands, ctxWithKnown, 'u1', undefined, { includePlayed: true })
    expect(incl.map(s => s.name).sort()).toEqual(['别的歌', '演员'])
  })

  it('歌手多样性：高亲和歌手在前排最多 2 首，被卡的歌补在榜尾而不是丢弃', () => {
    // 甲(亲和5) 3 首 + 乙(亲和1) 1 首：分数差远超 jitter 幅度，
    // 顺序可预期 = [甲, 甲, 乙, 甲(被上限延后的那首)]
    const cands = [
      mi({ name: '甲一', singer: '甲', songmid: 'j1' }),
      mi({ name: '甲二', singer: '甲', songmid: 'j2' }),
      mi({ name: '甲三', singer: '甲', songmid: 'j3' }),
      mi({ name: '乙一', singer: '乙', songmid: 'y1' }),
    ]
    const artistCtx = {
      ...ctx,
      artistAffinity: new Map([['甲', 5], ['乙', 1]]),
    }
    const ranked = rankCandidates(cands, artistCtx, 'u1')
    expect(ranked).toHaveLength(4)
    expect(ranked.slice(0, 2).every(s => s.singer === '甲')).toBe(true)
    expect(ranked[2].singer).toBe('乙')
    expect(ranked[3].singer).toBe('甲')
    // 单歌手画像不再被截断到 2 首
    const onlyA = rankCandidates(['1', '2', '3'].map(n => mi({ name: `歌${n}`, singer: '甲', songmid: n })), artistCtx, 'u1')
    expect(onlyA).toHaveLength(3)
  })

  it('专辑加成参与排序', () => {
    const cands = [
      mi({ name: '别的专辑', singer: '周杰伦', songmid: 'x' }),
      mi({ name: '范特西同专', singer: '周杰伦', songmid: 'y', albumName: '范特西' }),
    ]
    // 专辑 +2，同样来自周杰伦，加成后应排前面
    const ranked = rankCandidates(cands, ctx, 'u1')
    expect(ranked[0].name).toBe('范特西同专')
  })

  it('同用户同日期结果可复现', () => {
    const cands = ['a', 'b', 'c', 'd', 'e'].map(n =>
      mi({ name: `歌-${n}`, singer: '周杰伦', songmid: n }),
    )
    const r1 = rankCandidates(cands, ctx, 'u1', '2026-09-08')
    const r2 = rankCandidates(cands, ctx, 'u1', '2026-09-08')
    expect(r1.map(s => s.uid)).toEqual(r2.map(s => s.uid))
  })
})

describe('buildAffinityContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prisma.musicInfo.findMany.mockResolvedValue([])
    prisma.playHistory.findMany.mockResolvedValue([])
    prisma.favorite.findMany.mockResolvedValue([])
    prisma.playlist.findMany.mockResolvedValue([])
  })

  it('播放/收藏/歌单三类信号加权，并收集 knownUids', async () => {
    const played = mi({ name: '常听的', singer: 'A、B', songmid: 'p1' })
    const fav = mi({ name: '收藏的', singer: 'C', songmid: 'f1', albumName: '专辑X' })
    const pl = mi({ name: '歌单里的', singer: 'D', songmid: 'pl1' })
    prisma.playHistory.findMany.mockResolvedValue([
      { id: 1, musicInfoId: 11, songmid: 'wy-p1', playCount: 3, playedAt: new Date() },
    ])
    prisma.musicInfo.findMany
      .mockResolvedValueOnce([{ id: 11, source: 'wy', songmid: 'p1', data: JSON.stringify(played) }])
      .mockResolvedValueOnce([{ source: 'wy', songmid: 'f1', data: JSON.stringify(fav) }])
      .mockResolvedValueOnce([{ id: 31, source: 'wy', songmid: 'pl1', data: JSON.stringify(pl) }])
    prisma.favorite.findMany.mockResolvedValue([{ itemId: 'wy-f1' }])
    prisma.playlist.findMany.mockResolvedValue([{ id: 100 }])
    prisma.playlistEntry.findMany.mockResolvedValue([{ id: 1, musicInfoId: 31, songmid: 'wy-pl1' }])

    const ctx = await buildAffinityContext('u1', 1)
    expect(ctx.personalized).toBe(true)
    // 播放 3 次、刚发生：ln(4) ≈ 1.386
    expect(ctx.artistAffinity.get('A')).toBeCloseTo(Math.log(4), 3)
    expect(ctx.artistAffinity.get('B')).toBeCloseTo(Math.log(4), 3)
    expect(ctx.artistAffinity.get('C')).toBe(5)
    expect(ctx.artistAffinity.get('D')).toBe(3)
    // knownUids：历史 songmid + 收藏 itemId + 歌单曲目（songmid 与推导 uid 两份）
    expect(ctx.knownUids).toEqual(new Set(['wy-p1', 'wy-f1', 'wy-pl1']))
    // 专辑亲和来自收藏
    expect(ctx.albumAffinity.get('专辑X')).toBe(2)
    // 跨副本已知歌标识同步收集
    expect(ctx.knownIdentities).toEqual(new Set([songIdentity(played), songIdentity(fav), songIdentity(pl)]))
  })

  it('无任何信号时 personalized=false', async () => {
    const ctx = await buildAffinityContext('nobody', 2)
    expect(ctx.personalized).toBe(false)
    expect(ctx.artistAffinity.size).toBe(0)
  })
})

describe('guessYouLike', () => {
  // 注意：服务模块内的每日缓存按 username 记忆，每个用例须用不同用户名避免串扰
  beforeEach(() => {
    vi.clearAllMocks()
    prisma.musicInfo.findMany.mockResolvedValue([])
    prisma.playHistory.findMany.mockResolvedValue([])
    prisma.favorite.findMany.mockResolvedValue([])
    prisma.playlist.findMany.mockResolvedValue([])
  })

  /** 兜底池查询路由：白名单查询 vs 全库补足查询（其余调用一律视为测试错误） */
  function mockFallbackPool(wlRows: unknown[], libRows: unknown[]) {
    prisma.musicInfo.findMany.mockImplementation(async (args?: {
      where?: { isRecommended?: boolean; id?: { notIn?: number[] } }
    }) => {
      if (args?.where?.isRecommended === true) return wlRows
      if (args?.where?.id?.notIn) return libRows
      throw new Error('意外的 musicInfo.findMany 调用')
    })
  }

  function rowOf(id: number, source: string, songmid: string, name: string) {
    return {
      id, source, songmid,
      data: JSON.stringify(mi({ source, name, singer: `歌手-${name}`, songmid })),
    }
  }

  it('冷启动兜底：白名单优先、全库补齐，当日刷新不变、翻页不重叠', async () => {
    // 模拟生产现状：白名单 20 首（全 wy 源），全库另有 90 首 tx
    const wlRows = Array.from({ length: 20 }, (_, i) => rowOf(i + 1, 'wy', `w${i}`, `白${i}`))
    const libRows = Array.from({ length: 90 }, (_, i) => rowOf(1000 + i, 'tx', `t${i}`, `库${i}`))
    mockFallbackPool(wlRows, libRows)

    const p1a = await guessYouLike('cold-user', 3, { size: 15, page: 1 })
    const p1b = await guessYouLike('cold-user', 3, { size: 15, page: 1 })
    const p2 = await guessYouLike('cold-user', 3, { size: 15, page: 2 })

    expect(p1a.personalized).toBe(false)
    expect(p1a.list).toHaveLength(15)
    expect(p1a.list[0].reason).toBe('为你随机推荐')
    expect(p1b.list).toEqual(p1a.list) // 同日刷新不变
    expect(p1b.personalized).toBe(false) // 缓存命中不丢失兜底标记
    expect(p2.list).toHaveLength(15)
    const uids1 = new Set(p1a.list.map(s => s.uid))
    expect(p2.list.every(s => !uids1.has(s.uid))).toBe(true) // 翻页不重叠
    // 白名单查询 + 全库补足查询各一次，之后全部走当日缓存
    expect(prisma.musicInfo.findMany).toHaveBeenCalledTimes(2)
    const topUp = prisma.musicInfo.findMany.mock.calls[1][0]
    expect(topUp.where.id.notIn).toEqual(wlRows.map(r => r.id))
    expect(topUp.take).toBe(80)
  })

  it('兜底池内同曲多副本只保留一份（优先有封面）', async () => {
    const wlRows = [
      rowOf(1, 'kg', 'k1', '重复歌'), // 无封面副本
      {
        id: 2, source: 'wy', songmid: 'w1',
        data: JSON.stringify(mi({ name: '重复歌', singer: '歌手-重复歌', songmid: 'w1', img: 'http://x/2.jpg' })),
      },
      rowOf(3, 'tx', 't1', '独立歌'),
    ]
    mockFallbackPool(wlRows, [])
    const r = await guessYouLike('dup-pool', 7, { size: 15 })
    expect(r.list.filter(s => s.name === '重复歌')).toHaveLength(1)
    expect(r.list.find(s => s.name === '重复歌')?.uid).toBe('wy-w1')
    expect(r.list.some(s => s.name === '独立歌')).toBe(true)
  })

  it('白名单已达池目标时不再查全库', async () => {
    const wlRows = Array.from({ length: 100 }, (_, i) => rowOf(i + 1, 'wy', `w${i}`, `白${i}`))
    mockFallbackPool(wlRows, [])
    const r = await guessYouLike('rich-wl', 5, { size: 15, page: 2 })
    expect(r.personalized).toBe(false)
    expect(r.list).toHaveLength(15)
    expect(prisma.musicInfo.findMany).toHaveBeenCalledTimes(1)
    expect(r.date).toBe(dayKey())
  })

  it('兜底池为空时返回空列表不抛错', async () => {
    mockFallbackPool([], [])
    const r = await guessYouLike('empty-lib', 6, { size: 15 })
    expect(r.personalized).toBe(false)
    expect(r.list).toEqual([])
  })

  it('有画像时召回排序并分页；同日第二次调用走缓存不再查库', async () => {
    const rows = ['1', '2', '3', '4', '5'].map(n => ({
      source: 'wy', songmid: n, data: JSON.stringify(mi({ name: `歌${n}`, singer: '歌手甲', songmid: n })),
    }))
    prisma.playHistory.findMany.mockResolvedValue([
      { id: 1, musicInfoId: 11, songmid: 'wy-h1', playCount: 2, playedAt: new Date() },
    ])
    // 第一次 findMany 是画像取历史歌曲详情，第二次是召回候选
    prisma.musicInfo.findMany
      .mockResolvedValueOnce([{ id: 11, source: 'wy', songmid: 'h1', data: JSON.stringify(mi({ name: '历史歌', singer: '歌手甲', songmid: 'h1' })) }])
      .mockResolvedValue(rows)

    const first = await guessYouLike('cached-user', 4, { size: 2, page: 1 })
    expect(first.personalized).toBe(true)
    expect(first.list).toHaveLength(2)
    expect(first.list[0].reason).toBe('因为你常听 歌手甲')

    const second = await guessYouLike('cached-user', 4, { size: 2, page: 2 })
    // 第二页取到剩下的歌，且未再触发 prisma 查询（走每日缓存）
    expect(second.list).toHaveLength(2)
    expect(second.list.map(s => s.name)).not.toEqual(first.list.map(s => s.name))
    expect(prisma.playHistory.findMany).toHaveBeenCalledTimes(1)
  })
})

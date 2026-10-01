/**
 * lib/services/history-service.ts 播放上报的单元测试
 *
 * 覆盖：库里已有完整行时绝不再 upsert（防被部分载荷覆薄）、kg 缺 hash 的上报
 * 纠正到 FileHash 兄弟行、库里没有时才建形，以及历史键与 musicInfoId 的落点。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { prisma, upsertMusicInfo, getStorageSongmidForMusicInfo } = vi.hoisted(() => ({
  prisma: {
    musicInfo: { findUnique: vi.fn(), findMany: vi.fn() },
    playHistory: { upsert: vi.fn(), count: vi.fn() },
  },
  upsertMusicInfo: vi.fn(async () => ({ action: 'insert' })),
  // 与 db.ts 的 getStorageSongmid 同构：kg 用 FileHash，其他源用原 songmid
  getStorageSongmidForMusicInfo: vi.fn((mi: { source: string; songmid: string; hash?: string }) =>
    mi.source === 'kg' && mi.hash ? String(mi.hash) : String(mi.songmid)),
}))

vi.mock('@/lib/db', () => ({ prisma, upsertMusicInfo, getStorageSongmidForMusicInfo }))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { reportPlay } = await import('./history-service')

import type { MusicInfo } from '@/lib/types/music'

/** 安卓壳 Api.reportPlay 的真实载荷形状：只有 7 个键，没有 types/hash */
function androidPayload(over: Partial<MusicInfo> & { name: string; singer: string; songmid: string }): MusicInfo {
  return {
    source: 'kg',
    interval: '245',
    ...over,
  } as MusicInfo
}

beforeEach(() => {
  vi.clearAllMocks()
  prisma.musicInfo.findUnique.mockResolvedValue(null)
  prisma.musicInfo.findMany.mockResolvedValue([])
  prisma.playHistory.upsert.mockResolvedValue({ id: 1 })
  prisma.playHistory.count.mockResolvedValue(0)
})

describe('reportPlay', () => {
  it('非 kg：库里已有完整行时不再 upsert，历史落到该行', async () => {
    prisma.musicInfo.findUnique.mockResolvedValue({ id: 77, songmid: '002tSryB4HyrPm' })
    await reportPlay('tiejiang', androidPayload({
      source: 'tx', name: '晴天', singer: '周杰伦', songmid: '002tSryB4HyrPm',
    }))
    expect(upsertMusicInfo).not.toHaveBeenCalled()
    expect(prisma.playHistory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { username_songmid: { username: 'tiejiang', songmid: 'tx-002tSryB4HyrPm' } },
        create: expect.objectContaining({ musicInfoId: 77 }),
      }),
    )
  })

  it('kg：缺 hash 的上报载荷优先纠正到 Audioid 相同的 FileHash 行（data 里 songmid 是数字也认）', async () => {
    prisma.musicInfo.findMany.mockResolvedValue([
      { id: 88, songmid: 'FILEHASH_OTHER', data: JSON.stringify({ songmid: 317191803 }) },
      // music-search.js 没做 String() 转换：kg 行里 songmid 可能是数字
      { id: 90, songmid: 'FILEHASH123', data: JSON.stringify({ songmid: 1083058434 }) },
    ])
    await reportPlay('tiejiang', androidPayload({
      source: 'kg', name: '勇气', singer: '梁静茹', songmid: '1083058434', albumName: '勇气',
    }))
    expect(upsertMusicInfo).not.toHaveBeenCalled()
    expect(prisma.musicInfo.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { source: 'kg', identity: '勇气|梁静茹', hash: { gt: '' } },
      }),
    )
    expect(prisma.playHistory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { username_songmid: { username: 'tiejiang', songmid: 'kg-FILEHASH123' } },
      }),
    )
  })

  it('kg：组内没有同 Audioid 副本时退到同款歌任意副本，仍不建薄行', async () => {
    prisma.musicInfo.findMany.mockResolvedValue([
      { id: 91, songmid: 'FILEHASH_OTHER', data: JSON.stringify({ songmid: 317191803 }) },
    ])
    await reportPlay('tiejiang', androidPayload({
      source: 'kg', name: '勇气', singer: '梁静茹', songmid: '9999999999', albumName: '勇气',
    }))
    expect(upsertMusicInfo).not.toHaveBeenCalled()
    expect(prisma.playHistory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { username_songmid: { username: 'tiejiang', songmid: 'kg-FILEHASH_OTHER' } },
      }),
    )
  })

  it('kg：上报载荷自带 hash 时直接命中 FileHash 行，不触发兄弟行查找', async () => {
    prisma.musicInfo.findUnique.mockResolvedValue({ id: 91, songmid: 'FILEHASH9' })
    await reportPlay('tiejiang', {
      ...androidPayload({ source: 'kg', name: '勇气', singer: '梁静茹', songmid: '1083058434' }),
      hash: 'FILEHASH9',
    })
    expect(prisma.musicInfo.findMany).not.toHaveBeenCalled()
    expect(upsertMusicInfo).not.toHaveBeenCalled()
  })

  it('库里确实没有这首歌：才用上报载荷建形，并以回读的行 id 关联历史', async () => {
    prisma.musicInfo.findUnique
      .mockResolvedValueOnce(null) // 建形前
      .mockResolvedValueOnce({ id: 99, songmid: '12345' }) // 建形后回读
    await reportPlay('tiejiang', androidPayload({
      source: 'kw', name: '新解析到的歌', singer: '某人', songmid: '12345',
    }))
    expect(upsertMusicInfo).toHaveBeenCalledTimes(1)
    expect(prisma.playHistory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ musicInfoId: 99, songmid: 'kw-12345' }),
      }),
    )
  })

  it('建形后回读仍为空（极端竞争）：历史照记，musicInfoId 留 null', async () => {
    await reportPlay('tiejiang', androidPayload({
      source: 'mg', name: '我的地盘', singer: '周杰伦', songmid: '6868',
    }))
    expect(upsertMusicInfo).toHaveBeenCalledTimes(1)
    expect(prisma.playHistory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ musicInfoId: null }) }),
    )
  })
})

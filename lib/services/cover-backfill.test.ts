/**
 * lib/services/cover-backfill.ts 单元测试
 *
 * 覆盖：候选扫描只针对 kw/kg/tx 且 img 为 NULL、成功回填同时写 img 列与 data JSON
 * （不动 checksum）、上游确认无封面标记空串、data 损坏行标记、解析异常行留给下一轮、
 * tx 模板 URL 可达性验证（kw 权威接口不验证）、limit 截断与游标分页、调度器幂等。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { prisma } = vi.hoisted(() => ({
  prisma: {
    musicInfo: { findMany: vi.fn(), update: vi.fn() },
  },
}))

vi.mock('@/lib/db', () => ({ prisma }))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { backfillMissingCovers, startCoverBackfillScheduler } = await import('./cover-backfill')

import type { MusicInfo } from '@/lib/types/music'

function mi(over: Partial<MusicInfo> & { name: string; singer: string; songmid: string }): MusicInfo {
  return {
    source: 'kw',
    interval: '200',
    types: [],
    _types: {} as MusicInfo['_types'],
    typeUrl: {},
    ...over,
  } as MusicInfo
}

function row(over: { id: number; source: string; data?: string | null }) {
  return { img: null, data: null, ...over }
}

/** 测试提速：去掉重试与批间等待 */
const fast = { retryDelayMs: 0, batchPauseMs: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  prisma.musicInfo.findMany.mockResolvedValue([])
  prisma.musicInfo.update.mockResolvedValue({})
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('hollymusic.coverBackfillScheduler')]
})

describe('backfillMissingCovers', () => {
  it('只扫 kw/kg/tx 且 img 为 NULL 的行，游标按 id 推进', async () => {
    await backfillMissingCovers(fast)
    expect(prisma.musicInfo.findMany).toHaveBeenCalledWith({
      where: { img: null, source: { in: ['kw', 'kg', 'tx'] }, id: { gt: 0 } },
      orderBy: { id: 'asc' },
      take: 200,
    })
  })

  it('成功回填：img 列与 data JSON 的 img 同步写，且不触碰 checksum', async () => {
    const info = mi({ name: '晴天', singer: '周杰伦', songmid: '228908' })
    prisma.musicInfo.findMany
      .mockResolvedValueOnce([row({ id: 7, source: 'kw', data: JSON.stringify(info) })])
      .mockResolvedValueOnce([])
    const resolvePic = vi.fn().mockResolvedValue('http://img1.kwcdn/x.jpg')

    const r = await backfillMissingCovers({ ...fast, resolvePic })
    expect(r).toEqual({ scanned: 1, updated: 1, markedEmpty: 0, failed: 0 })
    expect(prisma.musicInfo.update).toHaveBeenCalledTimes(1)
    const arg = prisma.musicInfo.update.mock.calls[0][0]
    expect(arg.where).toEqual({ id: 7 })
    expect(arg.data.img).toBe('http://img1.kwcdn/x.jpg')
    const parsed = JSON.parse(arg.data.data)
    expect(parsed.img).toBe('http://img1.kwcdn/x.jpg')
    expect(parsed.songmid).toBe('228908')
    expect(Object.keys(arg.data)).not.toContain('checksum')
  })

  it('上游确认无封面（两次 null）：标记空串退出候选集', async () => {
    prisma.musicInfo.findMany
      .mockResolvedValueOnce([row({ id: 8, source: 'kw', data: JSON.stringify(mi({ name: 'x', singer: 'y', songmid: '1' })) })])
      .mockResolvedValueOnce([])
    const resolvePic = vi.fn().mockResolvedValue(null)

    const r = await backfillMissingCovers({ ...fast, resolvePic })
    expect(resolvePic).toHaveBeenCalledTimes(2)
    expect(r.markedEmpty).toBe(1)
    const arg = prisma.musicInfo.update.mock.calls[0][0]
    expect(arg.data).toEqual({ img: '' })
  })

  it('data JSON 损坏的行直接标记（确定性失败，不进重试循环）', async () => {
    prisma.musicInfo.findMany
      .mockResolvedValueOnce([row({ id: 9, source: 'kg', data: '{oops' })])
      .mockResolvedValueOnce([])
    const resolvePic = vi.fn()

    const r = await backfillMissingCovers({ ...fast, resolvePic })
    expect(resolvePic).not.toHaveBeenCalled()
    expect(r.markedEmpty).toBe(1)
    expect(prisma.musicInfo.update).toHaveBeenCalledWith({ where: { id: 9 }, data: { img: '' } })
  })

  it('解析器抛异常的行留给下一轮（不写库）', async () => {
    prisma.musicInfo.findMany
      .mockResolvedValueOnce([row({ id: 10, source: 'kw', data: JSON.stringify(mi({ name: 'x', singer: 'y', songmid: '1' })) })])
      .mockResolvedValueOnce([])
    const resolvePic = vi.fn().mockRejectedValue(new Error('boom'))

    const r = await backfillMissingCovers({ ...fast, resolvePic })
    expect(r.failed).toBe(1)
    expect(r.markedEmpty).toBe(0)
    expect(prisma.musicInfo.update).not.toHaveBeenCalled()
  })

  it('tx 模板 URL 需可达性验证：404 标记空串，image 响应才回填', async () => {
    const info = mi({ name: 'x', singer: 'y', songmid: 'm1', source: 'tx', albumMid: 'ALMID' })
    const url = 'https://y.gtimg.cn/music/photo_new/T002R500x500M000ALMID.jpg'

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, headers: new Headers(), body: null })
    )
    prisma.musicInfo.findMany
      .mockResolvedValueOnce([row({ id: 11, source: 'tx', data: JSON.stringify(info) })])
      .mockResolvedValueOnce([])
    const resolvePic = vi.fn().mockResolvedValue(url)
    const r1 = await backfillMissingCovers({ ...fast, resolvePic })
    expect(r1.markedEmpty).toBe(1)

    vi.clearAllMocks()
    prisma.musicInfo.findMany
      .mockResolvedValueOnce([row({ id: 11, source: 'tx', data: JSON.stringify(info) })])
      .mockResolvedValueOnce([])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'content-type': 'image/jpeg' }), body: { cancel: vi.fn() } })
    )
    const r2 = await backfillMissingCovers({ ...fast, resolvePic })
    expect(r2.updated).toBe(1)
    vi.unstubAllGlobals()
  })

  it('kw 权威接口返回的 URL 不做验证直接入库', async () => {
    prisma.musicInfo.findMany
      .mockResolvedValueOnce([row({ id: 12, source: 'kw', data: JSON.stringify(mi({ name: 'x', singer: 'y', songmid: '2' })) })])
      .mockResolvedValueOnce([])
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const r = await backfillMissingCovers({
      ...fast,
      resolvePic: vi.fn().mockResolvedValue('http://img1.kwcdn/a.jpg'),
    })
    expect(r.updated).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('limit 截断：只处理截断内的行', async () => {
    prisma.musicInfo.findMany
      .mockResolvedValueOnce([row({ id: 1, source: 'kw', data: null }), row({ id: 2, source: 'kg', data: null })])
      .mockResolvedValueOnce([])
    const resolvePic = vi.fn().mockResolvedValue(null)

    const r = await backfillMissingCovers({ ...fast, limit: 1, resolvePic })
    expect(r.scanned).toBe(1)
    expect(prisma.musicInfo.update).toHaveBeenCalledTimes(1)
    expect(prisma.musicInfo.findMany).toHaveBeenCalledTimes(1)
  })

  it('候选耗尽即结束，不空转轮询', async () => {
    prisma.musicInfo.findMany.mockResolvedValue([])
    const r = await backfillMissingCovers(fast)
    expect(r.scanned).toBe(0)
    expect(prisma.musicInfo.findMany).toHaveBeenCalledTimes(1)
  })
})

describe('startCoverBackfillScheduler', () => {
  it('启动 15s 后首轮、此后每 6h 一轮；重复调用不叠加定时器', async () => {
    vi.useFakeTimers()
    try {
      startCoverBackfillScheduler()
      startCoverBackfillScheduler()
      expect(prisma.musicInfo.findMany).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(15_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(prisma.musicInfo.findMany).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
      await vi.advanceTimersByTimeAsync(0)
      expect(prisma.musicInfo.findMany).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

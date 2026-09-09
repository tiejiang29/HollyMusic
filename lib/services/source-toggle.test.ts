/**
 * lib/services/source-toggle.ts 换源服务测试
 *
 * 重点验证 identity 分组带来的本地优先路径：
 * - 库内已有同款歌副本 → 直接返回（origin=local），不发起上游搜索
 * - 库内无副本 → 回退上游搜索（origin=upstream）
 * - forceUpstream → 跳过库内查询，强制上游搜索
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const findManyMock = vi.fn()
const searchMock = vi.fn(async () => ({ list: [] }))

vi.mock('@/lib/db', () => ({
  prisma: {
    musicInfo: {
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}))
vi.mock('@/lib/music-core/music-search', () => ({
  search: (...args: unknown[]) => searchMock(...args),
}))
vi.mock('@/lib/search-config', () => ({
  getSearchSources: vi.fn(async () => []),
}))

const { findAlternatives } = await import('./source-toggle')

function mi(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: '晴天',
    singer: '周杰伦',
    source: 'kw',
    songmid: 'kw-1',
    interval: '04:29',
    types: [],
    _types: {},
    typeUrl: {},
    ...overrides,
  } as Parameters<typeof findAlternatives>[0]
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    source: 'wy',
    songmid: 'wy-1',
    data: JSON.stringify(mi({ source: 'wy', songmid: 'wy-1' })),
    ...overrides,
  }
}

describe('findAlternatives 本地优先', () => {
  beforeEach(() => {
    findManyMock.mockReset()
    searchMock.mockClear()
  })

  it('库内有同 identity 的其它平台副本时直接返回，不发起上游搜索', async () => {
    findManyMock.mockResolvedValue([
      row(),
      row({ source: 'tx', songmid: 'tx-1', data: JSON.stringify(mi({ source: 'tx', songmid: 'tx-1' })) }),
    ])
    const { candidates, origin } = await findAlternatives(mi())
    expect(findManyMock).toHaveBeenCalledTimes(1)
    expect(searchMock).not.toHaveBeenCalled()
    expect(origin).toBe('local')
    expect(candidates.map(c => c.source)).toEqual(['wy', 'tx'])
    expect(candidates[0].musicInfo.name).toBe('晴天')
  })

  it('库内无副本时回退上游搜索', async () => {
    findManyMock.mockResolvedValue([])
    const { candidates, origin } = await findAlternatives(mi())
    expect(findManyMock).toHaveBeenCalledTimes(1)
    expect(searchMock).toHaveBeenCalled()
    expect(origin).toBe('upstream')
    expect(candidates).toEqual([])
  })

  it('forceUpstream 时跳过库内查询，强制走上游搜索', async () => {
    findManyMock.mockResolvedValue([row()]) // 库里其实有副本，也应被跳过
    const { candidates, origin } = await findAlternatives(mi(), { forceUpstream: true })
    expect(findManyMock).not.toHaveBeenCalled()
    expect(searchMock).toHaveBeenCalled()
    expect(origin).toBe('upstream')
    expect(candidates).toEqual([])
  })

  it('上游搜索到候选时 origin 为 upstream', async () => {
    findManyMock.mockResolvedValue([])
    searchMock.mockResolvedValueOnce({
      list: [mi({ source: 'wy', songmid: 'wy-9' })],
    })
    const { candidates, origin } = await findAlternatives(mi())
    expect(origin).toBe('upstream')
    expect(candidates.map(c => c.source)).toEqual(['wy'])
    expect(candidates[0].intervalMatched).toBe(true)
  })

  it('限定启用音源：当前源不在启用列表时查询对应子集', async () => {
    const { getSearchSources } = await import('@/lib/search-config')
    ;(getSearchSources as ReturnType<typeof vi.fn>).mockResolvedValue(['wy', 'kw'])
    findManyMock.mockResolvedValue([row()])
    await findAlternatives(mi()) // 当前源 kw，启用 wy/kw → 查询限定 wy
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ source: { in: ['wy'] } }),
      })
    )
    ;(getSearchSources as ReturnType<typeof vi.fn>).mockResolvedValue([])
  })

  it('无歌名的请求直接返回空，不查库不搜上游', async () => {
    const { candidates } = await findAlternatives(mi({ name: '' }))
    expect(candidates).toEqual([])
    expect(findManyMock).not.toHaveBeenCalled()
    expect(searchMock).not.toHaveBeenCalled()
  })
})

/**
 * app/api/admin/music-info/import/route.ts 集成测试
 *
 * 通过 vi.mock 隔离 requireAdmin / lib/db，不触达真实 DB。
 * 重点覆盖：计数映射（action=insert → inserted）、非法条目跳过、
 * 500 上限、recommend 的 uid 生成（kg 用 hash 作存储键）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// --- mock 鉴权 ---------------------------------------------------------------

type AuthMode = 'ok' | 'unauth' | 'forbidden'

let authMode: AuthMode = 'ok'

class MockAuthError extends Error {
  constructor(message = '未登录') {
    super(message)
    this.name = 'AuthError'
  }
}
class MockForbiddenError extends Error {
  constructor(message = '无权限') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

vi.mock('@/lib/services/user-context', () => ({
  requireAdmin: vi.fn(async () => {
    if (authMode === 'unauth') throw new MockAuthError('未登录')
    if (authMode === 'forbidden') throw new MockForbiddenError('需要管理员权限')
    return { username: 'admin' }
  }),
  AuthError: MockAuthError,
  ForbiddenError: MockForbiddenError,
}))

// --- mock lib/db -------------------------------------------------------------

const upsertMock = vi.fn()
const setRecommendedBatchMock = vi.fn()

vi.mock('@/lib/db', () => ({
  upsertMusicInfosInTransaction: (...args: unknown[]) => upsertMock(...args),
  setRecommendedBatch: (...args: unknown[]) => setRecommendedBatchMock(...args),
  // 与真实实现语义一致：kg 用 hash，其他源用 songmid（lib/db.ts getStorageSongmid）
  getStorageSongmidForMusicInfo: (mi: { source: string; songmid: string; hash?: string }) =>
    mi.source === 'kg' && mi.hash ? mi.hash : mi.songmid,
}))

// --- 辅助 -------------------------------------------------------------------

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/music-info/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: '测试歌',
    singer: '测试歌手',
    source: 'wy',
    songmid: 'mid-1',
    interval: '200',
    types: [],
    _types: {},
    typeUrl: {},
    ...overrides,
  }
}

// 延迟导入，确保 vi.mock 先生效
const { POST } = await import('./route')

// ===========================================================================

describe('POST /api/admin/music-info/import', () => {
  beforeEach(() => {
    authMode = 'ok'
    upsertMock.mockReset()
    setRecommendedBatchMock.mockReset()
  })

  it('未登录 → 401，不触达 DB', async () => {
    authMode = 'unauth'
    const res = await POST(makePostRequest({ items: [makeItem()] }))
    expect(res.status).toBe(401)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('非管理员 → 403', async () => {
    authMode = 'forbidden'
    const res = await POST(makePostRequest({ items: [makeItem()] }))
    expect(res.status).toBe(403)
  })

  it('合法条目 → upsert 计数正确映射（insert → inserted）', async () => {
    upsertMock.mockResolvedValue([
      { action: 'insert' },
      { action: 'insert' },
      { action: 'update' },
      { action: 'noop' },
    ])
    const res = await POST(makePostRequest({ items: [makeItem(), makeItem(), makeItem(), makeItem()] }))
    expect(res.status).toBe(200)
    const data = await res.json().then((j) => j.data)
    expect(data).toMatchObject({ received: 4, skipped: 0, inserted: 2, updated: 1, noop: 1, recommended: 0 })
    expect(upsertMock).toHaveBeenCalledTimes(1)
  })

  it('非法条目跳过不拖垮整批：缺 songmid / 非法 source / 非对象', async () => {
    upsertMock.mockResolvedValue([{ action: 'insert' }])
    const res = await POST(
      makePostRequest({
        items: [
          makeItem({ songmid: 'ok-1', name: '好条目' }),
          makeItem({ songmid: '', name: '缺songmid' }),
          makeItem({ source: 'spotify', songmid: 'x', name: '非法源' }),
          null,
          makeItem({ name: '', songmid: 'y', name2: '空名' }),
        ],
      }),
    )
    expect(res.status).toBe(200)
    const data = await res.json().then((j) => j.data)
    expect(data).toMatchObject({ received: 5, skipped: 4, inserted: 1 })
    // 只有合法条目进 upsert
    expect(upsertMock.mock.calls[0][0]).toHaveLength(1)
    expect(upsertMock.mock.calls[0][0][0].songmid).toBe('ok-1')
  })

  it('items 为空数组 / 缺 items → 400', async () => {
    const r1 = await POST(makePostRequest({ items: [] }))
    expect(r1.status).toBe(400)
    const r2 = await POST(makePostRequest({}))
    expect(r2.status).toBe(400)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('全部条目非法 → 400', async () => {
    const res = await POST(makePostRequest({ items: [{ name: '缺songmid', source: 'wy' }] }))
    expect(res.status).toBe(400)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('超过 500 条上限 → 400 且不写库', async () => {
    const items = Array.from({ length: 501 }, (_, i) => makeItem({ songmid: `mid-${i}` }))
    const res = await POST(makePostRequest({ items }))
    expect(res.status).toBe(400)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('recommend=true → uid 按存储键生成（kg 用 hash），计数返回 recommended', async () => {
    upsertMock.mockResolvedValue([{ action: 'insert' }, { action: 'insert' }])
    setRecommendedBatchMock.mockResolvedValue({ updated: 2 })
    const res = await POST(
      makePostRequest({
        items: [
          makeItem({ source: 'wy', songmid: 'wy-1' }),
          makeItem({ source: 'kg', songmid: 'audio-9', hash: 'hash-9' }),
        ],
        recommend: true,
      }),
    )
    expect(res.status).toBe(200)
    const data = await res.json().then((j) => j.data)
    expect(data.recommended).toBe(2)
    // uid = `${source}-${存储songmid}`，kg 的存储键是 hash
    expect(setRecommendedBatchMock).toHaveBeenCalledWith(['wy-wy-1', 'kg-hash-9'], true)
  })

  it('upsert 抛错 → 500', async () => {
    upsertMock.mockRejectedValue(new Error('transaction timeout'))
    const res = await POST(makePostRequest({ items: [makeItem()] }))
    expect(res.status).toBe(500)
  })
})

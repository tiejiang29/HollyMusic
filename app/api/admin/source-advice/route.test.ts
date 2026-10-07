/**
 * 周测建议路由：鉴权 + "固化只交 id" + 撤销。
 * 判据本身在 `source-advice.test.ts` 里钉，这里只管 HTTP 契约。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

class MockAuthError extends Error {}
class MockForbiddenError extends Error {}

vi.mock('@/lib/services/user-context', () => ({
  requireAdmin: vi.fn(async (request: NextRequest) => {
    const mode = request.headers.get('x-test-auth')
    if (mode === 'anonymous') throw new MockAuthError('未登录')
    if (mode === 'user') throw new MockForbiddenError('需要管理员')
    return { id: 1 }
  }),
  AuthError: MockAuthError,
  ForbiddenError: MockForbiddenError,
}))

const { buildAdviceMock, applyMock, undoMock } = vi.hoisted(() => ({
  buildAdviceMock: vi.fn(async () => ({
    suggestions: [{ id: 'add-pt:a:kg', kind: 'add-pt', path: 'a', source: '甲', platform: 'kg', action: '把 酷狗 加回支持平台', evidence: '2/2 出货' }],
    batchesUsed: 2, lastRunAt: '2026-10-07T00:00:00.000Z', canUndo: false,
  })),
  applyMock: vi.fn(async () => ({ applied: 1, changed: 1 })),
  undoMock: vi.fn(async () => ({ restored: true })),
}))

vi.mock('@/lib/services/source-advice', () => ({
  buildAdvice: buildAdviceMock,
  applyAdvice: applyMock,
  undoAdvice: undoMock,
}))

const { GET, POST } = await import('./route')

function request(method: string, body?: unknown, auth = 'admin'): NextRequest {
  return new NextRequest(new URL('http://localhost/api/admin/source-advice'), {
    method,
    headers: { 'x-test-auth': auth },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeEach(() => {
  buildAdviceMock.mockClear()
  applyMock.mockClear()
  undoMock.mockClear()
})

describe('鉴权', () => {
  it('未登录 401、非管理员 403，两个方法都一样', async () => {
    for (const mode of ['anonymous', 'user'] as const) {
      const expected = mode === 'anonymous' ? 401 : 403
      expect((await GET(request('GET', undefined, mode))).status).toBe(expected)
      expect((await POST(request('POST', { action: 'apply', ids: ['x'] }, mode))).status).toBe(expected)
    }
  })
})

describe('GET', () => {
  it('原样带回建议与"能不能撤销"', async () => {
    const res = await GET(request('GET'))
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data.batchesUsed).toBe(2)
    expect(data.suggestions).toHaveLength(1)
    expect(buildAdviceMock).toHaveBeenCalledTimes(1)
  })
})

describe('POST', () => {
  it('apply 只把 id 交给服务层，值由服务端重算', async () => {
    const res = await POST(request('POST', { action: 'apply', ids: ['add-pt:a:kg', 42, 'drop-pt:b:tx'] }))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ applied: 1, changed: 1 })
    expect(applyMock).toHaveBeenCalledWith(['add-pt:a:kg', 'drop-pt:b:tx'])
  })

  it('一条都没勾 ⇒ 400，不掉到服务层去写配置', async () => {
    for (const body of [{ action: 'apply' }, { action: 'apply', ids: [] }, { action: 'apply', ids: [7, null] }]) {
      const res = await POST(request('POST', body))
      expect(res.status).toBe(400)
    }
    expect(applyMock).not.toHaveBeenCalled()
  })

  it('undo 透传结果；未知 action 400', async () => {
    const res = await POST(request('POST', { action: 'undo' }))
    expect((await res.json()).data).toEqual({ restored: true })
    expect((await POST(request('POST', { action: 'nope' }))).status).toBe(400)
  })
})

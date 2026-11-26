import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let authMode: 'admin' | 'user' | 'anonymous' = 'admin'
class MockAuthError extends Error {}
class MockForbiddenError extends Error {}

vi.mock('@/lib/services/user-context', () => ({
  requireAdmin: vi.fn(async () => {
    if (authMode === 'anonymous') throw new MockAuthError('未登录')
    if (authMode === 'user') throw new MockForbiddenError('需要管理员权限')
    return { username: 'admin' }
  }),
  AuthError: MockAuthError,
  ForbiddenError: MockForbiddenError,
}))

const { getApiCatalog, setApiInterfaceSelection } = vi.hoisted(() => ({
  getApiCatalog: vi.fn(),
  setApiInterfaceSelection: vi.fn(),
}))
vi.mock('@/lib/services/api-catalog', () => ({ getApiCatalog, setApiInterfaceSelection }))

const { GET, PUT } = await import('./route')
const id = 'a'.repeat(24)
const view = { interfaces: [], duplicateGroups: [] }

function request(method: string, body?: unknown) {
  return new NextRequest('http://localhost/api/admin/api-catalog', {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeEach(() => {
  authMode = 'admin'
  getApiCatalog.mockReset().mockResolvedValue(view)
  setApiInterfaceSelection.mockReset().mockResolvedValue(2)
})

describe('接口目录管理 API', () => {
  it('未登录 401、非管理员 403', async () => {
    authMode = 'anonymous'
    expect((await GET(request('GET'))).status).toBe(401)
    expect((await PUT(request('PUT', { updates: [{ id, enabled: true }] }))).status).toBe(401)
    authMode = 'user'
    expect((await GET(request('GET'))).status).toBe(403)
    expect(setApiInterfaceSelection).not.toHaveBeenCalled()
  })

  it('GET 返回持久化目录与重复组', async () => {
    const payload = await (await GET(request('GET'))).json()
    expect(payload.data).toEqual(view)
  })

  it('PUT 按启用状态分组批量保存并返回新目录', async () => {
    const response = await PUT(request('PUT', {
      updates: [{ id, enabled: false }, { id: 'b'.repeat(24), enabled: true }],
    }))
    expect(response.status).toBe(200)
    expect(setApiInterfaceSelection).toHaveBeenCalledTimes(1)
    expect(setApiInterfaceSelection).toHaveBeenCalledWith([{ id, enabled: false }, { id: 'b'.repeat(24), enabled: true }])
    expect((await response.json()).data).toEqual({ ...view, updated: 2 })
  })

  it('空批次、超量、非法 ID 或状态均拒绝，不写库', async () => {
    for (const updates of [
      [],
      Array.from({ length: 501 }, () => ({ id, enabled: true })),
      [{ id: 'bad', enabled: true }],
      [{ id, enabled: 'yes' }],
      [null],
    ]) {
      expect((await PUT(request('PUT', { updates }))).status).toBe(400)
    }
    expect(setApiInterfaceSelection).not.toHaveBeenCalled()
  })
})

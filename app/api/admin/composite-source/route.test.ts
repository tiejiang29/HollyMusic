import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let authMode: 'admin' | 'user' | 'anonymous' = 'admin'

class MockAuthError extends Error {
  constructor(message = '未登录') { super(message); this.name = 'AuthError' }
}
class MockForbiddenError extends Error {
  constructor(message = '需要管理员') { super(message); this.name = 'ForbiddenError' }
}
class MockCompositeError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = 'CompositeSourceError' }
}

vi.mock('@/lib/services/user-context', () => ({
  requireAdmin: vi.fn(async () => {
    if (authMode === 'anonymous') throw new MockAuthError('未登录')
    if (authMode === 'user') throw new MockForbiddenError('需要管理员权限')
    return { username: 'admin' }
  }),
  AuthError: MockAuthError,
  ForbiddenError: MockForbiddenError,
}))

const { getCompositeView, saveCompositeSettings } = vi.hoisted(() => ({
  getCompositeView: vi.fn(),
  saveCompositeSettings: vi.fn(),
}))

vi.mock('@/lib/services/composite-source', () => ({
  getCompositeView,
  saveCompositeSettings,
  CompositeSourceError: MockCompositeError,
}))

const { GET, PUT } = await import('./route')

const settings = {
  enabled: false,
  members: [],
  width: 1,
  holdMs: 2_000,
  resolveMs: 8_000,
  headerMs: 3_000,
  chainMs: 12_000,
}

function request(method: string, body?: unknown): NextRequest {
  return new NextRequest(new URL('http://localhost/api/admin/composite-source'), {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeEach(() => {
  authMode = 'admin'
  getCompositeView.mockReset().mockResolvedValue({ settings, lanes: [] })
  saveCompositeSettings.mockReset().mockResolvedValue(settings)
})

describe('复合源管理 API', () => {
  it('未登录 401、非管理员 403，读写一致', async () => {
    authMode = 'anonymous'
    expect((await GET(request('GET'))).status).toBe(401)
    expect((await PUT(request('PUT', settings))).status).toBe(401)
    authMode = 'user'
    expect((await GET(request('GET'))).status).toBe(403)
    expect((await PUT(request('PUT', settings))).status).toBe(403)
    expect(saveCompositeSettings).not.toHaveBeenCalled()
  })

  it('GET 返回设置与 lane 视图，不附带原始 key 字段', async () => {
    const payload = await (await GET(request('GET'))).json()
    expect(payload.data.settings).toEqual(settings)
    expect(payload.data.lanes).toEqual([])
  })

  it('PUT 归一化后的配置由服务层保存，响应使用刚保存的视图', async () => {
    const input = { ...settings, enabled: true, width: 6, members: [{ sourceName: '源A', platform: 'tx' }] }
    const saved = { ...input }
    getCompositeView.mockResolvedValue({ settings: saved, lanes: [] })
    saveCompositeSettings.mockResolvedValue(saved)

    const response = await PUT(request('PUT', input))
    expect(response.status).toBe(200)
    expect(saveCompositeSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, width: 6 }))
    expect(getCompositeView).toHaveBeenCalledWith(saved)
    expect((await response.json()).data.settings.enabled).toBe(true)
  })

  it('服务层参数错误透出 400，不压成 500', async () => {
    saveCompositeSettings.mockRejectedValue(new MockCompositeError('启用复合源前至少添加一个音源成员'))
    const response = await PUT(request('PUT', { enabled: true, members: [] }))
    expect(response.status).toBe(400)
    expect((await response.json()).error.message).toContain('至少添加一个')
  })
})

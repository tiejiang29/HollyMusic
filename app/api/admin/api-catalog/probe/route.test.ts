import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let authMode: 'admin' | 'user' | 'anonymous' = 'admin'
class MockAuthError extends Error {}
class MockForbiddenError extends Error {}
class MockProbeError extends Error {
  constructor(message: string, public readonly status = 400) { super(message) }
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
const { probeApiInterface, pickProbeSamples } = vi.hoisted(() => ({ probeApiInterface: vi.fn(), pickProbeSamples: vi.fn() }))
vi.mock('@/lib/services/api-interface-probe', () => ({ ApiInterfaceProbeError: MockProbeError, probeApiInterface }))
vi.mock('@/lib/services/source-probe', () => ({ pickProbeSamples }))

const { GET, POST } = await import('./route')
const id = 'a'.repeat(24)
function request(body?: unknown) {
  return new NextRequest('http://localhost/api/admin/api-catalog/probe', { method: 'POST', body: JSON.stringify(body || {}) })
}

beforeEach(() => {
  authMode = 'admin'
  probeApiInterface.mockReset().mockResolvedValue({ id: 'probe-1', outcome: 'ok' })
  pickProbeSamples.mockReset().mockResolvedValue({ tx: [{ source: 'tx', songmid: 'sample-1' }] })
})

describe('单接口测试 API', () => {
  it('未登录 401、非管理员 403', async () => {
    authMode = 'anonymous'
    expect((await POST(request({ interfaceId: id, source: '源A' }))).status).toBe(401)
    authMode = 'user'
    expect((await POST(request({ interfaceId: id, source: '源A' }))).status).toBe(403)
    expect(probeApiInterface).not.toHaveBeenCalled()
  })

  it('GET 返回每平台两首可选基准样本', async () => {
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(pickProbeSamples).toHaveBeenCalledWith(2)
    expect((await response.json()).data.samples.tx[0].songmid).toBe('sample-1')
  })

  it('参数不合法时不启动外部请求', async () => {
    for (const body of [
      {},
      { interfaceId: 'bad', source: '源A' },
      { interfaceId: id, source: '' },
      { interfaceId: id, source: '源A', quality: 'bad' },
      { interfaceId: id, source: '源A', musicInfo: { source: 'tx' } },
    ]) expect((await POST(request(body))).status).toBe(400)
    expect(probeApiInterface).not.toHaveBeenCalled()
  })

  it('默认 320k，支持显式样本，返回落库结果', async () => {
    const musicInfo = { source: 'tx', songmid: 'song-1' }
    const response = await POST(request({ interfaceId: id, source: '源A', quality: 'flac', musicInfo }))
    expect(response.status).toBe(200)
    expect(probeApiInterface).toHaveBeenCalledWith({ interfaceId: id, source: '源A', quality: 'flac', musicInfo })
    expect((await response.json()).data.outcome).toBe('ok')
  })

  it('并发冲突透出 409', async () => {
    probeApiInterface.mockRejectedValue(new MockProbeError('已有一轮单接口测试在运行', 409))
    const response = await POST(request({ interfaceId: id, source: '源A' }))
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('PROBE_RUNNING')
  })
})

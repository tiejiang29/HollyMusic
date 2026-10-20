/**
 * `/api/discover/playlists` 的 HTTP 契约（判据本身在 discovery-service.test.ts 里钉）：
 * - 未登录 401；
 * - `keyword` ⇒ 400 `UNSUPPORTED_FILTER`（五源都不吃关键词，不能再静默返回同一批）；
 * - 该源不支持的档位 ⇒ **降级成 recommend**，而不是报错 —— 已经装在用户手机上的旧包还会发"最新"，
 *   把一个本来能用的列表变成 400 是拿可用性换一个说法，不划算；少显示档位由 capabilities 收敛。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

class MockAuthError extends Error {}

vi.mock('@/lib/services/user-context', () => ({
  requireUser: vi.fn(async (request: NextRequest) => {
    if (request.headers.get('x-test-auth') === 'anonymous') throw new MockAuthError('未登录')
    return { id: 1, username: 'tester' }
  }),
  AuthError: MockAuthError,
}))

const listMock = vi.fn()
vi.mock('@/lib/services/discovery-service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getRecommendedPlaylists: (...args: unknown[]) => listMock(...args) }
})

const { GET } = await import('./route')
const mod = await import('@/lib/services/discovery-service')

const req = (qs: string, auth = 'user') =>
  new NextRequest(`http://local/api/discover/playlists${qs}`, { headers: { 'x-test-auth': auth } })

beforeEach(() => {
  listMock.mockReset()
  listMock.mockResolvedValue([])
})

describe('GET /api/discover/playlists', () => {
  it('未登录 401，且不取数', async () => {
    const res = await GET(req('?source=tx', 'anonymous'))
    expect(res.status).toBe(401)
    expect(listMock).not.toHaveBeenCalled()
  })

  it('带 keyword ⇒ 400 UNSUPPORTED_FILTER，把"搜了没反应"变成看得见的错误', async () => {
    listMock.mockRejectedValue(new mod.UnsupportedPlaylistFilterError('keyword'))
    const res = await GET(req('?source=tx&keyword=%E5%91%A8%E6%9D%B0%E4%BC%A6'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('UNSUPPORTED_FILTER')
  })

  it('该源不支持的档位降级成 recommend（mg 完全不读 sort）', async () => {
    await GET(req('?source=mg&sort=new'))
    expect(listMock.mock.calls[0][3]).toMatchObject({ sort: 'recommend' })
  })

  it('支持的档位照传（tx 的 new 是真档位了）', async () => {
    await GET(req('?source=tx&sort=new'))
    expect(listMock.mock.calls[0][3]).toMatchObject({ sort: 'new' })
  })

  it('非法渠道 400', async () => {
    const res = await GET(req('?source=apple'))
    expect(res.status).toBe(400)
  })
})

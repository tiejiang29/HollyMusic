/**
 * `/api/discover/playlists/capabilities`：把"这个源有哪些档位"交给服务端声明。
 * 钉的是数据本身（实测结论），防的是以后有人在上游改完能力却不告诉客户端。
 */
import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

class MockAuthError extends Error {}

vi.mock('@/lib/services/user-context', () => ({
  requireUser: vi.fn(async (request: NextRequest) => {
    if (request.headers.get('x-test-auth') === 'anonymous') throw new MockAuthError('未登录')
    return { id: 1, username: 'tester' }
  }),
  AuthError: MockAuthError,
}))

const { GET } = await import('./route')

const req = (auth = 'user') =>
  new NextRequest('http://local/api/discover/playlists/capabilities', { headers: { 'x-test-auth': auth } })

describe('GET /api/discover/playlists/capabilities', () => {
  it('未登录 401', async () => {
    expect((await GET(req('anonymous'))).status).toBe(401)
  })

  it('回五源的能力表，且 keyword 全为 false', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body.data).sort()).toEqual(['kg', 'kw', 'mg', 'tx', 'wy'])
    expect(body.data.tx.sorts).toEqual(['recommend', 'hot', 'new'])
    expect(body.data.mg.sorts).toEqual(['recommend'])
    expect(body.data.wy.sorts).toEqual(['hot'])
    expect(Object.values(body.data).every((c: { keyword: boolean }) => c.keyword === false)).toBe(true)
  })
})

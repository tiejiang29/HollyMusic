/**
 * app/api/playlists/route.ts 集成测试
 *
 * 守 POST 的 collected 透传：榜单收藏（LeaderboardPage「收藏榜单」）依赖 collected=true
 * 才会落到前端的「收藏歌单」分组；不传时仍是自建（false）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

class MockAuthError extends Error {
  statusCode = 401
  constructor(message = '未登录') {
    super(message)
    this.name = 'AuthError'
  }
}

let authMode: 'ok' | 'unauth' = 'ok'
vi.mock('@/lib/services/user-context', () => ({
  requireUser: vi.fn(async () => {
    if (authMode === 'unauth') throw new MockAuthError('未登录')
    return { username: 'tester' }
  }),
  AuthError: MockAuthError,
}))

const { createPlaylist, listPlaylistsForUser } = vi.hoisted(() => ({
  createPlaylist: vi.fn(async (username: string, name: string, opts: { collected?: boolean } = {}) => ({
    id: 9,
    name,
    username,
    collected: opts.collected ?? false,
  })),
  listPlaylistsForUser: vi.fn(async () => []),
}))
vi.mock('@/lib/services/playlist-service', () => ({ createPlaylist, listPlaylistsForUser }))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { POST } = await import('./route')

function post(body: unknown): NextRequest {
  return new NextRequest(new URL('http://localhost:3000/api/playlists'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  authMode = 'ok'
  createPlaylist.mockClear()
})

describe('POST /api/playlists', () => {
  it('collected=true 透传给服务（榜单收藏 → 「收藏歌单」分组）', async () => {
    const res = await POST(post({ name: '热歌榜', collected: true }))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(createPlaylist).toHaveBeenCalledWith('tester', '热歌榜', { collected: true })
    expect(json.data).toMatchObject({ collected: true })
  })

  it('不传 collected 时为自建（false）', async () => {
    await POST(post({ name: '我的歌单' }))
    expect(createPlaylist).toHaveBeenCalledWith('tester', '我的歌单', { collected: false })
  })

  it('collected 非 true 的值不生效（防误标）', async () => {
    await POST(post({ name: '我的歌单', collected: 'true' }))
    expect(createPlaylist).toHaveBeenCalledWith('tester', '我的歌单', { collected: false })
  })

  it('缺少 name → 400，不建歌单', async () => {
    const res = await POST(post({ name: '   ' }))
    expect(res.status).toBe(400)
    expect(createPlaylist).not.toHaveBeenCalled()
  })

  it('未登录 → 401，不建歌单', async () => {
    authMode = 'unauth'
    const res = await POST(post({ name: 'x' }))
    expect(res.status).toBe(401)
    expect(createPlaylist).not.toHaveBeenCalled()
  })
})

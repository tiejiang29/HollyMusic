/**
 * app/api/playlists/import-remote/route.ts 集成测试
 *
 * 重点守「平台歌单导入的副本必须标记 collected=true」——App 绿心收藏走的就是这条路径，
 * 漏标会让副本落到前端的「自建歌单」分组（回归用例）。
 * 通过 vi.mock 隔离鉴权 / 歌单服务 / 发现页详情，不触达真实 DB/网络。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

type AuthMode = 'ok' | 'unauth'
let authMode: AuthMode = 'ok'

class MockAuthError extends Error {
  statusCode = 401
  constructor(message = '未登录') {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/services/user-context', () => ({
  requireUser: vi.fn(async () => {
    if (authMode === 'unauth') throw new MockAuthError('未登录')
    return { username: 'tester' }
  }),
  AuthError: MockAuthError,
}))

const { createPlaylist, addSongsToPlaylist } = vi.hoisted(() => ({
  createPlaylist: vi.fn(async (username: string, name: string) => ({ id: 77, name, username, collected: true })),
  addSongsToPlaylist: vi.fn(async () => {}),
}))
vi.mock('@/lib/services/playlist-service', () => ({ createPlaylist, addSongsToPlaylist }))

const { getRecommendedPlaylistDetail } = vi.hoisted(() => ({ getRecommendedPlaylistDetail: vi.fn() }))
vi.mock('@/lib/services/discovery-service', () => ({
  getRecommendedPlaylistDetail,
  isDiscoverySource: (s: unknown) => ['kw', 'wy', 'tx', 'kg', 'mg'].includes(String(s)),
}))
vi.mock('@/lib/db', () => ({ upsertMusicInfosInTransaction: vi.fn(async () => []) }))
vi.mock('@/lib/music-core/music-search', () => ({ search: vi.fn(async () => ({ list: [] })) }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { POST } = await import('./route')

function post(body: unknown): NextRequest {
  return new NextRequest(new URL('http://localhost:3000/api/playlists/import-remote'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  authMode = 'ok'
  createPlaylist.mockClear()
  addSongsToPlaylist.mockClear()
  getRecommendedPlaylistDetail.mockReset()
  getRecommendedPlaylistDetail.mockResolvedValue({
    name: '国风电音 · 倚马独行于快意江湖',
    author: '蝶影丛虫',
    tracks: [{ uid: 'wy-1' }, { uid: 'wy-2' }],
  })
})

describe('POST /api/playlists/import-remote', () => {
  it('平台链接导入：副本以 collected=true 创建（否则会落在「自建歌单」分组）', async () => {
    const res = await POST(post({ url: 'https://music.163.com/playlist?id=18129092448' }))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(createPlaylist).toHaveBeenCalledTimes(1)
    const [username, name, opts] = createPlaylist.mock.calls[0]
    expect(username).toBe('tester')
    expect(name).toBe('国风电音 · 倚马独行于快意江湖')
    expect(opts).toEqual({ collected: true })
    expect(addSongsToPlaylist).toHaveBeenCalledWith(77, 'tester', ['wy-1', 'wy-2'])
    expect(json.data).toMatchObject({ playlistId: 77, source: 'wy', sourcePlaylistId: '18129092448', imported: 2 })
  })

  it('显式传 name 时优先用调用方的名字，仍带 collected=true', async () => {
    await POST(post({ source: 'wy', id: '18129092448', name: '  我的名字  ' }))
    expect(createPlaylist.mock.calls[0][1]).toBe('我的名字')
    expect(createPlaylist.mock.calls[0][2]).toEqual({ collected: true })
  })

  it('歌单不存在/为空 → 404，不建歌单', async () => {
    getRecommendedPlaylistDetail.mockResolvedValue({ name: 'x', author: '', tracks: [] })
    const res = await POST(post({ url: 'https://music.163.com/playlist?id=1' }))
    expect(res.status).toBe(404)
    expect(createPlaylist).not.toHaveBeenCalled()
  })

  it('无法识别的链接 → 400，不建歌单', async () => {
    // 短链跟随会真发请求，这里打桩成必然失败：既避免测试触网，也覆盖"跟随失败即判不可识别"
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network disabled in test') }))
    try {
      const res = await POST(post({ url: 'https://example.com/whatever' }))
      expect(res.status).toBe(400)
      expect(createPlaylist).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('未登录 → 401', async () => {
    authMode = 'unauth'
    const res = await POST(post({ url: 'https://music.163.com/playlist?id=1' }))
    expect(res.status).toBe(401)
    expect(createPlaylist).not.toHaveBeenCalled()
  })
})

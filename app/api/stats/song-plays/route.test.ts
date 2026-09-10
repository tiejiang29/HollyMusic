/**
 * app/api/stats/song-plays/route.ts 集成测试
 *
 * 鉴权（未登录 401）+ 全量口径与分页切片 + 响应结构。
 * 通过 vi.mock 隔离 requireUser / play-stats，不触达真实 DB。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { requireUser, getUserSongPlays } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getUserSongPlays: vi.fn(),
}))

class MockAuthError extends Error {
  statusCode = 401
  constructor(message = '未登录') {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/services/user-context', () => ({ requireUser, AuthError: MockAuthError }))
vi.mock('@/lib/services/play-stats', () => ({ getUserSongPlays }))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { GET } = await import('./route')

function makeRequest(query?: string) {
  return new NextRequest(`http://localhost:3000/api/stats/song-plays${query ? `?${query}` : ''}`)
}

/** 最小 SongPlayStat：route 只读 mi 的 name/singer/albumName/img */
function stat(n: number, totalPlays: number, playedAt: string) {
  return {
    key: `song${n}|p${n}`,
    mi: {
      name: `歌${n}`,
      singer: `P${n}`,
      albumName: `专辑${n}`,
      img: `http://x/${n}.jpg`,
      source: 'wy',
    },
    uid: `wy-${n}`,
    copies: 2,
    totalPlays,
    lastPlayedAt: new Date(playedAt),
  }
}

// 已按 totalPlays 降序排列的 3 首，总播放 6+4+2=12
const STATS = [stat(1, 6, '2026-09-05T00:00:00Z'), stat(2, 4, '2026-09-04T00:00:00Z'), stat(3, 2, '2026-09-03T00:00:00Z')]

describe('GET /api/stats/song-plays', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireUser.mockResolvedValue({ username: 'tester' })
    getUserSongPlays.mockResolvedValue(STATS.map(s => ({ ...s, mi: { ...s.mi } })))
  })

  it('未登录返回 401', async () => {
    requireUser.mockRejectedValue(new MockAuthError('未登录'))
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error.code).toBe('UNAUTHORIZED')
  })

  it('返回全量口径 + 列表明细', async () => {
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.totalSongs).toBe(3)
    expect(json.data.totalPlays).toBe(12)
    expect(json.data.list).toHaveLength(3)
    expect(json.data.list[0]).toEqual({
      uid: 'wy-1',
      name: '歌1',
      singer: 'P1',
      albumName: '专辑1',
      img: 'http://x/1.jpg',
      totalPlays: 6,
      lastPlayedAt: '2026-09-05T00:00:00.000Z',
      copies: 2,
    })
    expect(getUserSongPlays).toHaveBeenCalledWith('tester')
  })

  it('limit/offset 只切 list，不改变全量口径', async () => {
    const res = await GET(makeRequest('limit=2&offset=1'))
    const json = await res.json()
    expect(json.data.totalSongs).toBe(3)
    expect(json.data.totalPlays).toBe(12)
    expect(json.data.list.map((s: { uid: string }) => s.uid)).toEqual(['wy-2', 'wy-3'])
  })

  it('非法数值参数回退默认值', async () => {
    const res = await GET(makeRequest('limit=abc&offset=-5'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.data.list).toHaveLength(3)
  })

  it('统计层抛错返回 500', async () => {
    getUserSongPlays.mockRejectedValue(new Error('db down'))
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error.code).toBe('INTERNAL_ERROR')
  })
})

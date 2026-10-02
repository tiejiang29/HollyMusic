/**
 * app/api/history/route.ts 单元测试
 *
 * 只覆盖在线状态这条新增接线：播放上报成功后必须记一次最近活跃（手机端不发心跳，
 * 这是它唯一的活跃信号），而参数不合法/未登录时不该记。
 * 历史列表、清空两个分支由 history-service 自己的用例覆盖，这里不重复。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

class MockAuthError extends Error {
  statusCode = 401
  constructor(message = '未登录') {
    super(message)
    this.name = 'AuthError'
  }
}

const { reportPlay, listHistory, updateLastSeen, getClientIp, getUa } = vi.hoisted(() => ({
  reportPlay: vi.fn(),
  listHistory: vi.fn(),
  updateLastSeen: vi.fn(),
  getClientIp: vi.fn(),
  getUa: vi.fn(),
}))

let authed = true

vi.mock('@/lib/services/user-context', () => ({
  requireUser: vi.fn(async () => {
    if (!authed) throw new MockAuthError('未登录')
    return { id: 7, username: 'tester', avatar: null, bluetoothLyric: true }
  }),
  AuthError: MockAuthError,
}))

vi.mock('@/lib/services/history-service', () => ({
  reportPlay,
  listHistory,
  clearHistory: vi.fn(),
}))

vi.mock('@/lib/user', () => ({
  updateLastSeenByUsername: updateLastSeen,
  getClientIp,
  getUa,
}))

const { GET, POST } = await import('./route')

const musicInfo = {
  source: 'kw', songmid: '123', name: '测试歌曲', singer: '测试歌手',
  interval: '3:00', types: [], _types: {}, typeUrl: {},
}

function postRequest(body?: unknown): NextRequest {
  return new NextRequest(new URL('http://localhost:3000/api/history'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  authed = true
  reportPlay.mockReset().mockResolvedValue(undefined)
  listHistory.mockReset().mockResolvedValue({ list: [], total: 0 })
  updateLastSeen.mockReset().mockResolvedValue(null)
  getClientIp.mockReturnValue('172.16.1.49')
  getUa.mockReturnValue('HollyMusic/2.1.2')
})

describe('POST /api/history', () => {
  it('上报成功后把这次播放记为一次活跃（带 IP 与 UA）', async () => {
    const res = await POST(postRequest({ musicInfo }))
    expect(res.status).toBe(200)
    expect(reportPlay).toHaveBeenCalledWith('tester', musicInfo)
    expect(updateLastSeen).toHaveBeenCalledWith('tester', '172.16.1.49', 'HollyMusic/2.1.2')
  })

  it('载荷不合法判 400 时不记活跃', async () => {
    const res = await POST(postRequest({ musicInfo: { source: 'kw' } }))
    expect(res.status).toBe(400)
    expect(reportPlay).not.toHaveBeenCalled()
    expect(updateLastSeen).not.toHaveBeenCalled()
  })

  it('未登录判 401 时不记活跃', async () => {
    authed = false
    const res = await POST(postRequest({ musicInfo }))
    expect(res.status).toBe(401)
    expect(updateLastSeen).not.toHaveBeenCalled()
  })
})

describe('GET /api/history 分页参数收敛', () => {
  // 老写法把 parseInt 的结果直传 Prisma take：limit=1e9 就是全表拉取，limit=abc 是 NaN 直接 500
  it.each<[string, { limit: number; offset: number }]>([
    ['', { limit: 100, offset: 0 }],
    ['limit=1e9&offset=-1', { limit: 500, offset: 0 }],
    ['limit=abc&offset=2.7', { limit: 100, offset: 2 }],
    ['limit=50&offset=0', { limit: 50, offset: 0 }],
  ])('?%s 交给 service 的值必须落在安全区间内', async (query, expected) => {
    const res = await GET(new NextRequest(`http://localhost:3000/api/history?${query}`))

    expect(res.status).toBe(200)
    expect(listHistory).toHaveBeenCalledWith('tester', expected)
  })
})

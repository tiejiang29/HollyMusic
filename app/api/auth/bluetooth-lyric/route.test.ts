/**
 * app/api/auth/bluetooth-lyric/route.ts 单元测试
 *
 * 覆盖：参数校验（非布尔/缺字段/坏 JSON 一律 400 且不写库）、未登录 401、
 * 写入值与回显（回显取服务端实际值，不照抄请求）。
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

let authed = true
const update = vi.fn()

vi.mock('@/lib/services/user-context', () => ({
  requireUser: vi.fn(async () => {
    if (!authed) throw new MockAuthError('未登录')
    return { id: 7, username: 'tester', avatar: null, bluetoothLyric: true }
  }),
  AuthError: MockAuthError,
}))

vi.mock('@/lib/db', () => ({ prisma: { user: { update } } }))

const { PUT } = await import('./route')

function putRequest(body?: unknown, raw?: string): NextRequest {
  return new NextRequest(new URL('http://localhost:3000/api/auth/bluetooth-lyric'), {
    method: 'PUT',
    body: raw !== undefined ? raw : JSON.stringify(body),
  })
}

beforeEach(() => {
  authed = true
  update.mockReset()
  update.mockResolvedValue({ bluetoothLyric: false })
})

describe('PUT /api/auth/bluetooth-lyric', () => {
  it('写入布尔值并按服务端实际值回显', async () => {
    const res = await PUT(putRequest({ enabled: false }))
    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 }, data: { bluetoothLyric: false } }),
    )
    expect(await res.json()).toMatchObject({ success: true, data: { enabled: false } })
  })

  it('回显取库里的值而不是请求里的（校正客户端 UI）', async () => {
    update.mockResolvedValue({ bluetoothLyric: true })
    const res = await PUT(putRequest({ enabled: false }))
    expect((await res.json()).data.enabled).toBe(true)
  })

  it.each([['字符串', { enabled: 'no' }], ['缺字段', {}], ['null', { enabled: null }]])(
    '%s 判 400 且不写库', async (_label, body) => {
      const res = await PUT(putRequest(body))
      expect(res.status).toBe(400)
      expect(update).not.toHaveBeenCalled()
    },
  )

  it('请求体不是 JSON 时判 400', async () => {
    const res = await PUT(putRequest(undefined, 'not-json{'))
    expect(res.status).toBe(400)
    expect(update).not.toHaveBeenCalled()
  })

  it('未登录返回 401 且不写库', async () => {
    authed = false
    const res = await PUT(putRequest({ enabled: false }))
    expect(res.status).toBe(401)
    expect(update).not.toHaveBeenCalled()
  })
})

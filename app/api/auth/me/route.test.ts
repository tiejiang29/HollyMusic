/**
 * app/api/auth/me/route.ts 的读取通道测试
 *
 * 走真实的 user-context.getAuthState + 真实会话签名（只 mock prisma 的用户行读取），
 * 专门盯住那个坑：getAuthState 把 user 收窄成字面量对象，只加 schema 列不改映射的话
 * state.user.bluetoothLyric 会是 undefined，被 ?? true 静默兜成"存了但永远读回开"。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { sign } from '@/lib/services/auth'

const findUnique = vi.fn()
vi.mock('@/lib/db', () => ({ prisma: { user: { findUnique } } }))

const { GET } = await import('./route')

function meRequest(username: string, sessionVersion = 0): NextRequest {
  // cookie 必须在构造时给：NextRequest 在构造函数里就把 cookie 头解析进了 req.cookies
  const cookie = [
    `holly_user=${username}`,
    `holly_sv=${sessionVersion}`,
    `holly_sig=${sign(username, sessionVersion)}`,
  ].join('; ')
  return new NextRequest(new URL('http://localhost:3000/api/auth/me'), { headers: { cookie } })
}

function userRow(over: Record<string, unknown> = {}) {
  return {
    id: 7, username: 'tester', avatar: null, mustChangePassword: false, sessionVersion: 0,
    bluetoothLyric: true, ...over,
  }
}

async function dataOf(username = 'tester') {
  const res = await GET(meRequest(username))
  expect(res.status).toBe(200)
  const json = await res.json()
  expect(json.success).toBe(true)
  return json.data
}

beforeEach(() => {
  findUnique.mockReset()
  findUnique.mockResolvedValue(userRow())
})

describe('GET /api/auth/me', () => {
  it('已登录 + 库里关着：必须读回 false（而不是被 ?? true 兜成开）', async () => {
    findUnique.mockResolvedValue(userRow({ bluetoothLyric: false }))
    expect(await dataOf()).toMatchObject({ authenticated: true, bluetoothLyric: false })
  })

  it('已登录 + 库里开着：读回 true，且既有字段形状不变', async () => {
    expect(await dataOf()).toMatchObject({
      authenticated: true, username: 'tester', avatar: null,
      mustChangePassword: false, bluetoothLyric: true,
    })
  })

  it('用户隔离：按会话用户查行，A 的设置不串到 B', async () => {
    findUnique.mockResolvedValue(userRow({ id: 9, username: 'family', bluetoothLyric: false }))
    const data = await dataOf('family')
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { username: 'family' } }))
    expect(data).toMatchObject({ username: 'family', bluetoothLyric: false })
  })

  it('未登录：仍回 200（该接口是"永不 401"契约的一员），字段兜底 true 且不查库', async () => {
    const res = await GET(new NextRequest(new URL('http://localhost:3000/api/auth/me')))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      success: true, data: { authenticated: false, username: null, bluetoothLyric: true },
    })
    expect(findUnique).not.toHaveBeenCalled()
  })

  it('会话版本与库里不一致（改过密）：判定未登录，不泄露偏好', async () => {
    findUnique.mockResolvedValue(userRow({ sessionVersion: 3, bluetoothLyric: false }))
    const res = await GET(meRequest('tester', 0))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      data: { authenticated: false, username: null, bluetoothLyric: true },
    })
  })
})

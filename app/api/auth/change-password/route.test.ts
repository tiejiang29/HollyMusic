/**
 * app/api/auth/change-password/route.ts 集成测试
 *
 * 核心守卫：
 * 1) 改密码成功后 sessionVersion 必须 +1（其它设备旧会话立即失效），
 *    并为当前设备重发新版本 cookie（本设备不掉线）；
 * 2) 密码以 scrypt 哈希落库，同时轮换 Subsonic 令牌（SEC-1）；
 * 3) 存量明文用户（passwordHash 为空）改密后同样完成哈希迁移。
 *
 * 通过 vi.mock 隔离 requireUser / PrismaClient，不触达真实 DB。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { hashPassword, verifyPassword, verifyUserPassword } from '@/lib/server/credentials'

// --- mock requireUser / AuthError ------------------------------------------

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
    return { id: 1, username: 'tester' }
  }),
  AuthError: MockAuthError,
}))

// --- mock PrismaClient ------------------------------------------------------

const dbUser = {
  findUnique: vi.fn(),
  update: vi.fn(),
}

vi.mock('@/lib/generated/prisma', () => ({
  PrismaClient: class MockPrismaClient {
    user = dbUser
  },
}))

// --- 辅助 -------------------------------------------------------------------

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/change-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/

// 延迟导入，确保 vi.mock 先生效（sign 为纯函数，不 mock，直接引入真实实现）
const { POST } = await import('./route')
const { sign } = await import('@/lib/services/auth')

// ===========================================================================

describe('POST /api/auth/change-password', () => {
  beforeEach(() => {
    authMode = 'ok'
    dbUser.findUnique.mockReset()
    dbUser.update.mockReset()
    dbUser.update.mockResolvedValue({ id: 1, username: 'tester', sessionVersion: 4 })
  })

  it('改密成功 → 落 scrypt 哈希 + 轮换 Subsonic 令牌 + sessionVersion +1', async () => {
    const oldToken = 'oldTokenOldTokenOldTokenOldToken1'
    dbUser.findUnique.mockResolvedValue({
      id: 1,
      username: 'tester',
      passwordHash: await hashPassword('old123'),
      subsonicSecret: oldToken,
      sessionVersion: 3,
      mustChangePassword: false,
    })

    const res = await POST(makePostRequest({ currentPassword: 'old123', newPassword: 'new456' }))
    expect(res.status).toBe(200)

    expect(dbUser.update).toHaveBeenCalledTimes(1)
    const { where, data } = dbUser.update.mock.calls[0][0] as {
      where: { id: number }
      data: { passwordHash: string; subsonicSecret: string; mustChangePassword: boolean; sessionVersion: { increment: number } }
    }
    expect(where).toEqual({ id: 1 })

    // 密码落库为 scrypt 哈希，可用新密码校验通过、旧密码不再通过
    expect(data.passwordHash).toMatch(/^scrypt\$16384\$8\$1\$/)
    expect(await verifyPassword('new456', data.passwordHash)).toBe(true)
    expect(await verifyPassword('old123', data.passwordHash)).toBe(false)
    // 明文密码不得出现在写入数据里
    expect(JSON.stringify(data)).not.toContain('new456')

    // Subsonic 令牌轮换为新的随机值（旧令牌失效）
    expect(data.subsonicSecret).toMatch(TOKEN_RE)
    expect(data.subsonicSecret).not.toBe(oldToken)

    expect(data.mustChangePassword).toBe(false)
    expect(data.sessionVersion).toEqual({ increment: 1 })

    // 当前设备不掉线：响应携带新版本 cookie，签名与 holly_sv=4 匹配
    expect(res.cookies.get('holly_sv')?.value).toBe('4')
    expect(res.cookies.get('holly_sig')?.value).toBe(sign('tester', 4))
    expect(res.cookies.get('holly_user')?.value).toBe('tester')
  })

  it('存量明文用户改密 → 同样完成哈希迁移（passwordHash 由空变为哈希）', async () => {
    dbUser.findUnique.mockResolvedValue({
      id: 1,
      username: 'tester',
      passwordHash: null,
      subsonicSecret: 'legacy123',
      sessionVersion: 0,
      mustChangePassword: true,
    })

    const res = await POST(makePostRequest({ currentPassword: 'legacy123', newPassword: 'fresh456' }))
    expect(res.status).toBe(200)

    const { data } = dbUser.update.mock.calls[0][0] as { data: { passwordHash: string; subsonicSecret: string } }
    expect(data.passwordHash).toMatch(/^scrypt\$/)
    expect(await verifyUserPassword({ passwordHash: data.passwordHash, subsonicSecret: data.subsonicSecret }, 'fresh456')).toBe(true)
    expect(data.subsonicSecret).toMatch(TOKEN_RE)
    expect(data.subsonicSecret).not.toBe('legacy123')
  })

  it('当前密码错误 → 401 且不触发任何 DB 更新', async () => {
    dbUser.findUnique.mockResolvedValue({
      id: 1,
      username: 'tester',
      passwordHash: await hashPassword('old123'),
      subsonicSecret: 'someTokenSomeTokenSomeTokenSomeTo1',
      sessionVersion: 3,
      mustChangePassword: false,
    })

    const res = await POST(makePostRequest({ currentPassword: 'wrong9', newPassword: 'new456' }))
    expect(res.status).toBe(401)
    expect(dbUser.update).not.toHaveBeenCalled()
    expect(res.cookies.get('holly_sv')?.value).toBeUndefined()
  })

  it('未登录 → 401', async () => {
    authMode = 'unauth'
    const res = await POST(makePostRequest({ currentPassword: 'old123', newPassword: 'new456' }))
    expect(res.status).toBe(401)
    expect(dbUser.update).not.toHaveBeenCalled()
  })

  it('新密码长度不足 6 位 → 400', async () => {
    const res = await POST(makePostRequest({ currentPassword: 'old123', newPassword: 'abc' }))
    expect(res.status).toBe(400)
    expect(dbUser.findUnique).not.toHaveBeenCalled()
  })

  it('新密码与当前密码相同 → 400 且不更新', async () => {
    dbUser.findUnique.mockResolvedValue({
      id: 1,
      username: 'tester',
      passwordHash: await hashPassword('same123'),
      subsonicSecret: 'tokenTokenTokenTokenTokenToken00',
      sessionVersion: 0,
      mustChangePassword: false,
    })
    const res = await POST(makePostRequest({ currentPassword: 'same123', newPassword: 'same123' }))
    expect(res.status).toBe(400)
    expect(dbUser.update).not.toHaveBeenCalled()
  })
})

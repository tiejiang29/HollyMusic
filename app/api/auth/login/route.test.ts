/**
 * app/api/auth/login/route.ts 集成测试
 *
 * 核心守卫（SEC-1）：
 * 1) 密码以 scrypt 哈希校验；存量明文用户（passwordHash 为空）首次登录成功后就地
 *    迁移为哈希存储，并把明文 subsonicSecret 轮换为随机 Subsonic 令牌；
 * 2) 已迁移用户登录不再触发任何写入（不会每次登录都轮换令牌）；
 * 3) 密码错误 / 用户不存在 / 参数缺失 均不写库。
 *
 * 通过 vi.mock 隔离 PrismaClient，不触达真实 DB；限速用真实模块（键按用例区分）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { hashPassword, verifyPassword, generateSubsonicToken } from '@/lib/server/credentials'

// --- mock PrismaClient ------------------------------------------------------

const dbUser = {
  findUnique: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
}

vi.mock('@/lib/generated/prisma', () => ({
  PrismaClient: class MockPrismaClient {
    user = dbUser
  },
}))

// --- 辅助 -------------------------------------------------------------------

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/

/** 登录成功后的活跃度记录（lib/user.ts）也走 user.update，这里只挑凭据写入 */
function credentialWrites() {
  return dbUser.update.mock.calls
    .map((c) => c[0] as { where: { id: number }; data: Record<string, unknown> })
    .filter((args) => args?.data && 'passwordHash' in args.data)
}

const { POST } = await import('./route')

// ===========================================================================

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    dbUser.findUnique.mockReset()
    dbUser.update.mockReset()
    dbUser.updateMany.mockReset()
    dbUser.update.mockResolvedValue({})
    dbUser.updateMany.mockResolvedValue({ count: 0 })
  })

  it('存量明文用户登录成功 → 惰性迁移为 scrypt 哈希 + 轮换 Subsonic 令牌', async () => {
    dbUser.findUnique.mockResolvedValue({
      id: 7,
      username: 'legacy-user',
      passwordHash: null,
      subsonicSecret: 'plain-password',
      sessionVersion: 2,
      mustChangePassword: false,
    })

    const res = await POST(makePostRequest({ username: 'legacy-user', password: 'plain-password' }))
    expect(res.status).toBe(200)

    expect(credentialWrites()).toHaveLength(1)
    const { where, data } = credentialWrites()[0] as unknown as {
      where: { id: number }
      data: { passwordHash: string; subsonicSecret: string }
    }
    expect(where).toEqual({ id: 7 })
    expect(data.passwordHash).toMatch(/^scrypt\$16384\$8\$1\$/)
    expect(await verifyPassword('plain-password', data.passwordHash)).toBe(true)
    expect(data.subsonicSecret).toMatch(TOKEN_RE)
    expect(data.subsonicSecret).not.toBe('plain-password')

    // 会话 cookie 正常签发
    expect(res.cookies.get('holly_user')?.value).toBe('legacy-user')
    expect(res.cookies.get('holly_sv')?.value).toBe('2')
  })

  it('已迁移用户登录成功 → 不再写库（不重复迁移/轮换）', async () => {
    dbUser.findUnique.mockResolvedValue({
      id: 8,
      username: 'migrated-user',
      passwordHash: await hashPassword('hashed-pwd'),
      subsonicSecret: generateSubsonicToken(),
      sessionVersion: 1,
      mustChangePassword: false,
    })

    const res = await POST(makePostRequest({ username: 'migrated-user', password: 'hashed-pwd' }))
    expect(res.status).toBe(200)
    // 只在首次迁移时写凭据：已迁移用户登录不再轮换令牌
    expect(credentialWrites()).toHaveLength(0)
    expect(res.cookies.get('holly_user')?.value).toBe('migrated-user')
  })

  it('密码错误 → 401 且不写库', async () => {
    dbUser.findUnique.mockResolvedValue({
      id: 9,
      username: 'wrong-pwd-user',
      passwordHash: await hashPassword('right-pwd'),
      subsonicSecret: generateSubsonicToken(),
      sessionVersion: 0,
      mustChangePassword: false,
    })

    const res = await POST(makePostRequest({ username: 'wrong-pwd-user', password: 'nope-pwd' }))
    expect(res.status).toBe(401)
    expect(dbUser.update).not.toHaveBeenCalled()
    expect(res.cookies.get('holly_user')).toBeUndefined()
  })

  it('用户不存在 → 401 且不写库（等价耗时路径）', async () => {
    dbUser.findUnique.mockResolvedValue(null)

    const res = await POST(makePostRequest({ username: 'ghost-user', password: 'whatever' }))
    expect(res.status).toBe(401)
    expect(dbUser.update).not.toHaveBeenCalled()
  })

  it('存量用户密码错误 → 401 且不迁移', async () => {
    dbUser.findUnique.mockResolvedValue({
      id: 10,
      username: 'legacy-wrong',
      passwordHash: null,
      subsonicSecret: 'plain-password',
      sessionVersion: 0,
      mustChangePassword: false,
    })

    const res = await POST(makePostRequest({ username: 'legacy-wrong', password: 'plain-passwer' }))
    expect(res.status).toBe(401)
    expect(credentialWrites()).toHaveLength(0)
    expect(dbUser.update).not.toHaveBeenCalled()
  })

  it('用户名或密码为空 → 400 且不查库', async () => {
    const res = await POST(makePostRequest({ username: 'someone', password: '' }))
    expect(res.status).toBe(400)
    expect(dbUser.findUnique).not.toHaveBeenCalled()
  })
})

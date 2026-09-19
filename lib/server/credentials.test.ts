/**
 * lib/server/credentials.ts 单元测试
 *
 * 覆盖：哈希格式与校验、非法哈希串、存量明文兼容路径、
 * 令牌随机性与 URL 安全、buildCredentials 轮换语义。
 */

import { describe, it, expect } from 'vitest'
import {
  hashPassword,
  verifyPassword,
  verifyUserPassword,
  generateSubsonicToken,
  buildCredentials,
  constantTimeEqual,
} from './credentials'

describe('hashPassword / verifyPassword', () => {
  it('生成 scrypt$N$r$p$salt$hash 格式，可校验通过', async () => {
    const stored = await hashPassword('holly-dev-2026')
    expect(stored.split('$')).toHaveLength(6)
    expect(stored.startsWith('scrypt$16384$8$1$')).toBe(true)
    expect(await verifyPassword('holly-dev-2026', stored)).toBe(true)
  })

  it('错误密码 / 空哈希 / 非哈希串一律不通过', async () => {
    const stored = await hashPassword('correct-horse')
    expect(await verifyPassword('wrong-horse', stored)).toBe(false)
    expect(await verifyPassword('correct-horse', null)).toBe(false)
    expect(await verifyPassword('correct-horse', undefined)).toBe(false)
    expect(await verifyPassword('correct-horse', '')).toBe(false)
    // 明文密码本身不是合法哈希串（避免拿明文当哈希比对通过）
    expect(await verifyPassword('correct-horse', 'correct-horse')).toBe(false)
    // 结构损坏的哈希串
    expect(await verifyPassword('correct-horse', 'scrypt$16384$8$notanumber$AAA$BBB')).toBe(false)
    expect(await verifyPassword('correct-horse', 'scrypt$16384$8$1$$')).toBe(false)
    expect(await verifyPassword('correct-horse', 'bcrypt$10$abc$def$ghi$jkl')).toBe(false)
  })

  it('同一密码两次哈希不同（随机 salt），且都校验通过', async () => {
    const a = await hashPassword('same-password')
    const b = await hashPassword('same-password')
    expect(a).not.toBe(b)
    expect(await verifyPassword('same-password', a)).toBe(true)
    expect(await verifyPassword('same-password', b)).toBe(true)
  })
})

describe('verifyUserPassword（含存量明文兼容）', () => {
  it('已迁移用户：按 passwordHash 校验', async () => {
    const user = { passwordHash: await hashPassword('new-secret'), subsonicSecret: generateSubsonicToken() }
    expect(await verifyUserPassword(user, 'new-secret')).toBe(true)
    expect(await verifyUserPassword(user, 'admin')).toBe(false)
  })

  it('存量未迁移用户：subsonicSecret 仍是明文密码，可校验通过', async () => {
    const user = { passwordHash: null, subsonicSecret: 'legacy-pwd' }
    expect(await verifyUserPassword(user, 'legacy-pwd')).toBe(true)
    expect(await verifyUserPassword(user, 'legacy-pwd ')).toBe(false)
    expect(await verifyUserPassword(user, 'other-pwd')).toBe(false)
  })

  it('无任何凭据（passwordHash 与 subsonicSecret 均空）→ 不通过', async () => {
    expect(await verifyUserPassword({ passwordHash: null, subsonicSecret: null }, 'admin')).toBe(false)
    expect(await verifyUserPassword({}, 'admin')).toBe(false)
    expect(await verifyUserPassword({ passwordHash: '', subsonicSecret: '' }, 'admin')).toBe(false)
  })

  it('迁移后令牌不再是密码：明文密码不得再登录', async () => {
    const creds = await buildCredentials('plain-pwd')
    const user = { ...creds }
    // 令牌是随机值，与密码无关 → 拿旧明文密码（哪怕等于令牌长度）不能通过
    expect(await verifyUserPassword(user, creds.subsonicSecret)).toBe(false)
    expect(await verifyUserPassword(user, 'plain-pwd')).toBe(true)
  })
})

describe('generateSubsonicToken', () => {
  it('32 字符 base64url，且每次不同', () => {
    const a = generateSubsonicToken()
    const b = generateSubsonicToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(a).not.toBe(b)
  })
})

describe('buildCredentials', () => {
  it('每次调用都轮换令牌（旧令牌随之失效）', async () => {
    const first = await buildCredentials('pwd-123456')
    const second = await buildCredentials('pwd-123456')
    expect(first.subsonicSecret).not.toBe(second.subsonicSecret)
    expect(await verifyPassword('pwd-123456', first.passwordHash)).toBe(true)
    expect(await verifyPassword('pwd-123456', second.passwordHash)).toBe(true)
  })
})

describe('constantTimeEqual', () => {
  it('同长比较正确，长度不同判否', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
    expect(constantTimeEqual('', '')).toBe(true)
  })
})

/**
 * 用户凭据：登录密码哈希 + Subsonic 令牌
 *
 * 原先 User.subsonicSecret 同时承担两个角色——Web/App 登录密码（明文存储）与
 * Subsonic 协议密钥（t=md5(secret+s)）。明文落库一旦 DB 文件泄漏即等于密码泄漏，
 * 故拆为两个字段：
 *
 *   passwordHash   scrypt 哈希（scrypt$N$r$p$salt$hash），登录与改密校验用
 *   subsonicSecret 每用户随机令牌，仅供 Subsonic 客户端 t 校验，与登录密码解耦
 *
 * 存量数据惰性迁移：老库中 passwordHash 为 NULL、subsonicSecret 存的是明文密码；
 * 用户下次登录校验通过时就地落哈希并把 subsonicSecret 轮换成随机令牌
 * （见 app/api/auth/login/route.ts）。迁移完成后 DB 内不再有明文密码。
 *
 * 零新依赖：node:crypto 的 scrypt，N=16384/r=8/p=1 ≈16MB 内存、单次校验 ~50-100ms，
 * 登录/改密路径可接受；参数写进哈希串，日后调参不用改校验代码。
 */

import crypto from 'crypto'
import { promisify } from 'util'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEY_LEN = 64
const SCRYPT_MAXMEM = 64 * 1024 * 1024
const SALT_BYTES = 16
const HASH_PREFIX = 'scrypt'

const scryptAsync = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>

/** 恒定时间字符串比较（长度不同直接判否，避免 timingSafeEqual 抛错） */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  try {
    return crypto.timingSafeEqual(ab, bb)
  } catch {
    return false
  }
}

/** 生成密码哈希，格式：scrypt$N$r$p$<salt-base64url>$<hash-base64url> */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES)
  const derived = await scryptAsync(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })
  return [
    HASH_PREFIX,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$')
}

function parseHash(stored: string): { n: number; r: number; p: number; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== HASH_PREFIX) return null
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return null
  if (n <= 0 || r <= 0 || p <= 0) return null
  try {
    const salt = Buffer.from(parts[4], 'base64url')
    const hash = Buffer.from(parts[5], 'base64url')
    if (salt.length === 0 || hash.length === 0) return null
    return { n, r, p, salt, hash }
  } catch {
    return null
  }
}

/** 校验密码是否匹配哈希串；非哈希格式（含 null/明文）一律返回 false */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false
  const parsed = parseHash(stored)
  if (!parsed) return false
  const derived = await scryptAsync(password, parsed.salt, parsed.hash.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: SCRYPT_MAXMEM,
  })
  if (derived.length !== parsed.hash.length) return false
  try {
    return crypto.timingSafeEqual(derived, parsed.hash)
  } catch {
    return false
  }
}

/** 每用户 Subsonic 令牌（24 字节随机 → 32 字符 base64url，URL 安全便于放查询串） */
export function generateSubsonicToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

export type UserCredentialFields = {
  passwordHash?: string | null
  subsonicSecret?: string | null
}

// 用户不存在时也要烧掉一次同等耗时的 scrypt，避免用响应时间枚举用户名
let dummyHashPromise: Promise<string> | null = null
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(crypto.randomBytes(16).toString('hex'))
  return dummyHashPromise
}

/** 校验用户密码：优先 passwordHash；passwordHash 为空时按存量明文（subsonicSecret）比较 */
export async function verifyUserPassword(user: UserCredentialFields, password: string): Promise<boolean> {
  if (user.passwordHash) return verifyPassword(password, user.passwordHash)

  const legacyPlain = user.subsonicSecret
  if (!legacyPlain) {
    await verifyPassword(password, await getDummyHash())
    return false
  }
  // 存量未迁移用户：subsonicSecret 仍是明文密码。这里同时烧一次 scrypt，
  // 使「存在未迁移用户」与「用户不存在」的登录耗时不可区分。
  const [ok] = await Promise.all([
    Promise.resolve(constantTimeEqual(legacyPlain, password)),
    verifyPassword(password, await getDummyHash()),
  ])
  return ok
}

/**
 * 写入新密码时的凭据对：密码落 scrypt 哈希，Subsonic 令牌一并轮换
 * （与旧行为一致——改密即令旧的 Subsonic 凭据失效）。
 */
export async function buildCredentials(password: string): Promise<{ passwordHash: string; subsonicSecret: string }> {
  return {
    passwordHash: await hashPassword(password),
    subsonicSecret: generateSubsonicToken(),
  }
}

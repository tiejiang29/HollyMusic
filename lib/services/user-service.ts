/**
 * 用户管理服务
 *
 * 管理员对用户的 CRUD 操作。所有写操作都带业务保护：
 * - admin 账户（username === 'admin'）不可删除、不可改用户名
 * - 禁止当前登录用户删除自己
 * - 用户名唯一约束
 *
 * 密码以 scrypt 哈希存于 User.passwordHash（见 lib/server/credentials.ts），
 * 管理员重置密码时同时轮换 Subsonic 令牌（User.subsonicSecret），
 * 并强制该用户下次登录改密 + 使其所有旧会话失效。
 */

import { prisma } from '../db'
import { logger } from '../logger'
import { ONLINE_TTL_MS } from '../user'
import { buildCredentials, generateSubsonicToken } from '../server/credentials'

export interface AdminUserView {
  id: number
  username: string
  /** 是否管理员（仅 username === 'admin'） */
  isAdmin: boolean
  /** 是否设置了密码（不返回密码本身） */
  hasPassword: boolean
  /** 是否需要强制修改密码（管理员重置密码后置 true） */
  mustChangePassword: boolean
  lastLogin: Date | null
  /** 最近一次活跃时间（登录/心跳） */
  lastSeen: Date | null
  /** 最近一次活跃的客户端 IP */
  lastSeenIp: string | null
  /** 最近一次活跃的 User-Agent */
  lastSeenUa: string | null
  /** 是否在线（最近活跃在 ONLINE_TTL_MS 内） */
  isOnline: boolean
  createdAt: Date
  updatedAt: Date
}

/** 安全用户视图：脱敏，不含密码哈希与 Subsonic 令牌 */
function toView(u: {
  id: number
  username: string
  passwordHash?: string | null
  subsonicSecret: string | null
  mustChangePassword: boolean
  lastLogin: Date | null
  lastSeen: Date | null
  lastSeenIp: string | null
  lastSeenUa: string | null
  createdAt: Date
  updatedAt: Date
}): AdminUserView {
  return {
    id: u.id,
    username: u.username,
    isAdmin: u.username === 'admin',
    // 存量未迁移用户的凭据仍在 subsonicSecret（明文），一并算作已设密码
    hasPassword: !!(u.passwordHash || u.subsonicSecret),
    mustChangePassword: !!u.mustChangePassword,
    lastLogin: u.lastLogin,
    lastSeen: u.lastSeen,
    lastSeenIp: u.lastSeenIp,
    lastSeenUa: u.lastSeenUa,
    isOnline: !!(u.lastSeen && Date.now() - u.lastSeen.getTime() < ONLINE_TTL_MS),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  }
}

export async function listUsers(): Promise<AdminUserView[]> {
  const users = await prisma.user.findMany({
    orderBy: [{ username: 'asc' }],
  })
  return users.map(toView)
}

export async function getUserById(id: number): Promise<AdminUserView | null> {
  const u = await prisma.user.findUnique({ where: { id } })
  return u ? toView(u) : null
}

/**
 * 新建用户。
 * @throws UserInputError 用户名已存在 / 为空
 */
export async function createUser(username: string, password: string): Promise<AdminUserView> {
  const name = (username || '').trim()
  if (!name) throw new UserInputError('用户名不能为空')
  if (!password) throw new UserInputError('密码不能为空')

  try {
    const u = await prisma.user.create({
      data: { username: name, ...(await buildCredentials(password)) },
    })
    logger.info(`[user-service] 新建用户: ${name}`)
    return toView(u)
  } catch (e) {
    // P2002 = unique constraint violation
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'P2002') {
      throw new UserInputError(`用户名 "${name}" 已存在`)
    }
    throw e
  }
}

/**
 * 更新用户。username 可选；若提供 password 则更新密码，否则保留原密码。
 *
 * 保护规则：
 * - admin 账户（原 username === 'admin'）不可改用户名（防丢管理员）
 * - 改用户名时检查新名唯一
 *
 * @throws NotFoundError 用户不存在
 * @throws UserInputError 改名冲突 / admin 改名
 */
export async function updateUser(
  id: number,
  opts: { username?: string; password?: string | null }
): Promise<AdminUserView> {
  const existing = await prisma.user.findUnique({ where: { id } })
  if (!existing) throw new NotFoundError('用户不存在')

  const data: {
    username?: string
    passwordHash?: string | null
    subsonicSecret?: string | null
    mustChangePassword?: boolean
    sessionVersion?: { increment: number }
  } = {}

  if (opts.username != null) {
    const newName = opts.username.trim()
    if (!newName) throw new UserInputError('用户名不能为空')
    if (newName !== existing.username) {
      // admin 账户禁止改名
      if (existing.username === 'admin') {
        throw new UserInputError('管理员账户不可更改用户名')
      }
      // 改名本身即令旧 cookie 失效（签名含用户名），无需递增版本
      data.username = newName
    }
  }

  // password === null / '' 表示不改；显式传非空字符串才更新
  if (typeof opts.password === 'string' && opts.password !== '') {
    // 密码落 scrypt 哈希，并轮换 Subsonic 令牌（旧令牌同时失效）
    Object.assign(data, await buildCredentials(opts.password))
    // 管理员重置某用户密码后，强制该用户下次登录改密
    data.mustChangePassword = true
    // 会话版本 +1：该用户所有已登录设备的旧会话立即失效
    data.sessionVersion = { increment: 1 }
  }

  if (Object.keys(data).length === 0) {
    // 无变更
    return toView(existing)
  }

  try {
    const u = await prisma.user.update({ where: { id }, data })
    logger.info(`[user-service] 更新用户 id=${id} keys=${Object.keys(data).join(',')}`)
    return toView(u)
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'P2002') {
      throw new UserInputError(`用户名 "${data.username}" 已存在`)
    }
    throw e
  }
}

/**
 * 删除用户。
 *
 * 保护规则：
 * - admin 账户（username === 'admin'）不可删除
 * - 禁止删除自己（currentUsername 校验）
 *
 * 关联数据：Playlist/PlayHistory 用 username 做外键，onDelete: Cascade，会级联删除其歌单；
 * Favorite 用 userId，同样 Cascade。
 *
 * @throws NotFoundError 用户不存在
 * @throws UserInputError admin 账户 / 删除自己
 */
export async function deleteUser(id: number, currentUsername: string): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { id } })
  if (!existing) throw new NotFoundError('用户不存在')

  if (existing.username === 'admin') {
    throw new UserInputError('管理员账户不可删除')
  }
  if (existing.username === currentUsername) {
    throw new UserInputError('不能删除当前登录的自己')
  }

  await prisma.user.delete({ where: { id } })
  logger.info(`[user-service] 删除用户: ${existing.username} (by ${currentUsername})`)
}

/**
 * 轮换并返回用户的 Subsonic 令牌（管理员操作）。
 *
 * 令牌只在本次响应中返回一次，库内不再有明文本可读；旧令牌立即失效，
 * 该用户名下已连接的 Subsonic 客户端需重新配置。
 *
 * @throws NotFoundError 用户不存在
 */
export async function issueSubsonicToken(id: number): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { id } })
  if (!existing) throw new NotFoundError('用户不存在')

  const token = generateSubsonicToken()
  await prisma.user.update({ where: { id }, data: { subsonicSecret: token } })
  logger.info(`[user-service] 已轮换 Subsonic 令牌: ${existing.username} (id=${id})`)
  return token
}

/** 业务层输入错误（4xx） */
export class UserInputError extends Error {
  statusCode = 400
  constructor(message: string) {
    super(message)
    this.name = 'UserInputError'
  }
}

/** 业务层未找到（404） */
export class NotFoundError extends Error {
  statusCode = 404
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

const userService = { listUsers, getUserById, createUser, updateUser, deleteUser, issueSubsonicToken }
export default userService

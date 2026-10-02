/**
 * lib/user.ts 的写库契约测试
 *
 * 两件事要钉住：
 * 1. 「不抛出」—— /api/history、Subsonic scrobble、登录都直接 await 这些函数，
 *    调用点没有 try/catch；一旦它们改成抛异常，播放上报与登录就会变成 500。
 * 2. 「一次往返」—— username 是 @unique，活跃记录不该先 findUnique 再 update by id。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findUnique, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
}))

vi.mock('./db', () => ({
  prisma: { user: { findUnique, update } },
}))

const { updateLastSeenByUsername, markLoginActivity } = await import('./user')

beforeEach(() => {
  findUnique.mockReset()
  update.mockReset()
  update.mockResolvedValue({ id: 3, username: 'tiejiang' })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('updateLastSeenByUsername', () => {
  it('一次 update 写时间 + IP + UA，不再先查一遍用户', async () => {
    await updateLastSeenByUsername('tiejiang', '172.16.1.49', 'HollyMusic/2.1.2')

    expect(findUnique).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledTimes(1)
    const args = update.mock.calls[0][0]
    expect(args.where).toEqual({ username: 'tiejiang' })
    expect(args.data.lastSeenIp).toBe('172.16.1.49')
    expect(args.data.lastSeenUa).toBe('HollyMusic/2.1.2')
    expect(args.data.lastSeen).toBeInstanceOf(Date)
  })

  it('用户不存在（Prisma 抛 P2025）时只返回 null，不抛出', async () => {
    const err = new Error('Record not found')
    Object.assign(err, { code: 'P2025' })
    update.mockRejectedValue(err)
    await expect(updateLastSeenByUsername('ghost', null, null)).resolves.toBeNull()
  })

  it('空用户名直接返回 null，一次库都不碰', async () => {
    await expect(updateLastSeenByUsername('', null, null)).resolves.toBeNull()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('markLoginActivity', () => {
  it('登录活动一次写完：lastLogin 与最近活跃同源同一时刻', async () => {
    await markLoginActivity('admin', '172.16.1.7', 'Mozilla/5.0')

    expect(update).toHaveBeenCalledTimes(1)
    const args = update.mock.calls[0][0]
    expect(args.where).toEqual({ username: 'admin' })
    expect(args.data.lastLogin).toBeInstanceOf(Date)
    expect(args.data.lastLogin).toEqual(args.data.lastSeen)
    expect(args.data.lastSeenIp).toBe('172.16.1.7')
    expect(args.data.lastSeenUa).toBe('Mozilla/5.0')
  })

  it('写库失败不影响登录（内部吞掉，返回 null）', async () => {
    update.mockRejectedValue(new Error('SQLITE_BUSY'))
    await expect(markLoginActivity('admin', null, null)).resolves.toBeNull()
  })
})

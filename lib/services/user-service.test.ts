/**
 * lib/services/user-service.ts 的在线状态口径测试
 *
 * 只盯一件容易悄悄坏掉的事：阈值改动是否真的作用到 isOnline。
 * 手机端不发心跳、只靠播放上报续命，一首歌唱 5~7 分钟很常见，
 * 阈值若退回 5 分钟就会出现「正在听歌却显示离线」。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const findMany = vi.fn()

vi.mock('../db', () => ({
  prisma: { user: { findMany } },
}))

const { listUsers } = await import('./user-service')

function row(lastSeen: Date | null) {
  return {
    id: 1,
    username: 'tiejiang',
    passwordHash: 'x',
    subsonicSecret: 'y',
    mustChangePassword: false,
    lastLogin: null,
    lastSeen,
    lastSeenIp: null,
    lastSeenUa: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  }
}

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 1000)
}

beforeEach(() => {
  findMany.mockReset()
})

describe('listUsers 的 isOnline', () => {
  it.each([[7, true], [9, true], [11, false], [60, false]])(
    '最近活跃在 %i 分钟前 → %s',
    async (ago, expected) => {
      findMany.mockResolvedValue([row(minutesAgo(ago))])
      const [user] = await listUsers()
      expect(user.isOnline).toBe(expected)
    },
  )

  it('从未活跃过视为离线', async () => {
    findMany.mockResolvedValue([row(null)])
    const [user] = await listUsers()
    expect(user.isOnline).toBe(false)
  })
})

/**
 * lib/services/playlist-service.ts 测试
 *
 * 重点守 createPlaylist 的 collected 口径：默认自建=false，
 * 导入/副本类调用（import / import-remote）必须显式传 true 才能进「收藏歌单」分组。
 * 回归背景：平台歌单导入曾裸调 createPlaylist，副本落在「自建歌单」里。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const playlistCreate = vi.hoisted(() => vi.fn())

vi.mock('../generated/prisma', () => ({
  PrismaClient: class {
    playlist = { create: playlistCreate }
  },
  Prisma: {},
}))
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { createPlaylist } = await import('./playlist-service')

beforeEach(() => {
  playlistCreate.mockReset()
  // 回显入参，便于断言落库字段
  playlistCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 1,
    name: data.name,
    username: data.username,
    owner: data.owner,
    comment: (data.comment as string | null) ?? null,
    isPublic: data.isPublic,
    collected: data.collected,
    songCount: data.songCount,
    duration: data.duration,
    coverArt: null,
    createdAt: new Date('2026-09-16T00:00:00Z'),
    allowedUsers: [],
  }))
})

describe('createPlaylist 的 collected 口径', () => {
  it('默认自建：collected 落 false', async () => {
    const summary = await createPlaylist('tester', '我的歌单')
    const data = playlistCreate.mock.calls[0][0].data
    expect(data.collected).toBe(false)
    expect(summary.collected).toBe(false)
  })

  it('导入/副本：显式传 { collected: true } 时落 true', async () => {
    const summary = await createPlaylist('tester', '平台歌单副本', { collected: true })
    const data = playlistCreate.mock.calls[0][0].data
    expect(data.collected).toBe(true)
    expect(summary.collected).toBe(true)
  })

  it('自建与副本的其它字段口径一致（owner=自己、默认私有）', async () => {
    await createPlaylist('tester', 'x', { collected: true })
    const data = playlistCreate.mock.calls[0][0].data
    expect(data).toMatchObject({ username: 'tester', owner: 'tester', isPublic: false, songCount: 0 })
  })
})

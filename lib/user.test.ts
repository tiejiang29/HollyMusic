/**
 * lib/user.ts 的 updateLastSeenByUsername 契约测试
 *
 * 这里要钉住的是「不抛出」这一条：/api/history 与 Subsonic scrobble 都直接 await 它，
 * 调用点没有 try/catch —— 一旦它改成抛异常，播放上报就会变成 500。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findUnique, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
}))

vi.mock('./db', () => ({
  prisma: { user: { findUnique, update } },
}))

const { updateLastSeenByUsername } = await import('./user')

beforeEach(() => {
  findUnique.mockReset()
  update.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('updateLastSeenByUsername', () => {
  it('按用户名定位后写入时间 + IP + UA', async () => {
    findUnique.mockResolvedValue({ id: 3, username: 'tiejiang' })
    update.mockResolvedValue({ id: 3 })
    const updated = await updateLastSeenByUsername('tiejiang', '172.16.1.49', 'HollyMusic/2.1.2')
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 3 },
        data: expect.objectContaining({ lastSeenIp: '172.16.1.49', lastSeenUa: 'HollyMusic/2.1.2' }),
      }),
    )
    expect(updated).toEqual({ id: 3 })
  })

  it('写库失败只返回 null，不抛出（调用点依赖这条才不会把上报打成 500）', async () => {
    findUnique.mockResolvedValue({ id: 3, username: 'tiejiang' })
    update.mockRejectedValue(new Error('SQLITE_BUSY'))
    await expect(updateLastSeenByUsername('tiejiang', null, null)).resolves.toBeNull()
  })

  it('用户不存在或用户名为空时不写库', async () => {
    findUnique.mockResolvedValue(null)
    await expect(updateLastSeenByUsername('ghost', null, null)).resolves.toBeNull()
    expect(update).not.toHaveBeenCalled()

    await expect(updateLastSeenByUsername('', null, null)).resolves.toBeNull()
    expect(findUnique).toHaveBeenCalledTimes(1)
  })
})

/**
 * app/api/library/[id]/route.ts 单元测试
 *
 * 钉住门槛：音乐库全体用户共享、LibrarySong 没有归属列，删除会连带删磁盘文件，
 * 所以只让管理员做（与 POST /api/library 同级）。之前只要求登录，任何一个家人
 * 都能把别人入库的歌从磁盘上删掉。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

class MockAuthError extends Error {
  statusCode = 401
  constructor(message = '未登录') {
    super(message)
    this.name = 'AuthError'
  }
}

class MockForbiddenError extends Error {
  statusCode = 403
  constructor(message = '需要管理员权限') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

/** 'anon' 未登录 / 'user' 登录但非管理员 / 'admin' 管理员 */
let who: 'anon' | 'user' | 'admin' = 'admin'

vi.mock('@/lib/services/user-context', () => ({
  requireAdmin: vi.fn(async () => {
    if (who === 'anon') throw new MockAuthError('未登录')
    if (who === 'user') throw new MockForbiddenError('需要管理员权限')
    return { id: 1, username: 'admin', role: 'admin' }
  }),
  AuthError: MockAuthError,
  ForbiddenError: MockForbiddenError,
}))

const { deleteLibrarySong } = vi.hoisted(() => ({ deleteLibrarySong: vi.fn() }))

vi.mock('@/lib/services/music-library', () => ({ deleteLibrarySong }))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { DELETE } = await import('./route')

beforeEach(() => {
  who = 'admin'
  deleteLibrarySong.mockReset().mockResolvedValue(true)
})

async function call(id: string) {
  return DELETE(new NextRequest(`http://localhost:3000/api/library/${id}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  })
}

describe('DELETE /api/library/[id]', () => {
  it('未登录判 401，且不碰磁盘与登记行', async () => {
    who = 'anon'
    const res = await call('12')

    expect(res.status).toBe(401)
    expect(deleteLibrarySong).not.toHaveBeenCalled()
  })

  it('登录但非管理员判 403，且不碰磁盘与登记行', async () => {
    who = 'user'
    const res = await call('12')

    expect(res.status).toBe(403)
    expect(deleteLibrarySong).not.toHaveBeenCalled()
  })

  it('管理员删除成功，id 转成数字后交给服务', async () => {
    const res = await call('12')

    expect(res.status).toBe(200)
    expect(deleteLibrarySong).toHaveBeenCalledWith(12)
  })

  it('id 不是数字判 400', async () => {
    const res = await call('abc')

    expect(res.status).toBe(400)
    expect(deleteLibrarySong).not.toHaveBeenCalled()
  })

  it('条目不存在返回 404 而不是 500', async () => {
    deleteLibrarySong.mockResolvedValue(false)
    const res = await call('99')

    expect(res.status).toBe(404)
  })

  it('非管理员的判定优先于 id 校验（先鉴权再解析参数）', async () => {
    who = 'user'
    const res = await call('abc')

    expect(res.status).toBe(403)
    expect(deleteLibrarySong).not.toHaveBeenCalled()
  })
})

/**
 * app/api/favorites/route.ts 与 check/route.ts 集成测试
 *
 * 守 type 分流：只有显式 type=album 才走专辑分支（并透传展示快照），
 * 其余（含不传 type 的旧客户端）一律走歌曲分支，行为零改动。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

class MockAuthError extends Error {
  statusCode = 401
  constructor(message = '未登录') {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/services/user-context', () => ({
  requireUser: vi.fn(async () => ({ id: 7, username: 'tester' })),
  AuthError: MockAuthError,
}))

const {
  listFavoriteSongs, starSong, unstarSong,
  listFavoriteAlbums, starAlbum, unstarAlbum, checkAlbumStarred,
} = vi.hoisted(() => ({
  listFavoriteSongs: vi.fn(async () => ({ list: [{ songId: 'tx-a' }], total: 1 })),
  starSong: vi.fn(async () => ({ starred: true })),
  unstarSong: vi.fn(async () => ({ starred: false })),
  listFavoriteAlbums: vi.fn(async () => ({ list: [{ albumId: 't1-9', name: '范特西' }], total: 1 })),
  starAlbum: vi.fn(async () => ({ starred: true })),
  unstarAlbum: vi.fn(async () => ({ starred: false, deleted: 1 })),
  checkAlbumStarred: vi.fn(async () => true),
}))

vi.mock('@/lib/services/favorites-service', () => ({
  listFavoriteSongs, starSong, unstarSong,
  listFavoriteAlbums, starAlbum, unstarAlbum, checkAlbumStarred,
  checkStarred: vi.fn(async () => false),
}))

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const route = await import('./route')
const checkRoute = await import('./check/route')

function post(body: unknown): NextRequest {
  return new NextRequest(new URL('http://localhost:3000/api/favorites'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  listFavoriteSongs.mockClear()
  starSong.mockClear()
  unstarSong.mockClear()
  listFavoriteAlbums.mockClear()
  starAlbum.mockClear()
  unstarAlbum.mockClear()
  checkAlbumStarred.mockClear()
})

describe('GET /api/favorites', () => {
  it('不传 type 走歌曲列表（旧客户端不变）', async () => {
    const res = await route.GET(new NextRequest('http://localhost:3000/api/favorites'))
    const body = await res.json()

    expect(listFavoriteSongs).toHaveBeenCalledWith(7, { limit: 200, offset: 0 })
    expect(listFavoriteAlbums).not.toHaveBeenCalled()
    expect(body.data.total).toBe(1)
  })

  it('type=album 走专辑列表并透传分页', async () => {
    await route.GET(new NextRequest('http://localhost:3000/api/favorites?type=album&limit=10&offset=20'))

    expect(listFavoriteAlbums).toHaveBeenCalledWith(7, { limit: 10, offset: 20 })
    expect(listFavoriteSongs).not.toHaveBeenCalled()
  })

  it('不认识的 type 归入歌曲分支', async () => {
    await route.GET(new NextRequest('http://localhost:3000/api/favorites?type=artist'))

    expect(listFavoriteSongs).toHaveBeenCalledTimes(1)
    expect(listFavoriteAlbums).not.toHaveBeenCalled()
  })
})

describe('POST /api/favorites', () => {
  it('type=album 时把专辑 id 与展示快照全部透传给 service', async () => {
    const res = await route.POST(post({
      id: 't1-album-9', type: 'album', source: 'tx',
      name: '范特西', singer: '周杰伦', img: 'http://img/f.jpg',
    }))

    expect(res.status).toBe(200)
    expect(starAlbum).toHaveBeenCalledWith(7, {
      albumId: 't1-album-9',
      source: 'tx',
      name: '范特西',
      singer: '周杰伦',
      img: 'http://img/f.jpg',
    })
    expect(starSong).not.toHaveBeenCalled()
  })

  it('缺省 type 走歌曲收藏（旧客户端不变）', async () => {
    await route.POST(post({ id: 'tx-abc' }))

    expect(starSong).toHaveBeenCalledWith(7, 'tx-abc')
    expect(starAlbum).not.toHaveBeenCalled()
  })

  it('专辑快照字段的空串视同未传（落 null 而不是空字符串）', async () => {
    await route.POST(post({ id: 'kw-1', type: 'album', source: '', name: '  ', singer: '', img: '' }))

    expect(starAlbum).toHaveBeenCalledWith(7, {
      albumId: 'kw-1', source: null, name: null, singer: null, img: null,
    })
  })

  it('缺 id 时返回 400', async () => {
    const res = await route.POST(post({ type: 'album' }))
    expect(res.status).toBe(400)
    expect(starAlbum).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/favorites', () => {
  it('type=album 时带 source 精确删除', async () => {
    await route.DELETE(new NextRequest('http://localhost:3000/api/favorites?id=t1-album-9&type=album&source=tx'))

    expect(unstarAlbum).toHaveBeenCalledWith(7, 't1-album-9', 'tx')
    expect(unstarSong).not.toHaveBeenCalled()
  })

  it('不传 type 走歌曲取消收藏（旧客户端不变）', async () => {
    await route.DELETE(new NextRequest('http://localhost:3000/api/favorites?id=tx-abc'))

    expect(unstarSong).toHaveBeenCalledWith(7, 'tx-abc')
    expect(unstarAlbum).not.toHaveBeenCalled()
  })

  it('缺 id 时返回 400', async () => {
    const res = await route.DELETE(new NextRequest('http://localhost:3000/api/favorites?type=album'))
    expect(res.status).toBe(400)
  })
})

describe('GET /api/favorites/check', () => {
  it('type=album 查专辑收藏状态', async () => {
    const res = await checkRoute.GET(
      new NextRequest('http://localhost:3000/api/favorites/check?id=t1-album-9&type=album&source=tx'),
    )

    expect(res.status).toBe(200)
    expect(checkAlbumStarred).toHaveBeenCalledWith(7, 't1-album-9', 'tx')
    await expect(res.json()).resolves.toMatchObject({ data: { starred: true } })
  })

  it('缺省 type 仍查歌曲收藏状态', async () => {
    await checkRoute.GET(new NextRequest('http://localhost:3000/api/favorites/check?id=tx-abc'))

    expect(checkAlbumStarred).not.toHaveBeenCalled()
  })
})

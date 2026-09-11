import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { searchAlbums } = vi.hoisted(() => ({ searchAlbums: vi.fn() }))

vi.mock('@/lib/services/user-context', () => ({
  requireUser: vi.fn(async () => ({ username: 'tester' })),
  AuthError: class AuthError extends Error {},
}))
vi.mock('@/lib/services/album-service', () => ({
  searchAlbums,
  isAlbumSource: vi.fn((v: string | null) => v === 'wy' || v === 'kw' || v === 'mg'),
  ALBUM_SOURCES: ['wy', 'kw', 'mg'],
}))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { GET } = await import('./route')
const { requireUser, AuthError } = await import('@/lib/services/user-context')

function makeRequest(query: string) {
  return new NextRequest(`http://localhost:3000/api/search/album?${query}`)
}

const albums = [
  { source: 'wy', albumId: '1', name: '专辑一', singer: '歌手' },
  { source: 'kw', albumId: '2', name: '专辑二', singer: '歌手' },
]

describe('GET /api/search/album', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchAlbums.mockResolvedValue({ list: albums, total: 2, page: 1, allPage: 1, limit: 20, source: 'all' })
  })

  it('返回专辑搜索结果', async () => {
    const response = await GET(makeRequest('source=all&keyword=周杰伦'))

    expect(response.status).toBe(200)
    expect(searchAlbums).toHaveBeenCalledWith('all', '周杰伦', 1, 20)
    expect((await response.json()).data.list).toHaveLength(2)
  })

  it('缺少 keyword 返回 400', async () => {
    const response = await GET(makeRequest('source=wy'))

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('INVALID_PARAMS')
    expect(searchAlbums).not.toHaveBeenCalled()
  })

  it('不支持专辑搜索的音源返回 400', async () => {
    const response = await GET(makeRequest('source=tx&keyword=test'))

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('SOURCE_NOT_SUPPORTED')
  })

  it('limit 超出上限返回 400', async () => {
    const response = await GET(makeRequest('source=wy&keyword=test&limit=99'))

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('INVALID_PARAMS')
  })

  it('未登录返回 401', async () => {
    vi.mocked(requireUser).mockRejectedValueOnce(new AuthError('未登录'))

    const response = await GET(makeRequest('source=wy&keyword=test'))

    expect(response.status).toBe(401)
  })

  it('搜索失败返回 500', async () => {
    searchAlbums.mockRejectedValueOnce(new Error('上游请求失败'))

    const response = await GET(makeRequest('source=wy&keyword=test'))

    expect(response.status).toBe(500)
    expect((await response.json()).error.code).toBe('INTERNAL_ERROR')
  })
})

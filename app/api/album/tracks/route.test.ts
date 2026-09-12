import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { getAlbumTracks } = vi.hoisted(() => ({ getAlbumTracks: vi.fn() }))

vi.mock('@/lib/services/user-context', () => ({
  requireUser: vi.fn(async () => ({ username: 'tester' })),
  AuthError: class AuthError extends Error {},
}))
vi.mock('@/lib/services/album-service', () => ({
  getAlbumTracks,
  isAlbumSource: vi.fn((v: string | null) => v === 'wy' || v === 'kw' || v === 'mg'),
  ALBUM_SOURCES: ['wy', 'kw', 'mg'],
  AlbumTracksUnsupportedError: class AlbumTracksUnsupportedError extends Error {
    constructor(source: string) {
      super(`${source} 暂不支持专辑曲目`)
    }
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { GET } = await import('./route')
const { requireUser, AuthError } = await import('@/lib/services/user-context')
const { AlbumTracksUnsupportedError } = await import('@/lib/services/album-service')

function makeRequest(query: string) {
  return new NextRequest(`http://localhost:3000/api/album/tracks?${query}`)
}

const detail = {
  album: { source: 'wy', albumId: '123', name: '专辑', singer: '歌手', trackCount: 2 },
  list: [
    { uid: 'wy-1', name: '歌一', source: 'wy', songmid: '1' },
    { uid: 'wy-2', name: '歌二', source: 'wy', songmid: '2' },
  ],
}

describe('GET /api/album/tracks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAlbumTracks.mockResolvedValue(detail)
  })

  it('返回专辑详情与曲目', async () => {
    const response = await GET(makeRequest('source=wy&albumId=123'))

    expect(response.status).toBe(200)
    expect(getAlbumTracks).toHaveBeenCalledWith('wy', '123', { name: undefined, singer: undefined })
    const { album, list } = (await response.json()).data
    expect(album.albumId).toBe('123')
    expect(list.map((s: { uid: string }) => s.uid)).toEqual(['wy-1', 'wy-2'])
  })

  it('name/singer 直传给本地倒查入口', async () => {
    await GET(makeRequest('source=wy&albumId=18877&name=叶惠美&singer=周杰伦'))
    expect(getAlbumTracks).toHaveBeenCalledWith('wy', '18877', { name: '叶惠美', singer: '周杰伦' })
  })

  it('缺少 albumId 返回 400', async () => {
    const response = await GET(makeRequest('source=wy'))

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('INVALID_PARAMS')
    expect(getAlbumTracks).not.toHaveBeenCalled()
  })

  it('不支持的音源返回 400', async () => {
    const response = await GET(makeRequest('source=tx&albumId=123'))

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('SOURCE_NOT_SUPPORTED')
  })

  it('该源不支持专辑曲目时返回 unsupported 而非报错', async () => {
    getAlbumTracks.mockRejectedValueOnce(new AlbumTracksUnsupportedError('mg'))

    const response = await GET(makeRequest('source=mg&albumId=123'))

    expect(response.status).toBe(200)
    const data = (await response.json()).data
    expect(data.unsupported).toBe(true)
    expect(data.list).toEqual([])
    expect(data.album).toBeNull()
  })

  it('未登录返回 401', async () => {
    vi.mocked(requireUser).mockRejectedValueOnce(new AuthError('未登录'))

    const response = await GET(makeRequest('source=wy&albumId=123'))

    expect(response.status).toBe(401)
  })

  it('上游失败返回 500', async () => {
    getAlbumTracks.mockRejectedValueOnce(new Error('上游请求失败'))

    const response = await GET(makeRequest('source=wy&albumId=123'))

    expect(response.status).toBe(500)
    expect((await response.json()).error.code).toBe('INTERNAL_ERROR')
  })
})

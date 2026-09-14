import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { get, set } = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}))

vi.mock('@/lib/cache-manager', () => ({ searchCache: { get, set } }))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/services/itunes-service', () => ({
  appleT2S: vi.fn((v: string) => v),
}))

const amp = await import('./apple-amp-service')

const TOKEN = 'eyJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ.eyJzdG9yZWZyb250IjoiY24ifQ.c2lnbmF0dXJlX3BhZGRlZF9mb3JfdGVzdA'

/** 页面 → JS 包（内嵌 token）→ API 三段式 fetch mock */
function stubFetch(handlers: Record<string, unknown>) {
  return vi.fn(async (url: string | URL) => {
    const u = String(url)
    for (const [key, value] of Object.entries(handlers)) {
      if (u.includes(key)) {
        if (typeof value === 'function') return value(u)
        return {
          ok: true,
          status: 200,
          text: async () => String(value),
          json: async () => (typeof value === 'string' ? JSON.parse(value) : value),
        }
      }
    }
    throw new Error(`未 mock 的请求: ${u.slice(0, 80)}`)
  })
}

const pageWithToken = {
  'music.apple.com/cn/browse': '<html><script src="/assets/index~abc123.js"></script></html>',
  '/assets/index~abc123.js': `var x="${TOKEN}";`,
}

describe('token 管理（JS 包提取 + 401 续命）', () => {
  beforeEach(() => { get.mockReturnValue(undefined) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('从首页 JS 包提取公共 Bearer JWT', async () => {
    vi.stubGlobal('fetch', stubFetch(pageWithToken))
    const token = await amp.fetchAmpToken()
    expect(token).toBe(TOKEN)
  })

  it('JS 包无 token 返回 null（上层走 iTunes 回退）', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'music.apple.com/cn/browse': '<html><script src="/assets/index~abc123.js"></script></html>',
      '/assets/index~abc123.js': 'var noToken = true;',
    }))
    expect(await amp.fetchAmpToken()).toBeNull()
  })
})

describe('searchAmpArtists（results 键为单数 artist）', () => {
  beforeEach(() => { get.mockReturnValue(undefined) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('解析 results.artist.data，卡片带官方头像', async () => {
    const searchResp = {
      results: { artist: { href: '/v1/catalog/cn/search?...' } },
      resources: {
        artists: {
          '300117743': { id: '300117743', attributes: { name: '周杰伦', artwork: { url: 'https://mzstatic/x/{w}x{h}{c}.{f}' } } },
        },
      },
    }
    const fetchMock = stubFetch({ ...pageWithToken, 'amp-api-edge.music.apple.com': searchResp })
    vi.stubGlobal('fetch', fetchMock)
    const list = await amp.searchAmpArtists('周杰伦', 5)
    expect(list).toEqual([{ source: 'apple', artistId: '300117743', name: '周杰伦', pic: 'https://mzstatic/x/400x400bb.jpg' }])
    // 请求带 Bearer
    const apiCall = fetchMock.mock.calls.find(c => String(c[0]).includes('amp-api-edge'))
    expect((apiCall?.[1]?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
  })
})

describe('getAmpArtistDetail（一发全包解析）', () => {
  beforeEach(() => { get.mockReturnValue(undefined) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('歌手实体（头像/生日）+ 热门歌（试听）+ 专辑 + MV（预告）', async () => {
    const detailResp = {
      data: [{ id: '300117743', type: 'artists' }],
      resources: {
        artists: {
          '300117743': { attributes: { name: '周杰伦', bornOrFormed: '1979-01-18', artwork: { url: 'https://mzstatic/a/{w}x{h}{c}.{f}' } } },
        },
        songs: {
          s1: { attributes: { name: '晴天', artistName: '周杰伦', durationInMillis: 269000, previews: [{ url: 'https://audio-ssl/p.m4a' }] } },
        },
        albums: {
          '536114662': { attributes: { name: '七里香', artistName: '周杰伦', releaseDate: '2004-08-03', artwork: { url: 'https://mzstatic/b/{w}x{h}{c}.{f}' } } },
        },
        'music-videos': {
          v1: { attributes: { name: '圣诞星', artistName: '周杰伦', durationInMillis: 175000, releaseDate: '2023-12-01', artwork: { url: 'https://mzstatic/v/{w}x{h}{c}.{f}' }, previews: [{ url: 'https://video-ssl/p.m4v' }] } },
        },
      },
    }
    vi.stubGlobal('fetch', stubFetch({ ...pageWithToken, 'amp-api.music.apple.com/v1/catalog/cn/artists': detailResp }))
    const d = await amp.getAmpArtistDetail('300117743')
    expect(d?.artist).toMatchObject({ artistId: '300117743', name: '周杰伦', birthDate: '1979-01-18', img: 'https://mzstatic/a/600x600bb.jpg' })
    expect(d?.topSongs).toEqual([{ title: '晴天', artist: '周杰伦', secs: 269, previewUrl: 'https://audio-ssl/p.m4a' }])
    expect(d?.albums[0]).toMatchObject({ source: 'apple', albumId: '536114662', name: '七里香', year: '2004-08-03', img: 'https://mzstatic/b/300x300bb.jpg' })
    expect(d?.musicVideos[0]).toMatchObject({ id: 'v1', name: '圣诞星', durationSec: 175, artwork: 'https://mzstatic/v/640x360bb.jpg', previewUrl: 'https://video-ssl/p.m4v' })
  })
})

describe('getAmpArtistMvsByName（按名两跳）', () => {
  beforeEach(() => { get.mockReturnValue(undefined) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('search 命中歌手 → 详情 MV 列表', async () => {
    const handlers = {
      ...pageWithToken,
      'amp-api-edge.music.apple.com': {
        results: { artist: { href: '...' } },
        resources: { artists: { '266': { id: '266', attributes: { name: '林俊杰' } } } },
      },
      'amp-api.music.apple.com/v1/catalog/cn/artists/266': {
        resources: {
          artists: { '266': { attributes: { name: '林俊杰' } } },
          songs: {},
          'music-videos': {
            v1: { attributes: { name: '修炼爱情', artistName: '林俊杰', durationInMillis: 300000, previews: [{ url: 'https://video-ssl/x.m4v' }] } },
          },
        },
      },
    }
    vi.stubGlobal('fetch', stubFetch(handlers))
    const mvs = await amp.getAmpArtistMvsByName('林俊杰')
    expect(mvs).toHaveLength(1)
    expect(mvs[0]).toMatchObject({ name: '修炼爱情', previewUrl: 'https://video-ssl/x.m4v' })
  })

  it('搜索无结果返回空（客户端隐藏 MV 区）', async () => {
    vi.stubGlobal('fetch', stubFetch({
      ...pageWithToken,
      'amp-api-edge.music.apple.com': { results: { artist: { href: '...' } }, resources: { artists: {} } },
    }))
    expect(await amp.getAmpArtistMvsByName('不存在歌手')).toEqual([])
  })
})

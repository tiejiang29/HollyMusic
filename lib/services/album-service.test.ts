import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { get, set, kwSearch } = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  kwSearch: vi.fn(),
}))

vi.mock('@/lib/cache-manager', () => ({ searchCache: { get, set } }))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/music-core/music-search', () => ({ kw: { search: kwSearch } }))
vi.mock('@/lib/services/discovery-service', () => ({
  // 与真实实现同构的最小映射：保留入参结构并附加 uid
  toWyMusicInfo: vi.fn((raw: {
    id?: number
    name?: string
    ar?: Array<{ name?: string }>
    al?: { id?: number; name?: string }
    dt?: number
  }) => (raw.id ? {
    name: raw.name || '',
    singer: (raw.ar || []).map(a => a.name || '').filter(Boolean).join('、'),
    source: 'wy' as const,
    songmid: String(raw.id),
    albumId: raw.al?.id != null ? String(raw.al.id) : undefined,
    albumName: raw.al?.name,
    interval: String(Math.round((raw.dt || 0) / 1000)),
    types: [],
    _types: {},
    typeUrl: {},
  } : null)),
  toKwMusicInfo: vi.fn((raw: {
    id?: string | number
    name?: string
    artist?: string
    album?: string
    albumid?: string | number
    duration?: string | number
  }) => (raw.id ? {
    name: raw.name || '',
    singer: raw.artist || '',
    source: 'kw' as const,
    songmid: String(raw.id),
    albumId: raw.albumid != null ? String(raw.albumid) : undefined,
    albumName: raw.album,
    interval: String(raw.duration || 0),
    types: [],
    _types: {},
    typeUrl: {},
  } : null)),
  normalizeCover: vi.fn((v: string | undefined) => v || null),
  normalizeMgCover: vi.fn((v: string | undefined) => v || null),
  enrichMusicInfos: vi.fn(async (infos: Array<{ source: string; songmid: string }>) =>
    infos.map(mi => ({ ...mi, uid: `${mi.source}-${mi.songmid}` }))),
}))

const { searchAlbums, getAlbumTracks, AlbumTracksUnsupportedError, isAlbumSource, ALBUM_SOURCES } =
  await import('./album-service')

function jsonResponse(payload: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) }
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  get.mockReturnValue(undefined)
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isAlbumSource / ALBUM_SOURCES', () => {
  it('白名单只含三源', () => {
    expect(ALBUM_SOURCES).toEqual(['wy', 'kw', 'mg'])
    expect(isAlbumSource('wy')).toBe(true)
    expect(isAlbumSource('tx')).toBe(false)
    expect(isAlbumSource(null)).toBe(false)
  })
})

describe('searchAlbums wy', () => {
  const eapiPayload = {
    code: 200,
    result: {
      albumCount: 2,
      albums: [
        { id: 101, name: '叶惠美', publishTime: 1056931200000, size: 11, artist: { name: '周杰伦' }, picUrl: 'http://p1.music.126.net/a.jpg' },
        { id: 102, name: '七里香', publishTime: 1091836800000, size: 10, artists: [{ name: '周杰伦' }] },
      ],
    },
  }

  it('解析 eapi type=10 响应并缓存', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(eapiPayload))

    const result = await searchAlbums('wy', '周杰伦', 1, 20)

    expect(fetchMock.mock.calls[0][0]).toBe('http://interface.music.163.com/eapi/batch')
    const init = fetchMock.mock.calls[0][1]
    expect(init.method).toBe('POST')
    expect(new URLSearchParams(init.body).get('params')).toBeTruthy()
    expect(result.list[0]).toMatchObject({
      source: 'wy', albumId: '101', name: '叶惠美', singer: '周杰伦', img: 'http://p1.music.126.net/a.jpg',
      publishTime: '2003-06-30', trackCount: 11,
    })
    expect(result.total).toBe(2)
    expect(set).toHaveBeenCalledWith(
      'album:v1:search:wy:周杰伦:1:20', result, expect.any(Number),
    )
  })

  it('缓存命中时不请求上游', async () => {
    get.mockReturnValueOnce({ list: [], total: 0, page: 1, allPage: 0, limit: 20, source: 'wy' })

    const result = await searchAlbums('wy', '周杰伦')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.source).toBe('wy')
  })

  it('上游 code 非 200 抛错', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 400 }))

    await expect(searchAlbums('wy', '周杰伦')).rejects.toThrow('网易专辑搜索失败')
  })
})

describe('searchAlbums kw（歌曲搜索按专辑聚合）', () => {
  it('按 albumId 分组并按命中数排序', async () => {
    kwSearch.mockResolvedValueOnce({
      total: 5,
      list: [
        { songmid: 'a', singer: '歌手', albumId: '88', albumName: '热门专辑' },
        { songmid: 'b', singer: '歌手', albumId: '88', albumName: '热门专辑' },
        { songmid: 'c', singer: '歌手', albumId: '88', albumName: '热门专辑' },
        { songmid: 'd', singer: '歌手', albumId: '77', albumName: '冷门专辑' },
        { songmid: 'e', singer: '歌手', albumId: '', albumName: '' },
      ],
    })

    const result = await searchAlbums('kw', '歌手')

    expect(kwSearch).toHaveBeenCalledWith('歌手', 1, 20)
    expect(result.list).toEqual([
      { source: 'kw', albumId: '88', name: '热门专辑', singer: '歌手', img: null, trackCount: 3 },
      { source: 'kw', albumId: '77', name: '冷门专辑', singer: '歌手', img: null, trackCount: 1 },
    ])
    expect(result.total).toBe(5)
  })
})

describe('searchAlbums mg', () => {
  it('打开 album 开关并解析扁平 result', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      code: '000000',
      albumResultData: {
        totalCount: '41',
        result: [
          { id: '9001', name: '咪咕专辑', singer: '歌手A', publishDate: '2026-03-25', imgItems: [{ img: 'http://d.musicapp.migu.cn/cover.jpg', imgSizeType: '03' }] },
          { name: '无id脏数据' },
        ],
      },
    }))

    const result = await searchAlbums('mg', '周杰伦')

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('searchSwitch=')
    expect(decodeURIComponent(url)).toContain('"album":1')
    expect(result.list).toHaveLength(1)
    expect(result.list[0]).toMatchObject({
      source: 'mg', albumId: '9001', name: '咪咕专辑', singer: '歌手A',
      img: 'http://d.musicapp.migu.cn/cover.jpg', publishTime: '2026-03-25',
    })
    expect(result.total).toBe(41)
  })
})

describe('searchAlbums all（三源汇聚）', () => {
  it('按固定源顺序拼接并透出失败源', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      code: 200,
      result: { albumCount: 1, albums: [{ id: 101, name: '网易专辑', artist: { name: 'A' } }] },
    }))
    kwSearch.mockResolvedValueOnce({ total: 1, list: [{ songmid: 'a', singer: 'B', albumId: '88', albumName: '酷我专辑' }] })
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'FAIL' }))

    const result = await searchAlbums('all', 'x')

    expect(result.source).toBe('all')
    expect(result.list.map(a => a.source)).toEqual(['wy', 'kw'])
    expect(result.failedSources).toEqual(['mg'])
  })

  it('全部源失败时抛错', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'FAIL' }))
    kwSearch.mockRejectedValueOnce(new Error('kw down'))
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'FAIL' }))

    await expect(searchAlbums('all', 'x')).rejects.toThrow('所有音源专辑搜索失败')
  })
})

describe('getAlbumTracks wy', () => {
  const albumPayload = {
    code: 200,
    album: { id: 101, name: '叶惠美', picUrl: 'http://p1.music.126.net/album.jpg', publishTime: 1056931200000, artist: { name: '周杰伦' } },
    songs: [
      { id: 1, name: '以父之名', ar: [{ name: '周杰伦' }], al: { id: 101, name: '叶惠美' }, dt: 344000 },
      { id: 2, name: '懦夫', ar: [{ name: '周杰伦' }], al: { id: 101, name: '叶惠美' }, dt: 261000 },
    ],
  }

  it('映射曲目并入库附加 uid', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(albumPayload))

    const result = await getAlbumTracks('wy', '101')

    expect(fetchMock.mock.calls[0][0]).toBe('https://music.163.com/api/v1/album/101')
    expect(result.album).toMatchObject({
      source: 'wy', albumId: '101', name: '叶惠美', singer: '周杰伦', publishTime: '2003-06-30', trackCount: 2,
    })
    expect(result.list.map(s => s.uid)).toEqual(['wy-1', 'wy-2'])
    expect(result.list[0]).toMatchObject({ name: '以父之名', albumId: '101', albumName: '叶惠美' })
    expect(set).toHaveBeenCalledWith('album:v1:tracks:wy:101', result, expect.any(Number))
  })

  it('空曲目不写缓存', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 200, album: { id: 101, name: '空专辑' }, songs: [] }))

    const result = await getAlbumTracks('wy', '101')

    expect(result.list).toEqual([])
    expect(set).not.toHaveBeenCalled()
  })

  it('缓存命中时不请求上游', async () => {
    get.mockReturnValueOnce({ album: { source: 'wy', albumId: '101', name: 'cached' }, list: [] })

    await getAlbumTracks('wy', '101')

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('getAlbumTracks kw（SSR 页 NUXT 载荷）', () => {
  const albumInfo = {
    albumid: 456,
    name: '酷我专辑',
    artist: '歌手C',
    img: 'http://img4.kuwo.cn/star/albumcover/1.jpg',
    pub: '2003-07-31',
    songnum: 2,
    musiclist: [
      { id: '11', name: '歌一', artist: '歌手C', album: '酷我专辑', albumId: 456, duration: '213', formats: 'MP3128|ALFLAC|ZPGA714' },
      { musicrid: '22', songname: '歌二', artist: '歌手C', album: '酷我专辑', albumId: 456, duration: '188', formats: 'MP3128' },
    ],
  }
  const kwHtml = `<!doctype html><script>window.__NUXT__=(function(albumInfo,other){return {data:[{albumInfo}]}}(${JSON.stringify(albumInfo)},1));</script></body>`

  it('求值 NUXT 表达式并映射曲目', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => kwHtml, json: async () => ({}) })

    const result = await getAlbumTracks('kw', '456')

    expect(result.album).toMatchObject({
      source: 'kw', albumId: '456', name: '酷我专辑', singer: '歌手C', publishTime: '2003-07-31', trackCount: 2,
    })
    expect(result.list.map(s => s.uid)).toEqual(['kw-11', 'kw-22'])
    expect(result.list[0]).toMatchObject({ name: '歌一', albumId: '456', albumName: '酷我专辑' })
  })

  it('页面无 NUXT 载荷时抛错', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '<html>空白页</html>', json: async () => ({}) })

    await expect(getAlbumTracks('kw', '456')).rejects.toThrow('酷我专辑页无数据')
  })
})

describe('getAlbumTracks mg', () => {
  it('抛 AlbumTracksUnsupportedError', async () => {
    await expect(getAlbumTracks('mg', '9001')).rejects.toBeInstanceOf(AlbumTracksUnsupportedError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

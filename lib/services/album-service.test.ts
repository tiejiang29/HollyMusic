import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { get, set, searchOneSource, findLocalAlbum, findLocalAlbumByGid, getLocalAlbumTracks } = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  searchOneSource: vi.fn(),
  findLocalAlbum: vi.fn(),
  findLocalAlbumByGid: vi.fn(),
  getLocalAlbumTracks: vi.fn(),
}))

vi.mock('@/lib/cache-manager', () => ({ searchCache: { get, set } }))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/services/album-local-service', () => ({
  findLocalAlbum,
  findLocalAlbumByGid,
  getLocalAlbumTracks,
}))
vi.mock('@/lib/services/song-search-service', () => ({ searchOneSource }))

const { getLocalAlbumDetailByGid, getAlbumTracks, AlbumTracksUnsupportedError } = await import('./album-service')

function jsonResponse(payload: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => payload }
}

/** 构造一个能通过三重校验的候选歌（歌名包含、歌手含周杰伦、时长 ±8s 内） */
function song(name: string, interval: string, source = 'tx', singer = '周杰伦') {
  return { name, singer, source, songmid: `${source}-1`, albumName: '叶惠美', interval, img: null, types: [], _types: {}, typeUrl: {} }
}

const GID = '00112233-4455-6677-8899-aabbccddeeff'
const LOCAL_TRACKS = [
  { disc: 1, position: 1, title: '以父之名', titleNorm: '以父之名', secs: 342 },
  { disc: 1, position: 2, title: '懦夫', titleNorm: '懦夫', secs: null },
]
const LOCAL_ALBUM = { gid: GID, title: '叶惠美', artist: '周杰伦', trackCount: 2 }

beforeEach(() => {
  vi.clearAllMocks()
  get.mockReturnValue(undefined)
  findLocalAlbumByGid.mockReturnValue(LOCAL_ALBUM)
  getLocalAlbumTracks.mockReturnValue(LOCAL_TRACKS)
  findLocalAlbum.mockReturnValue(LOCAL_ALBUM)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getAlbumDetailByGid（本地专辑倒查）', () => {
  it('逐首搜曲按 tx→kw→kg→mg→wy 顺序，首个通过校验的即采用', async () => {
    // tx 永远返回不符候选（现场版时长不符/翻唱名不符），kw 返回正确候选——两首都不应走到 kg/wy
    searchOneSource.mockImplementation(async (source: string, keyword: string) => {
      const title = keyword.split(' ')[0]
      if (source === 'tx') return { list: [song('晴天翻唱', '04:00')], total: 1 }
      if (source === 'kw') {
        return { list: [song(title, title === '以父之名' ? '05:42' : '03:38')], total: 1 }
      }
      return { list: [], total: 0 }
    })

    const detail = await getLocalAlbumDetailByGid(GID)

    const calledSources = searchOneSource.mock.calls.map(c => c[0])
    expect(calledSources[0]).toBe('tx')
    expect(detail?.list.map(s => s.name)).toEqual(['以父之名', '懦夫'])
    expect(detail?.album).toMatchObject({ name: '叶惠美', singer: '周杰伦', trackCount: 2 })
  })

  it('时长超出 ±8s 的候选不采用', async () => {
    searchOneSource.mockImplementation(async (source: string) => {
      if (source === 'tx') return { list: [song('以父之名', '06:40')], total: 1 } // 400s vs 342s → 不符
      return { list: [], total: 0 }
    })

    const detail = await getLocalAlbumDetailByGid(GID)

    expect(detail).toBeNull()
  })

  it('本地音乐库已有同款歌（searchOneSource 缓存命中也算在线路径），全部未命中时返回 null', async () => {
    searchOneSource.mockResolvedValue({ list: [], total: 0 })

    const detail = await getLocalAlbumDetailByGid(GID)

    expect(detail).toBeNull()
    expect(searchOneSource).toHaveBeenCalledTimes(LOCAL_TRACKS.length * 5) // 五源全部尝试
  })

  it('gid 不在本地库返回 null', async () => {
    findLocalAlbumByGid.mockReturnValue(null)

    expect(await getLocalAlbumDetailByGid('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBeNull()
    expect(searchOneSource).not.toHaveBeenCalled()
  })

  it('无时长数据的曲目要求候选歌名与曲名有包含关系', async () => {
    // 懦夫 secs=null：tx 返回歌名完全无关的候选（同名歌手）→ 不采用
    searchOneSource.mockImplementation(async (source: string, keyword: string) => {
      const title = keyword.split(' ')[0]
      if (source === 'tx') return { list: [song('晴天翻唱', '04:00')], total: 1 }
      if (source === 'kw') return { list: [song(title, title === '以父之名' ? '05:42' : '03:38')], total: 1 }
      return { list: [], total: 0 }
    })

    const detail = await getLocalAlbumDetailByGid(GID)

    expect(detail?.list.map(s => s.name)).toEqual(['以父之名', '懦夫'])
    const calledSources = searchOneSource.mock.calls.map(c => c[0])
    expect(calledSources).not.toContain('kg') // kw 已全部命中，不到 kg
  })
})

describe('getAlbumTracks（在线兜底 + 本地优先入口）', () => {
  it('mg 无详情端点抛 AlbumTracksUnsupportedError', async () => {
    await expect(getAlbumTracks('mg', '25578')).rejects.toBeInstanceOf(AlbumTracksUnsupportedError)
  })

  it('带 name/singer 且本地命中时走倒查，不请求上游详情', async () => {
    searchOneSource.mockImplementation(async () => ({ list: [song('以父之名', '05:42')], total: 1 }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const detail = await getAlbumTracks('wy', '18877', { name: '叶惠美', singer: '周杰伦' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(detail.album.name).toBe('叶惠美')
    expect(findLocalAlbum).toHaveBeenCalledWith('叶惠美', '周杰伦')
  })

  it('不带 name/singer 时走 wy 原生详情', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      code: 200,
      album: { id: 18877, name: '叶惠美', picUrl: 'http://p1.music.126.net/a.jpg', publishTime: 1056931200000, artist: { name: '周杰伦' } },
      songs: [{ id: 1, name: '以父之名', ar: [{ name: '周杰伦' }], al: { id: 18877, name: '叶惠美' }, dt: 342000 }],
    })))

    const detail = await getAlbumTracks('wy', '18877')

    expect(detail.album).toMatchObject({ source: 'wy', name: '叶惠美', trackCount: 1 })
    expect(detail.list[0]).toMatchObject({ name: '以父之名', uid: 'wy-1' })
  })
})

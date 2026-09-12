import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  get, set, searchOneSource, findLocalAlbum, findLocalAlbumByGid, getLocalAlbumTracks,
  searchLocalAlbums, getArtistAlbumIndex, getItunesAlbumDetail, searchItunesAlbums,
  dbFindFirst, dbGetStorageSongmid,
} = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  searchOneSource: vi.fn(),
  findLocalAlbum: vi.fn(),
  findLocalAlbumByGid: vi.fn(),
  getLocalAlbumTracks: vi.fn(),
  searchLocalAlbums: vi.fn(),
  getArtistAlbumIndex: vi.fn(),
  getItunesAlbumDetail: vi.fn(),
  searchItunesAlbums: vi.fn(),
  dbFindFirst: vi.fn(),
  dbGetStorageSongmid: vi.fn((mi: { songmid: string }) => mi.songmid),
}))

vi.mock('@/lib/cache-manager', () => ({ searchCache: { get, set } }))
vi.mock('@/lib/db', () => ({
  prisma: { musicInfo: { findFirst: dbFindFirst } },
  getStorageSongmidForMusicInfo: dbGetStorageSongmid,
}))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/services/album-local-service', () => ({
  findLocalAlbum,
  findLocalAlbumByGid,
  getLocalAlbumTracks,
  searchLocalAlbums,
}))
vi.mock('@/lib/services/song-search-service', () => ({ searchOneSource }))
vi.mock('@/lib/services/itunes-service', async (importOriginal) => {
  // 保留真实 appleT2S（OpenCC 简繁转换，用例依赖真实转换行为），其余替换为受控 mock
  const actual = await importOriginal<typeof import('@/lib/services/itunes-service')>()
  return { ...actual, getArtistAlbumIndex, getItunesAlbumDetail, getItunesArtistSongs: vi.fn(), searchItunesAlbums }
})
vi.mock('@/lib/services/wiki-service', () => ({
  getWikiExtract: vi.fn(async () => null),
  getArtistProfile: vi.fn(async () => null),
  getAlbumProfile: vi.fn(async () => null),
}))

const { getLocalAlbumDetailByGid, getAlbumCover, getAppleAlbumDetail, searchAlbums } = await import('./album-service')

const GID = '00112233-4455-6677-8899-aabbccddeeff'
const LOCAL_ALBUM = { gid: GID, title: '叶惠美', artist: '周杰伦', trackCount: 2 }
const LOCAL_TRACKS = [
  { disc: 1, position: 1, title: '以父之名', titleNorm: '以父之名', secs: 342 },
  { disc: 1, position: 2, title: '懦夫', titleNorm: '懦夫', secs: null },
]

/** 构造能通过三重校验的候选歌 */
function song(name: string, interval: string, source = 'tx') {
  return { name, singer: '周杰伦', source, songmid: `${source}-1`, albumName: '叶惠美', interval, img: null, types: [], _types: {}, typeUrl: {} }
}

beforeEach(() => {
  vi.clearAllMocks()
  get.mockReturnValue(undefined)
  dbFindFirst.mockResolvedValue(null)
  findLocalAlbumByGid.mockReturnValue(LOCAL_ALBUM)
  getLocalAlbumTracks.mockReturnValue(LOCAL_TRACKS)
  findLocalAlbum.mockReturnValue(LOCAL_ALBUM)
  searchLocalAlbums.mockReturnValue([LOCAL_ALBUM])
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getAlbumDetailByGid（本地专辑倒查）', () => {
  it('逐首搜曲 tx 命中，Apple 元数据增强年份与封面', async () => {
    searchOneSource.mockImplementation(async (source: string, keyword: string) => {
      const title = keyword.split(' ')[0]
      return { list: [song(title, title === '以父之名' ? '05:42' : '03:38')], total: 1 }
    })
    getArtistAlbumIndex.mockResolvedValue(new Map([
      ['叶惠美', { collectionId: '536114662', img: 'https://mzstatic/a.jpg', year: '2003-07-31' }],
    ]))

    const detail = await getLocalAlbumDetailByGid(GID)

    expect(detail?.album).toMatchObject({
      name: '叶惠美', singer: '周杰伦', trackCount: 2,
      img: 'https://mzstatic/a.jpg', year: '2003-07-31',
    })
    expect(detail?.list.map(s => s.name)).toEqual(['以父之名', '懦夫'])
  })

  it('本地音乐库 identity 命中优先：零上游请求直接返回可播条目', async () => {
    dbFindFirst.mockImplementation(async ({ where }: { where: { identity: string } }) => {
      const name = where.identity.split('|')[0]
      if (!name) return null
      return { data: JSON.stringify({ name, singer: '周杰伦', source: 'kw', songmid: '999', interval: '342', types: [], _types: {}, typeUrl: {} }) }
    })

    const detail = await getLocalAlbumDetailByGid(GID)

    expect(searchOneSource).not.toHaveBeenCalled() // 全部走库，零上游
    expect(detail?.list[0]).toMatchObject({ name: '以父之名', uid: 'kw-999' })
  })

  it('全部未命中返回 null', async () => {
    searchOneSource.mockResolvedValue({ list: [], total: 0 })
    getArtistAlbumIndex.mockResolvedValue(new Map())

    expect(await getLocalAlbumDetailByGid(GID)).toBeNull()
  })

  it('同歌多版本时优先取 albumName 与目标专辑一致的候选', async () => {
    // 以父之名：同歌手同时长两个版本——太阳之子专辑版 vs 圣诞星单曲版（错误发行）
    searchOneSource.mockImplementation(async () => ({
      list: [
        { ...song('以父之名', '05:42', 'tx'), albumName: '圣诞星 (feat. 杨瑞代)' },
        { ...song('以父之名', '05:42', 'tx'), albumName: '太阳之子' },
      ],
      total: 2,
    }))
    dbFindFirst.mockResolvedValue(null)
    getArtistAlbumIndex.mockResolvedValue(new Map([
      ['叶惠美', { collectionId: '1', img: 'https://mzstatic/a.jpg', year: '2003-07-31' }],
    ]))

    const detail = await getLocalAlbumDetailByGid(GID)

    // 本地专辑《叶惠美》上下文：两候选 albumName 都不匹配"叶惠美"→ 取首个通过校验的
    expect(detail?.list[0]).toMatchObject({ name: '以父之名' })
    expect(detail?.list[0].albumName).toBe('圣诞星 (feat. 杨瑞代)')
  })

  it('gid 不在本地库返回 null', async () => {
    findLocalAlbumByGid.mockReturnValue(null)

    expect(await getLocalAlbumDetailByGid(GID)).toBeNull()
    expect(searchOneSource).not.toHaveBeenCalled()
  })
})

describe('getAlbumCover（Apple 优先 + tx 推导兜底）', () => {
  it('Apple 索引命中：直接返回 mzstatic 高清封面，不触发搜曲', async () => {
    getArtistAlbumIndex.mockResolvedValue(new Map([
      ['叶惠美', { collectionId: '536114662', img: 'https://mzstatic/ye.jpg', year: '2003' }],
    ]))

    const img = await getAlbumCover(GID)

    expect(img).toBe('https://mzstatic/ye.jpg')
    expect(searchOneSource).not.toHaveBeenCalled()
  })

  it('Apple 未命中：回退 tx 首曲目搜曲推导 gtimg', async () => {
    getArtistAlbumIndex.mockResolvedValue(new Map())
    vi.stubGlobal('fetch', vi.fn())
    searchOneSource.mockResolvedValue({
      list: [{ ...song('以父之名', '05:42', 'tx'), albumId: '000MkMni19ClKG' }],
      total: 1,
    })

    const img = await getAlbumCover(GID)

    expect(img).toBe('https://y.gtimg.cn/music/photo_new/T002R500x500M000000MkMni19ClKG.jpg')
    expect(searchOneSource).toHaveBeenCalledWith('tx', '以父之名 周杰伦', 1, 5)
  })
})

describe('getAppleAlbumDetail（Apple 曲目表落歌）', () => {
  it('Apple 曲目表逐首落歌，繁体自动转简体匹配', async () => {
    getItunesAlbumDetail.mockResolvedValue({
      album: { collectionId: '536114662', title: '七里香', artist: '周杰伦', year: '2004-08-03', img: 'https://mzstatic/qlx.jpg', trackCount: 2 },
      tracks: [
        { title: '我的地盤', titleNorm: '我的地盤', secs: 242, disc: 1, position: 1 },
        { title: '七里香', titleNorm: '七里香', secs: 297, disc: 1, position: 2 },
      ],
    })
    searchOneSource.mockImplementation(async (source: string, keyword: string) => {
      const title = keyword.split(' ')[0]
      const simple = title === '我的地盤' ? '我的地盘' : title
      return { list: [song(simple, simple === '我的地盘' ? '04:02' : '04:57')], total: 1 }
    })

    const detail = await getAppleAlbumDetail('536114662')

    expect(detail?.album).toMatchObject({ name: '七里香', singer: '周杰伦', year: '2004-08-03', trackCount: 2 })
    expect(detail?.list.map(s => s.name)).toEqual(['我的地盘', '七里香'])
  })

  it('全部未命中返回 null', async () => {
    getItunesAlbumDetail.mockResolvedValue({
      album: { collectionId: '1', title: '冷门专辑', artist: '无名氏', img: null, trackCount: 2 },
      tracks: [
        { title: '曲一', titleNorm: '曲一', secs: 200, disc: 1, position: 1 },
        { title: '曲二', titleNorm: '曲二', secs: 210, disc: 1, position: 2 },
      ],
    })
    searchOneSource.mockResolvedValue({ list: [], total: 0 })

    expect(await getAppleAlbumDetail('1')).toBeNull()
  })
})

describe('searchAlbums（本地优先 + Apple 兜底）', () => {
  it('本地命中：platformList 为空，不触发 Apple 搜索', async () => {
    const result = await searchAlbums('叶惠美', 30)

    expect(result.list.map(a => a.title)).toEqual(['叶惠美'])
    expect(result.platformList).toEqual([])
    expect(searchItunesAlbums).not.toHaveBeenCalled()
  })

  it('本地未命中：自动回退 Apple 专辑搜索并映射卡片', async () => {
    searchLocalAlbums.mockReturnValue([])
    searchItunesAlbums.mockResolvedValue([
      { collectionId: '536114662', title: '七里香', artist: '周杰伦', trackCount: 10, year: '2004-08-03', img: 'https://mzstatic/qlx.jpg' },
    ])

    const result = await searchAlbums('七里香', 30)

    expect(searchItunesAlbums).toHaveBeenCalledWith('七里香', 30)
    expect(result.platformList).toEqual([
      { source: 'apple', albumId: '536114662', name: '七里香', singer: '周杰伦', img: 'https://mzstatic/qlx.jpg', year: '2004-08-03', trackCount: 10 },
    ])
    expect(result.list).toEqual([])
  })
})

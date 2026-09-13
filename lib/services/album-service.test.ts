import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  get, set, searchOneSource, findLocalAlbum, findLocalAlbumByGid, getLocalAlbumTracks,
  searchLocalAlbums, getArtistAlbumIndex, getItunesAlbumDetail, searchItunesAlbums,
  dbFindFirst, dbGetStorageSongmid, batchResolveAndUpsert,
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
  batchResolveAndUpsert: vi.fn(),
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
vi.mock('@/lib/services/batch-resolve', () => ({ batchResolveAndUpsert }))
vi.mock('@/lib/services/itunes-service', async (importOriginal) => {
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

/** 构造可播 Song */
function resolvedSong(name: string, source = 'tx') {
  return { name, singer: '周杰伦', source, songmid: `${source}-1`, albumName: '叶惠美', interval: '05:42', img: null, uid: `${source}-1`, types: [], _types: {}, typeUrl: {} }
}

beforeEach(() => {
  vi.clearAllMocks()
  get.mockReturnValue(undefined)
  dbFindFirst.mockResolvedValue(null)
  batchResolveAndUpsert.mockResolvedValue([])
  findLocalAlbumByGid.mockReturnValue(LOCAL_ALBUM)
  getLocalAlbumTracks.mockReturnValue(LOCAL_TRACKS)
  findLocalAlbum.mockReturnValue(LOCAL_ALBUM)
  searchLocalAlbums.mockReturnValue([LOCAL_ALBUM])
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getLocalAlbumDetailByGid（本地专辑倒查）', () => {
  it('批量解析调用正确参数，Apple 元数据增强年份与封面', async () => {
    batchResolveAndUpsert.mockResolvedValue([resolvedSong('以父之名'), resolvedSong('懦夫', 'kw')])
    getArtistAlbumIndex.mockResolvedValue(new Map([
      ['叶惠美', { collectionId: '536114662', img: 'https://mzstatic/a.jpg', year: '2003-07-31' }],
    ]))

    const detail = await getLocalAlbumDetailByGid(GID)

    // 验证 batchResolveAndUpsert 收到正确参数（曲目表+歌手+专辑名）
    expect(batchResolveAndUpsert).toHaveBeenCalledWith(
      LOCAL_TRACKS, '周杰伦', '叶惠美',
    )
    expect(detail?.album).toMatchObject({
      name: '叶惠美', singer: '周杰伦', trackCount: 2,
      img: 'https://mzstatic/a.jpg', year: '2003-07-31',
    })
    expect(detail?.list.map(s => s.name)).toEqual(['以父之名', '懦夫'])
  })

  it('批量解析全部未命中返回 null', async () => {
    batchResolveAndUpsert.mockResolvedValue([])

    expect(await getLocalAlbumDetailByGid(GID)).toBeNull()
  })

  it('gid 不在本地库返回 null', async () => {
    findLocalAlbumByGid.mockReturnValue(null)

    expect(await getLocalAlbumDetailByGid(GID)).toBeNull()
    expect(batchResolveAndUpsert).not.toHaveBeenCalled()
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
      list: [{ ...resolvedSong('以父之名'), source: 'tx', albumId: '000MkMni19ClKG' }],
      total: 1,
    })

    const img = await getAlbumCover(GID)

    expect(img).toBe('https://y.gtimg.cn/music/photo_new/T002R500x500M000000MkMni19ClKG.jpg')
    expect(searchOneSource).toHaveBeenCalledWith('tx', '以父之名 周杰伦', 1, 5)
  })
})

describe('getAppleAlbumDetail（Apple 曲目表批量落歌）', () => {
  it('Apple 曲目表批量解析，正确传递参数', async () => {
    getItunesAlbumDetail.mockResolvedValue({
      album: { collectionId: '536114662', title: '七里香', artist: '周杰伦', year: '2004-08-03', img: 'https://mzstatic/qlx.jpg', trackCount: 2 },
      tracks: [
        { title: '我的地盘', titleNorm: '我的地盘', secs: 242, disc: 1, position: 1 },
        { title: '七里香', titleNorm: '七里香', secs: 297, disc: 1, position: 2 },
      ],
    })
    batchResolveAndUpsert.mockResolvedValue([
      { ...resolvedSong('我的地盘'), name: '我的地盘' },
      { ...resolvedSong('七里香'), name: '七里香' },
    ])

    const detail = await getAppleAlbumDetail('536114662')

    expect(batchResolveAndUpsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ title: '我的地盘', secs: 242 }),
        expect.objectContaining({ title: '七里香', secs: 297 }),
      ]),
      '周杰伦',
      '七里香',
    )
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
    batchResolveAndUpsert.mockResolvedValue([])

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

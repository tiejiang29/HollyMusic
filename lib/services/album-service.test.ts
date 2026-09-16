import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  get, set, searchOneSource,
  getArtistAlbumIndex, getItunesAlbumDetail, searchItunesAlbums,
  dbFindFirst, dbGetStorageSongmid, batchResolveAndUpsert,
  searchKwArtists, searchKwAlbums, findKwAlbumId, getKwAlbumDetail, upsertMusicInfosInTransaction,
  findMgAlbumId, getMgAlbumDetail, searchMgArtists, searchMgAlbums, searchAlbumCardsChain,
} = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  searchOneSource: vi.fn(),
  getArtistAlbumIndex: vi.fn(),
  getItunesAlbumDetail: vi.fn(),
  searchItunesAlbums: vi.fn(),
  dbFindFirst: vi.fn(),
  dbGetStorageSongmid: vi.fn((mi: { songmid: string }) => mi.songmid),
  batchResolveAndUpsert: vi.fn(),
  searchKwArtists: vi.fn(async () => []),
  searchKwAlbums: vi.fn(),
  findKwAlbumId: vi.fn(),
  getKwAlbumDetail: vi.fn(),
  upsertMusicInfosInTransaction: vi.fn(),
  findMgAlbumId: vi.fn(async () => null),
  getMgAlbumDetail: vi.fn(async () => null),
  searchMgArtists: vi.fn(async () => []),
  searchMgAlbums: vi.fn(async () => []),
  searchAlbumCardsChain: vi.fn(async () => []),
}))

vi.mock('@/lib/cache-manager', () => ({ searchCache: { get, set } }))
vi.mock('@/lib/db', () => ({
  prisma: { musicInfo: { findFirst: dbFindFirst } },
  getStorageSongmidForMusicInfo: dbGetStorageSongmid,
  upsertMusicInfosInTransaction,
}))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/services/source-chain', () => ({ searchAlbumCardsChain }))
vi.mock('@/lib/services/song-search-service', () => ({ searchOneSource }))
vi.mock('@/lib/services/batch-resolve', () => ({ batchResolveAndUpsert }))
vi.mock('@/lib/services/apple-amp-service', () => ({
  getAmpArtistDetail: vi.fn(async () => null),
  getAmpAlbumDetail: vi.fn(async () => null),
}))
vi.mock('@/lib/services/kw-chain-service', () => ({
  searchKwArtists,
  searchKwAlbums,
  findKwAlbumId,
  getKwAlbumDetail,
}))
vi.mock('@/lib/services/tx-chain-service', () => ({
  findTxAlbumId: vi.fn(async () => null),
  getTxAlbumDetail: vi.fn(async () => null),
}))
vi.mock('@/lib/services/mg-chain-service', () => ({
  findMgAlbumId,
  getMgAlbumDetail,
  searchMgArtists,
  searchMgAlbums,
}))
vi.mock('@/lib/services/itunes-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/itunes-service')>()
  return { ...actual, getArtistAlbumIndex, getItunesAlbumDetail, getItunesArtistSongs: vi.fn(), searchItunesAlbums }
})
vi.mock('@/lib/services/wiki-service', () => ({
  getWikiExtract: vi.fn(async () => null),
  getArtistProfile: vi.fn(async () => null),
  getAlbumProfile: vi.fn(async () => null),
}))

const { getAppleAlbumDetail, searchAlbums } = await import('./album-service')


/** 构造可播 Song */
function resolvedSong(name: string, source = 'tx') {
  return { name, singer: '周杰伦', source, songmid: `${source}-1`, albumName: '叶惠美', interval: '05:42', img: null, uid: `${source}-1`, types: [], _types: {}, typeUrl: {} }
}

beforeEach(() => {
  vi.clearAllMocks()
  get.mockReturnValue(undefined)
  dbFindFirst.mockResolvedValue(null)
  batchResolveAndUpsert.mockResolvedValue([])
  searchKwAlbums.mockResolvedValue([])
  findKwAlbumId.mockResolvedValue(null)
  getKwAlbumDetail.mockResolvedValue(null)
  searchAlbumCardsChain.mockResolvedValue([])
  upsertMusicInfosInTransaction.mockResolvedValue([])
})
afterEach(() => {
  vi.unstubAllGlobals()
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

describe('searchAlbums（平台链 TX → 酷我 → 咪咕 → Apple）', () => {
  it('命中 TX：映射 tx 卡片，list 恒为空（本地专辑库已下线）', async () => {
    searchAlbumCardsChain.mockResolvedValue([
      { source: 'tx', albumId: '000MkMni19ClKG', name: '叶惠美', artist: '周杰伦', pic: 'https://y.gtimg.cn/500.jpg', img: 'https://y.gtimg.cn/500.jpg' },
    ])

    const result = await searchAlbums('叶惠美', 30)

    expect(searchAlbumCardsChain).toHaveBeenCalledWith('叶惠美', 30)
    expect(result.list).toEqual([])
    expect(result.platformList).toEqual([
      { source: 'tx', albumId: '000MkMni19ClKG', name: '叶惠美', singer: '周杰伦', img: 'https://y.gtimg.cn/500.jpg' },
    ])
  })

  it('命中酷我：映射 kw 卡片（含 year/img）', async () => {
    searchAlbumCardsChain.mockResolvedValue([
      { source: 'kw', albumId: '4533', name: '七里香', artist: '周杰伦', pic: 'https://img1.kuwo.cn/300/qlx.jpg', img: 'https://img1.kuwo.cn/300/qlx.jpg', year: '2004-08-03' },
    ])

    const result = await searchAlbums('七里香', 30)

    expect(result.platformList).toEqual([
      { source: 'kw', albumId: '4533', name: '七里香', singer: '周杰伦', img: 'https://img1.kuwo.cn/300/qlx.jpg', year: '2004-08-03' },
    ])
  })

  it('Apple 兜底：映射 collectionId 卡片并带 trackCount', async () => {
    searchAlbumCardsChain.mockResolvedValue([
      { source: 'apple', albumId: '536114662', name: '七里香', artist: '周杰伦', img: 'https://mzstatic/qlx.jpg', year: '2004-08-03', trackCount: 10 },
    ])

    const result = await searchAlbums('七里香', 30)

    expect(result.platformList).toEqual([
      { source: 'apple', albumId: '536114662', name: '七里香', singer: '周杰伦', img: 'https://mzstatic/qlx.jpg', year: '2004-08-03', trackCount: 10 },
    ])
  })

  it('链抛错时静默返回空 platformList（不冒泡 500）', async () => {
    searchAlbumCardsChain.mockRejectedValue(new Error('boom'))

    const result = await searchAlbums('七里香', 30)

    expect(result.platformList).toEqual([])
    expect(result.list).toEqual([])
  })
})

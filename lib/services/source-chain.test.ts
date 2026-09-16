import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { searchKwArtists, searchKwAlbums } = vi.hoisted(() => ({
  searchKwArtists: vi.fn(),
  searchKwAlbums: vi.fn(),
}))
const { searchMgArtists, searchMgAlbums } = vi.hoisted(() => ({
  searchMgArtists: vi.fn(),
  searchMgAlbums: vi.fn(),
}))
const { searchItunesArtists, searchItunesAlbums } = vi.hoisted(() => ({
  searchItunesArtists: vi.fn(),
  searchItunesAlbums: vi.fn(),
}))
const { searchTxAlbums } = vi.hoisted(() => ({ searchTxAlbums: vi.fn() }))

vi.mock('@/lib/services/tx-chain-service', () => ({
  searchTxArtists: vi.fn(async () => []),
  searchTxAlbums,
}))
vi.mock('@/lib/services/kw-chain-service', () => ({ searchKwArtists, searchKwAlbums }))
vi.mock('@/lib/services/mg-chain-service', () => ({ searchMgArtists, searchMgAlbums }))
vi.mock('@/lib/services/apple-amp-service', () => ({
  searchAmpArtists: vi.fn(async () => []),
}))
vi.mock('@/lib/services/itunes-service', () => ({
  searchItunesArtists,
  searchItunesAlbums,
  appleT2S: vi.fn((v: string) => v.replace('師', '师')),
}))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { searchArtistCardsChain, searchAlbumCardsChain } = await import('./source-chain')

beforeEach(() => {
  vi.clearAllMocks()
  searchKwArtists.mockResolvedValue([])
  searchMgArtists.mockResolvedValue([])
  searchItunesArtists.mockResolvedValue([])
  searchKwAlbums.mockResolvedValue([])
  searchMgAlbums.mockResolvedValue([])
  searchItunesAlbums.mockResolvedValue([])
  searchTxAlbums.mockResolvedValue([])
})
afterEach(() => { vi.unstubAllGlobals() })

describe('searchArtistCardsChain（kw完全匹配→mg→apple→模糊兜底）', () => {
  it('酷我有完全匹配 → 用酷我（咪咕结果丢弃但已预取缓存）', async () => {
    searchKwArtists.mockResolvedValue([{ source: 'kw', artistId: '336', name: '周杰伦', pic: null, musicNum: 1709 }])
    searchMgArtists.mockResolvedValue([{ source: 'mg', artistId: '112', name: '周杰伦', pic: null }])
    const r = await searchArtistCardsChain('周杰伦', 10)
    expect(r.source).toBe('kw')
    expect(r.list[0]).toMatchObject({ source: 'kw', artistId: '336' })
  })

  it('酷我仅模糊（同名变体）→ 咪咕有完全匹配 → 切咪咕（用户规则）', async () => {
    searchKwArtists.mockResolvedValue([{ source: 'kw', artistId: '999', name: '周杰伦战队', pic: null }])
    searchMgArtists.mockResolvedValue([{ source: 'mg', artistId: '112', name: '周杰伦', pic: null }])
    const r = await searchArtistCardsChain('周杰伦', 10)
    expect(r.source).toBe('mg')
    expect(r.list[0]).toMatchObject({ source: 'mg', artistId: '112' })
  })

  it('繁简归一参与完全匹配（kw 繁体结果视为匹配）', async () => {
    searchKwArtists.mockResolvedValue([{ source: 'kw', artistId: '74016', name: '米津玄師', pic: null }])
    searchMgArtists.mockResolvedValue([])
    const r = await searchArtistCardsChain('米津玄师', 10)
    expect(r.source).toBe('kw')
  })

  it('两链均无完全匹配 → Apple 兜底', async () => {
    searchKwArtists.mockResolvedValue([{ source: 'kw', artistId: '1', name: '完全无关', pic: null }])
    searchMgArtists.mockResolvedValue([{ source: 'mg', artistId: '2', name: '也不匹配', pic: null }])
    searchItunesArtists.mockResolvedValue([{ artistId: '12345', name: '目标歌手', genre: 'Pop' }])
    const r = await searchArtistCardsChain('目标歌手', 10)
    expect(r.source).toBe('apple')
    expect(r.list[0]).toMatchObject({ source: 'apple', artistId: '12345' })
  })

  it('三链全无 → 模糊兜底返回酷我模糊结果（不返回空）', async () => {
    searchKwArtists.mockResolvedValue([{ source: 'kw', artistId: '1', name: '模糊结果', pic: null }])
    const r = await searchArtistCardsChain('不存在的歌手', 10)
    expect(r.source).toBe('kw')
    expect(r.list).toHaveLength(1)
  })
})

describe('searchAlbumCardsChain（TX → 酷我 → 咪咕 → Apple）', () => {
  it('TX 命中 → 直接用 TX 卡片（不再往下问酷我/咪咕）', async () => {
    searchTxAlbums.mockResolvedValue([
      { source: 'tx', albumId: '000MkMni19ClKG', name: '叶惠美', artist: '周杰伦', pic: 'https://y.gtimg.cn/500.jpg', img: 'https://y.gtimg.cn/500.jpg' },
    ])
    searchKwAlbums.mockResolvedValue([{ source: 'kw', albumId: '1293', name: '叶惠美', artist: '周杰伦', pic: null, img: null }])
    const list = await searchAlbumCardsChain('叶惠美', 30)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ source: 'tx', albumId: '000MkMni19ClKG' })
  })

  it('TX 未命中（同名翻唱）→ 切酷我命中', async () => {
    searchTxAlbums.mockResolvedValue([{ source: 'tx', albumId: 'x', name: '叶惠美 翻唱版', artist: '路人', pic: null, img: null }])
    searchKwAlbums.mockResolvedValue([{ source: 'kw', albumId: '1293', name: '叶惠美', artist: '周杰伦', pic: null, img: null }])
    const list = await searchAlbumCardsChain('叶惠美', 30)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ source: 'kw', albumId: '1293' })
  })

  it('TX/酷我均无完全匹配 → 切咪咕命中', async () => {
    searchTxAlbums.mockResolvedValue([{ source: 'tx', albumId: 'x', name: '叶惠美 翻唱版', artist: '路人', pic: null, img: null }])
    searchKwAlbums.mockResolvedValue([{ source: 'kw', albumId: '1', name: '七里香 翻唱版', artist: '路人', pic: null, img: null }])
    searchMgAlbums.mockResolvedValue([{ source: 'mg', albumId: '7949', name: '叶惠美', artist: '周杰伦', pic: null, img: null, year: '2003-07-31' }])
    const list = await searchAlbumCardsChain('叶惠美', 30)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ source: 'mg', albumId: '7949' })
  })

  it('「专辑名 歌手」分词命中：整串比不相等也要命中 TX', async () => {
    searchTxAlbums.mockResolvedValue([
      { source: 'tx', albumId: '000MkMni19ClKG', name: '叶惠美', artist: '周杰伦', pic: null, img: null },
    ])
    const list = await searchAlbumCardsChain('叶惠美 周杰伦', 30)
    expect(list[0]).toMatchObject({ source: 'tx', albumId: '000MkMni19ClKG' })
  })

  it('三家都未命中 → Apple 兜底', async () => {
    searchTxAlbums.mockResolvedValue([{ source: 'tx', albumId: 'x', name: '叶惠美 翻唱版', artist: '路人', pic: null, img: null }])
    searchItunesAlbums.mockResolvedValue([{ collectionId: '535824731', title: '叶惠美', artist: '周杰伦', img: 'https://mzstatic/a.jpg', year: '2003-07-31', trackCount: 11 }])
    const list = await searchAlbumCardsChain('叶惠美', 30)
    expect(list[0]).toMatchObject({ source: 'apple', albumId: '535824731' })
  })
})

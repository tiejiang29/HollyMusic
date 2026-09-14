import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { get, set, dbUpsert, dbGetStorageSongmid } = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  dbUpsert: vi.fn(),
  dbGetStorageSongmid: vi.fn((mi: { source: string; songmid: string }) => mi.songmid),
}))

vi.mock('@/lib/cache-manager', () => ({ searchCache: { get, set } }))
vi.mock('@/lib/db', () => ({
  upsertMusicInfosInTransaction: dbUpsert,
  getStorageSongmidForMusicInfo: dbGetStorageSongmid,
}))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/services/itunes-service', () => ({
  appleT2S: vi.fn((v: string) => v),
}))

const tx = await import('./tx-chain-service')

describe('txSongToMusicInfo（App 协议 songItem 映射，与 music-core tx 同构）', () => {
  it('songmid=mid、strMediaMid、T002 封面公式、音质映射', () => {
    const mi = tx.txSongToMusicInfo({
      mid: '0039MnYb0qxYhV',
      name: '晴天',
      interval: 269,
      singer: [{ mid: '0025NhlN2yWrP4', name: '周杰伦' }],
      album: { mid: '000MkMni19ClKG', name: '叶惠美', time_public: '2003-07-31' },
      file: { media_mid: 'B3A52A7A958BF0AE', size_128mp3: 4317292, size_320mp3: 10875547, size_flac: 27670036 },
    })
    expect(mi).toMatchObject({
      source: 'tx', songmid: '0039MnYb0qxYhV', strMediaMid: 'B3A52A7A958BF0AE',
      name: '晴天', singer: '周杰伦', albumName: '叶惠美',
      albumId: '000MkMni19ClKG', interval: '04:29',
      img: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000000MkMni19ClKG.jpg',
    })
    expect(mi?.types.map(t => t.type)).toEqual(['128k', '320k', 'flac'])
  })

  it('缺 mid/media_mid 返回 null', () => {
    expect(tx.txSongToMusicInfo({ name: '无id' })).toBeNull()
    expect(tx.txSongToMusicInfo({ mid: 'x', name: 'y', file: {} })).toBeNull()
  })
})

describe('接口解析（fetch mock）', () => {
  beforeEach(() => {
    get.mockReturnValue(undefined)
    dbUpsert.mockResolvedValue([])
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const smartboxJson = (singers: unknown) => ({ code: 0, data: { singer: { itemlist: singers } } })

  it('searchTxArtists：smartbox singer 区块 + 头像 150→300px 升级', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.includes('smartbox')) {
        return { ok: true, json: async () => smartboxJson([
          { mid: '0025NhlN2yWrP4', name: '周杰伦', pic: 'http://y.gtimg.cn/music/photo_new/T001R150x150M0000025NhlN2yWrP4_11.jpg' },
        ]) }
      }
      throw new Error('未mock: ' + u.slice(0, 60))
    }))
    const list = await tx.searchTxArtists('周杰伦', 5)
    expect(list).toEqual([{
      source: 'tx', artistId: '0025NhlN2yWrP4', name: '周杰伦',
      pic: 'http://y.gtimg.cn/music/photo_new/T001R300x300M0000025NhlN2yWrP4_11.jpg',
      img: 'http://y.gtimg.cn/music/photo_new/T001R300x300M0000025NhlN2yWrP4_11.jpg',
    }])
  })

  it('getTxArtistSongs：singer[].mid 精确过滤（同名歌手免疫）', async () => {
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++
      if (call > 1) return { ok: true, json: async () => ({ code: 0, req: { code: 0, data: { body: { item_song: [] } } } }) }
      return {
        ok: true,
        json: async () => ({
          code: 0,
          req: { code: 0, data: { body: { item_song: [
            { mid: 's1', name: '晴天', interval: 269, singer: [{ mid: '0025NhlN2yWrP4', name: '周杰伦' }], album: { mid: 'a1', name: '叶惠美' }, file: { media_mid: 'm1', size_128mp3: 1 } },
            { mid: 's2', name: '晴天翻唱', interval: 269, singer: [{ mid: '999other', name: '别人' }], album: { mid: 'a2', name: 'x' }, file: { media_mid: 'm2', size_128mp3: 1 } },
          ] } } },
        }),
      }
    }))
    const songs = await tx.getTxArtistSongs('0025NhlN2yWrP4', '周杰伦')
    expect(songs).toHaveLength(1)
    expect(songs?.[0]).toMatchObject({ name: '晴天', source: 'tx', songmid: 's1' })
  })

  it('getTxAlbumDetail：GetAlbumSongList songList[].songInfo 解析', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        req_0: { code: 0, data: { songList: [
          { songInfo: { mid: 't1', name: '我的地盘', interval: 245, singer: [{ name: '周杰伦' }], album: { mid: '000MkMni19ClKG', name: '范特西' }, file: { media_mid: 'x1', size_320mp3: 2 } } },
        ], totalNum: 10 } },
      }),
    })))
    const d = await tx.getTxAlbumDetail('000MkMni19ClKG')
    expect(d?.tracks).toHaveLength(1)
    expect(d?.tracks[0]).toMatchObject({ name: '我的地盘', songmid: 't1', albumName: '范特西', interval: '04:05' })
  })

  it('findTxAlbumId：专辑名+歌手双校验', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        req: { code: 0, data: { body: { item_song: [
          { mid: 'q1', name: '爱在西元前', interval: 234, singer: [{ mid: '0025NhlN2yWrP4', name: '周杰伦' }], album: { mid: '000MkMni19ClKG', name: '范特西' }, file: { media_mid: 'z1' } },
          { mid: 'q2', name: 'other', singer: [{ name: '路人' }], album: { mid: 'wrong', name: '范特西 翻唱版' }, file: { media_mid: 'z2' } },
        ] } } },
      }),
    })))
    expect(await tx.findTxAlbumId('范特西', '周杰伦')).toBe('000MkMni19ClKG')
  })
})

describe('txPhotoUrl 公式', () => {
  it('T001 头像 300px / T002 专辑 500px', () => {
    expect(tx.txPhotoUrl('T001', '0025NhlN2yWrP4')).toContain('T001R300x300M0000025NhlN2yWrP4.jpg')
    expect(tx.txPhotoUrl('T002', '000MkMni19ClKG')).toContain('T002R500x500M000000MkMni19ClKG.jpg')
  })
})

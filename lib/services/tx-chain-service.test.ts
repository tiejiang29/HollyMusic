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

describe('原生简介 + v8 专辑信息', () => {
  beforeEach(() => { get.mockReturnValue(undefined) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('getTxArtistDesc：XML 解析 desc + basic 档案生日', async () => {
    const xml = `<?xml version="1.0"?><result><code>0</code><data><info><id>4558</id><desc><![CDATA[周杰伦（Jay Chou），1979年生。]]></desc><basic><item><key><![CDATA[外文名]]></key><value><![CDATA[Jay Chou]]></value></item><item><key><![CDATA[生日]]></key><value><![CDATA[1979年1月18日]]></value></item></basic></info></data></result>`
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => xml })))
    const d = await tx.getTxArtistDesc('0025NhlN2yWrP4')
    expect(d?.desc).toBe('周杰伦（Jay Chou），1979年生。')
    expect(d?.birthDate).toBe('1979年1月18日')
    expect(d?.basic).toContainEqual({ key: '外文名', value: 'Jay Chou' })
  })

  it('getTxAlbumDetail：v8 主路径（desc/company/aDate + 曲目）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          name: '叶惠美', singername: '周杰伦', desc: '专辑文案', company: '杰威尔音乐有限公司', aDate: '2003-07-31',
          list: [
            // v8 真实形态：singer 是对象数组（{id,mid,name}），不是字符串数组
            { songmid: '001n4C3p1yv0FU', songname: '以父之名', interval: 342, singer: [{ id: 4558, mid: '0025NhlN2yWrP4', name: '周杰伦' }], albummid: '000MkMni19ClKG', albumname: '叶惠美', strMediaMid: '002ExFMX2Jt6gv', size320: 13682683, sizeflac: 33950377 },
          ],
        },
      }),
    })))
    const d = await tx.getTxAlbumDetail('000MkMni19ClKG')
    expect(d?.album).toMatchObject({ name: '叶惠美', artist: '周杰伦', desc: '专辑文案', company: '杰威尔音乐有限公司', year: '2003-07-31' })
    expect(d?.tracks[0]).toMatchObject({ songmid: '001n4C3p1yv0FU', strMediaMid: '002ExFMX2Jt6gv', interval: '05:42' })
    // 歌手必须解析成真名：'未知歌手' 会让换源搜索词作废（identity 也认不出同款歌）
    expect(d?.tracks[0]?.singer).toBe('周杰伦')
    expect(d?.tracks[0]?.types.map(t => t.type)).toEqual(['320k', 'flac'])
  })

  it('getTxAlbumDetail：v8 曲目缺歌手时回落专辑歌手（兼容字符串数组形态）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          name: '叶惠美', singername: '周杰伦',
          list: [
            { songmid: 'a1', songname: '晴天', interval: 269, singer: ['周杰伦'], albummid: 'm1', albumname: '叶惠美', strMediaMid: 'mm1', size320: 1 },
            { songmid: 'a2', songname: '懦夫', interval: 218, singer: [], albummid: 'm1', albumname: '叶惠美', strMediaMid: 'mm2', size320: 1 },
            { songmid: 'a3', songname: '双刀', interval: 291, albummid: 'm1', albumname: '叶惠美', strMediaMid: 'mm3', size320: 1 },
          ],
        },
      }),
    })))
    const d = await tx.getTxAlbumDetail('m1')
    expect(d?.tracks.map(t => t.singer)).toEqual(['周杰伦', '周杰伦', '周杰伦'])
  })

  it('getTxAlbumDetailPlayable：album.singer 与 kw/mg 详情同名字段（客户端只认 singer）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          name: '范特西', singername: '周杰伦',
          list: [
            { songmid: 'a1', songname: '爱在西元前', interval: 234, singer: [{ name: '周杰伦' }], albummid: 'm1', albumname: '范特西', strMediaMid: 'mm1', size320: 1 },
          ],
        },
      }),
    })))
    const d = await tx.getTxAlbumDetailPlayable('m1')
    // 前端按 album.singer 读取（专辑页标题 / 封面兜底 / 收藏快照都走它），
    // 只给上游原名 artist 会让标题掉歌手名、收藏快照 singer 落 null。
    expect(d?.album.singer).toBe('周杰伦')
    expect(d?.album.artist).toBe('周杰伦')
  })
})

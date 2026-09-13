import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { get, set, dbUpsert, dbGetStorageSongmid } = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  dbUpsert: vi.fn(),
  dbGetStorageSongmid: vi.fn((mi: { songmid: string }) => mi.songmid),
}))

vi.mock('@/lib/cache-manager', () => ({ searchCache: { get, set } }))
vi.mock('@/lib/db', () => ({
  upsertMusicInfosInTransaction: dbUpsert,
  getStorageSongmidForMusicInfo: dbGetStorageSongmid,
}))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/services/itunes-service', () => ({
  appleT2S: vi.fn((v: string) => v.replace('師', '师')),
}))

const mgChain = await import('./mg-chain-service')

describe('mgSongToMusicInfo（songItem 映射，与 music-core 老 mg 源同构）', () => {
  it('songId 为 songmid、音质 PQ/HQ/SQ/ZQ24 正确映射、封面补前缀', () => {
    const mi = mgChain.mgSongToMusicInfo({
      songId: '6868',
      songName: '我的地盘',
      copyrightId: '60054701941',
      albumId: '7949',
      album: '七里香',
      duration: 245,
      singerList: [{ name: '周杰伦' }],
      img3: '/data/oss/resource/00/x.webp',
      lrcUrl: 'https://d.musicapp.migu.cn/lrc',
      audioFormats: [
        { formatType: 'PQ', asize: '3916071' },
        { formatType: 'HQ', asize: '9700000' },
        { formatType: 'SQ', asize: '27670036' },
        { formatType: 'ZQ24', asize: '49887346' },
      ],
    })
    expect(mi).toMatchObject({
      source: 'mg', songmid: '6868', name: '我的地盘', singer: '周杰伦',
      albumName: '七里香', interval: '04:05',
      img: 'https://d.musicapp.migu.cn/data/oss/resource/00/x.webp',
      copyrightId: '60054701941', albumId: '7949',
    })
    expect(mi?.types.map(t => t.type)).toEqual(['128k', '320k', 'flac', 'flac24bit'])
    expect(mi?.lrcUrl).toContain('migu.cn')
  })

  it('缺 songId/songName 返回 null；相对路径封面补 d.musicapp 前缀', () => {
    expect(mgChain.mgSongToMusicInfo({ songName: '无id' })).toBeNull()
    expect(mgChain.mgSongToMusicInfo({ songId: '1' })).toBeNull()
  })
})

describe('接口解析（fetch mock）', () => {
  beforeEach(() => {
    get.mockReturnValue(undefined)
    dbUpsert.mockResolvedValue([])
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const json = (data: unknown, code = '000000') => ({
    ok: true,
    json: async () => ({ code, info: '操作成功', data }),
  })

  it('搜歌手：data 数组 → 卡片（3 尺寸头像取最大）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([
      { singerId: 266, singer: '林俊杰', imgs: [
        { imgSizeType: '01', img: 'https://d/01.webp' },
        { imgSizeType: '02', img: 'https://d/02.webp' },
        { imgSizeType: '03', img: 'https://d/03.webp' },
      ] },
    ])))
    const list = await mgChain.searchMgArtists('林俊杰', 5)
    expect(list).toEqual([{ source: 'mg', artistId: '266', name: '林俊杰', pic: 'https://d/03.webp' }])
  })

  it('搜专辑：resourceType=5 的 column 形态被过滤（其 id 查详情为空数据）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      totalCount: '2',
      result: [
        { id: '600927015009001083', resourceType: '5', name: '太阳之子', singer: '周杰伦', publishDate: '2026-03-25', imgItems: [] },
        { id: '7949', resourceType: '2003', name: '七里香', singer: '周杰伦', publishDate: '2004-08-03', imgItems: [{ imgSizeType: '03', img: 'https://d/qlx.webp' }] },
      ],
    })))
    const list = await mgChain.searchMgAlbums('七里香', 10)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ albumId: '7949', name: '七里香', year: '2004-08-03', img: 'https://d/qlx.webp' })
  })

  it('专辑详情：column id 假成功防御（信息为空视为无效返回 null）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.includes('resource/album/v2.0')) return json({ totalCount: '0' })  // 假成功空数据
      return json({ songList: [] })
    }))
    expect(await mgChain.getMgAlbumDetail('600927015009001083')).toBeNull()
  })

  it('歌手专辑列表：平铺 ZJ-Album-Item 解析，column id 透传（详情时按名降级，不在此归一）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.includes('singer/album')) {
        return json({ contents: [
          { view: 'ZJ-Album-Item', txt: '伟大的渺小', txt2: '林俊杰', txt3: '2017-12-29', resId: '600927015009000086', img: 'https://d/wd.webp' },
          { view: 'ZJ-Album-Item', txt: '重拾_快乐', txt2: '林俊杰', txt3: '2023-04-21', resId: '1140268770', img: 'https://d/cs.webp' },
        ] })
      }
      return json(null)
    }))
    const cards = await mgChain.getMgArtistAlbums('266', 5)
    // column 条目直接透传（不触发搜索归一——归一被礼貌队列串行化，实测 22 张专辑 12s）
    expect(cards).toEqual([
      { source: 'mg', albumId: '600927015009000086', name: '伟大的渺小', artist: '林俊杰', pic: 'https://d/wd.webp', img: 'https://d/wd.webp', year: '2017-12-29' },
      { source: 'mg', albumId: '1140268770', name: '重拾_快乐', artist: '林俊杰', pic: 'https://d/cs.webp', img: 'https://d/cs.webp', year: '2023-04-21' },
    ])
  })

  it('歌手详情整包：信息+歌曲+简介组装，热门歌入库附 uid=mg-{songId}', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.includes('singer/info')) return json({ contents: [{ contents: [{ view: 'ZJ-SingerDetail-Item', txt: '林俊杰', img: 'https://d/avatar.webp' }] }] })
      if (u.includes('singer/song')) return json({ contents: [{ contents: [{ view: 'ZJ-Singer-Song-Item', songItem: { songId: '123', songName: '达尔文', duration: 246, singerList: [{ name: '林俊杰' }] } }] }] })
      if (u.includes('search/singer')) return json([{ singerId: 266, singer: '林俊杰', summary: 'JJ林俊杰的创作来自最深的情感' }])
      return json(null)
    }))
    const detail = await mgChain.getMgArtistDetail('266', '林俊杰')
    expect(detail?.source).toBe('mg')
    expect(detail?.artist).toMatchObject({ name: '林俊杰', img: 'https://d/avatar.webp', bio: 'JJ林俊杰的创作来自最深的情感' })
    expect(detail?.hotSongs[0]).toMatchObject({ songmid: '123', uid: 'mg-123' })
    expect(dbUpsert).toHaveBeenCalled()
  })
})

describe('数字专辑（column）原生链', () => {
  beforeEach(() => {
    get.mockReturnValue(undefined)
    dbUpsert.mockResolvedValue([])
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const json = (data: unknown, code = '000000') => ({
    ok: true,
    json: async () => ({ code, info: '操作成功', data }),
  })

  it('6009 前缀走 resourceinfo+by-contentids：曲序以专栏为准，时长/音质来自补全', async () => {
    const colInfo = {
      resource: [{
        title: '太阳之子', singer: '周杰伦', publishDate: '2026-03-25', summary: '万众期盼！',
        imgItem: [{ imgSizeType: '03', img: 'https://d/tzzz.webp' }],
        songItems: [
          { contentId: '600919000007823377', songId: '1142543109', songName: '太阳之子' },
          { contentId: '600919000007823382', songId: '1142543100', songName: '西西里' },
        ],
      }],
    }
    const batch = {
      0: { contentId: '600919000007823377', songId: '1142543109', songName: '太阳之子', duration: 297, singerList: [{ name: '周杰伦' }], audioFormats: [{ formatType: 'SQ' }] },
      1: { contentId: '600919000007823382', songId: '1142543100', songName: '西西里', duration: 229, singerList: [{ name: '周杰伦' }] },
    }
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url)
      calls.push(u)
      if (u.includes('resourceinfo.do')) return { ok: true, json: async () => colInfo }
      if (u.includes('by-contentids')) return { ok: true, json: async () => ({ code: '000000', data: batch }) }
      return json(null)
    }))
    const detail = await mgChain.getMgAlbumDetail('600927015009001083')
    expect(detail?.album).toMatchObject({ albumId: '600927015009001083', name: '太阳之子', artist: '周杰伦', year: '2026-03-25', pic: 'https://d/tzzz.webp', summary: '万众期盼！' })
    // 曲序=专栏 songItems 顺序；首曲拿到补全的时长与音质，次曲缺补全字段也能兜底
    expect(detail?.tracks.map(t => `${t.name}:${t.interval}`)).toEqual(['太阳之子:04:57', '西西里:03:49'])
    expect(detail?.tracks[0]?.types.map(t => t.type)).toEqual(['flac'])
    expect(calls.some(u => u.includes('resourceinfo.do'))).toBe(true)
    expect(calls.some(u => u.includes('by-contentids'))).toBe(true)
  })

  it('resourceinfo 空数据（假成功）返回 null → 上层走降级链', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ code: '000000', resource: [] }) })))
    expect(await mgChain.getMgAlbumDetail('600900000000000009')).toBeNull()
  })
})

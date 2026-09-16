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

const kwChain = await import('./kw-chain-service')

/** JSON 响应构造（wapi/www 同构） */
const okJson = (data: unknown) => ({ code: 200, data, message: 'success' })

describe('generateKwSecret（LCG 异或，逆向自 kuwo 前端）', () => {
  it('固定随机种子下输出确定性十六进制串（长度 = 2×Cookie值 + 8 位种子）', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.123456789)
    const secret = kwChain.generateKwSecret('abcd1234')
    expect(secret).toMatch(/^[0-9a-f]+$/)
    expect(secret.length).toBe(2 * 'abcd1234'.length + 8)
    // 同种子可复现（算法确定性）
    expect(kwChain.generateKwSecret('abcd1234')).toBe(secret)
    // 不同 Cookie 值输出不同
    expect(kwChain.generateKwSecret('abcd1235')).not.toBe(secret)
    randomSpy.mockRestore()
  })
})

describe('kwSongToMusicInfo（歌曲映射与清洗）', () => {
  it('rid/时长/简繁/实体解码正确，interval 格式 mm:ss', () => {
    const mi = kwChain.kwSongToMusicInfo({
      rid: 228908,
      name: '晴天',
      artist: '周杰伦',
      album: '叶惠美',
      duration: 269,
      albumpic: 'https://img4.kuwo.cn/120/a.jpg',
    })
    expect(mi).toMatchObject({
      source: 'kw', songmid: '228908', name: '晴天', singer: '周杰伦',
      albumName: '叶惠美', interval: '04:29', img: 'https://img4.kuwo.cn/120/a.jpg',
    })
  })

  it('缺 rid 或歌名返回 null', () => {
    expect(kwChain.kwSongToMusicInfo({ name: '无id' })).toBeNull()
    expect(kwChain.kwSongToMusicInfo({ rid: 1 })).toBeNull()
  })
})

describe('parseKwQualities（音质档位，_types 空会让同平台取址被整段跳过）', () => {
  it('MINFO 明细解析出 flac/320k/128k 及各档大小', () => {
    const r = kwChain.parseKwQualities({
      minfo: 'level:ff,bitrate:2000,format:flac,size:32.38Mb;level:p,bitrate:192,format:ogg,size:7.15Mb;level:p,bitrate:320,format:mp3,size:13.05Mb;level:s,bitrate:48,format:aac,size:1.97Mb;level:h,bitrate:128,format:mp3,size:5.22Mb',
    })
    expect(r.types).toEqual([
      { type: '128k', size: '5.22M' },
      { type: '320k', size: '13.05M' },
      { type: 'flac', size: '32.38M' },
    ])
    expect(r._types).toMatchObject({ '128k': { size: '5.22M' }, '320k': { size: '13.05M' }, flac: { size: '32.38M' } })
  })

  it('无 MINFO 时按 formats 集合给档位（大小未知留空串）', () => {
    const r = kwChain.parseKwQualities({ formats: 'AAC48|ALFLAC|MP3128|MP3H|OGG192' })
    expect(r.types.map(t => t.type)).toEqual(['128k', '320k', 'flac'])
    expect(r._types['320k']).toEqual({ size: '' })
  })

  it('wapi 歌手接口只有 hasLossless：基线 mp3 档位恒在，额外补 flac', () => {
    expect(kwChain.parseKwQualities({ hasLossless: true }).types.map(t => t.type)).toEqual(['128k', '320k', 'flac'])
    expect(kwChain.parseKwQualities({}).types.map(t => t.type)).toEqual(['128k', '320k'])
  })

  it('任何输入都至少给出 128k/320k（回归守卫：空 _types 会让管理器的音质筛选全部跳过）', () => {
    for (const input of [{}, { minfo: '' }, { formats: '' }, { minfo: 'level:zz,format:zp,size:zpMb' }]) {
      const r = kwChain.parseKwQualities(input)
      expect(r.types.length).toBeGreaterThanOrEqual(2)
      expect(r._types['128k']).toBeDefined()
      expect(r._types['320k']).toBeDefined()
    }
  })

  it('kwSongToMusicInfo 输出的 _types 非空（音源管理器按 _types 逐档筛选）', () => {
    const mi = kwChain.kwSongToMusicInfo({ rid: 238210, name: '以父之名', artist: '周杰伦', duration: 342 })
    expect(Object.keys(mi?._types || {}).sort()).toEqual(['128k', '320k'])
    expect(mi?.types.map(t => t.type)).toEqual(['128k', '320k'])
  })
})

describe('kwWwwGet 双通道降级', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('wapi 失败自动落 www+Secret 备通道', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u === 'https://www.kuwo.cn/') {
        // Cookie 获取请求：Set-Cookie 带 Hm_Iuvt token
        return {
          ok: true,
          headers: { getSetCookie: () => ['Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324=abc123def456ghi789; Path=/; Expires=Fri, 01 Jan 2027 00:00:00 GMT'] },
          json: async () => ({}),
        }
      }
      if (u.includes('wapi.kuwo.cn')) throw new Error('wapi down')
      return {
        ok: true,
        json: async () => okJson({ list: [{ id: 336, name: '周杰伦' }] }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await kwChain.searchKwArtists('周杰伦', 5)
    expect(result).toEqual([
      { source: 'kw', artistId: '336', name: '周杰伦', pic: null },
    ])
    const calls = fetchMock.mock.calls.map(c => String(c[0]))
    expect(calls.some(u => u.includes('wapi.kuwo.cn'))).toBe(true)
    expect(calls.some(u => u.includes('www.kuwo.cn/api/www'))).toBe(true)
    // 备通道请求带 Secret 头与 Cookie
    const backupCall = fetchMock.mock.calls.find(c => String(c[0]).includes('www.kuwo.cn/api/www'))
    expect(backupCall?.[1]?.headers).toMatchObject({
      Cookie: 'Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324=abc123def456ghi789',
    })
    expect((backupCall?.[1]?.headers as Record<string, string>).Secret).toMatch(/^[0-9a-f]+$/)
  })

  it('双通道全挂返回空（调用方走 Apple 兜底）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('all down') }))
    const result = await kwChain.searchKwArtists('周杰伦', 5)
    expect(result).toEqual([])
  })
})

describe('getKwArtistDetail 整包', () => {
  beforeEach(() => {
    get.mockReturnValue(undefined)
    dbUpsert.mockResolvedValue([])
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('三路并行组装 + 热门歌入库附 uid', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url)
      const data = u.includes('artist/artist?')
        ? { id: 336, name: '周杰伦', pic: 'https://star/240.jpg', info: '简介', birthday: '1979-01-18T00:00:00', country: '中国台湾' }
        : u.includes('artistMusic')
          ? { total: 1709, list: [{ rid: 228908, name: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269 }] }
          : u.includes('artistAlbum')
            ? { total: '45', albumList: [{ albumid: 4533, album: '七里香', artist: '周杰伦', pic: 'https://img1/300.jpg', releaseDate: '2004-08-03' }] }
            : null
      return { ok: true, json: async () => okJson(data) }
    }))

    const detail = await kwChain.getKwArtistDetail('336')

    expect(detail?.source).toBe('kw')
    expect(detail?.artist).toMatchObject({ name: '周杰伦', birthDate: '1979-01-18', country: '中国台湾' })
    expect(detail?.hotSongs).toHaveLength(1)
    expect(detail?.hotSongs[0]).toMatchObject({ songmid: '228908', uid: 'kw-228908' })
    expect(dbUpsert).toHaveBeenCalled()
    expect(detail?.albums).toEqual([
      { source: 'kw', albumId: '4533', name: '七里香', artist: '周杰伦', pic: 'https://img1/300.jpg', img: 'https://img1/300.jpg', year: '2004-08-03' },
    ])
  })

  it('歌手信息/歌曲全挂返回 null（触发上层 Apple 降级）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    expect(await kwChain.getKwArtistDetail('336')).toBeNull()
  })
})

describe('getKwAlbumDetailPlayable（r.s 专辑详情）', () => {
  beforeEach(() => {
    get.mockReturnValue(undefined)
    dbUpsert.mockResolvedValue([])
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('单引号 JSON 清洗 + 曲目入库附 uid + 唱片公司档案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        albumid: '4533', name: '七里香', artist: '周杰伦',
        pic: '120/s4s81/2/3200337129.jpg', company: '杰威尔音乐有限公司',
        musiclist: [
          { id: '94238', name: '我的地盘', artist: '周杰伦', duration: '244' },
          { id: '94237', name: '七里香', artist: '周杰伦', duration: '299' },
        ],
      }).replace(/"/g, "'"),
    })))

    const detail = await kwChain.getKwAlbumDetailPlayable('4533')

    expect(detail?.album).toMatchObject({
      albumId: '4533', name: '七里香', singer: '周杰伦',
      company: '杰威尔音乐有限公司',
      img: 'https://img1.kuwo.cn/star/albumcover/300/s4s81/2/3200337129.jpg',
    })
    expect(detail?.list.map(s => s.uid)).toEqual(['kw-94238', 'kw-94237'])
    expect(detail?.album.profile?.recordLabels).toEqual(['杰威尔音乐有限公司'])
    expect(dbUpsert).toHaveBeenCalled()
  })
})

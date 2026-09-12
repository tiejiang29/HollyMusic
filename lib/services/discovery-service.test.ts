import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { get, set, getStorageSongmidForMusicInfo, upsertMusicInfosInTransaction, nativeGetJson } = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  getStorageSongmidForMusicInfo: vi.fn((musicInfo: { songmid: string }) => musicInfo.songmid),
  upsertMusicInfosInTransaction: vi.fn(),
  nativeGetJson: vi.fn(),
}))

vi.mock('@/lib/cache-manager', () => ({ searchCache: { get, set } }))
vi.mock('@/lib/db', () => ({ getStorageSongmidForMusicInfo, upsertMusicInfosInTransaction }))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
// kw 标签树走原生 http 模块（绕开 undici fetch），测试中替换为受控 mock
vi.mock('./upstream-http', () => ({ nativeGetJson, httpsPostForm: vi.fn() }))

const { getPlaylistTags, getRecommendedPlaylists, getRecommendedPlaylistDetail, PlaylistUnavailableError } = await import('./discovery-service')

describe('getRecommendedPlaylistDetail', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    get.mockReturnValue(undefined)
    upsertMusicInfosInTransaction.mockResolvedValue(undefined)
  })

  it('TX 歌单详情缓存未命中时，按歌单 ID 直接请求详情而非回退到列表页', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 0,
        cdlist: [{
          dissname: '深翻页歌单', desc: '歌单简介', logo: 'http://example.com/cover.jpg', nickname: '创建者',
          songlist: [{
            id: 1, mid: 'song-mid', name: '测试歌曲', singer: [{ name: '测试歌手' }],
            album: { mid: 'album-mid', name: '测试专辑' }, interval: 180,
            file: { media_mid: 'media-mid', size_128mp3: 1024 },
          }],
        }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const detail = await getRecommendedPlaylistDetail('tx', 'deep-page-playlist')

    expect(detail).toMatchObject({
      id: 'deep-page-playlist', name: '深翻页歌单', author: '创建者', cover: 'https://example.com/cover.jpg',
    })
    expect(detail?.tracks).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const requestUrl = new URL(url)
    expect(requestUrl.pathname).toBe('/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg')
    expect(requestUrl.searchParams.get('disstid')).toBe('deep-page-playlist')
    expect(requestUrl.searchParams.get('onlysong')).toBe('0')
    expect(init.headers).toMatchObject({
      Origin: 'https://y.qq.com',
      Referer: 'https://y.qq.com/n/yqq/playsquare/deep-page-playlist.html',
    })
  })

  it('将歌单歌曲作为单个事务批量入库', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 0,
        cdlist: [{
          songlist: [
            { id: 1, mid: 'song-mid-1', name: '歌曲一', singer: [{ name: '歌手' }], album: { mid: 'album-mid', name: '专辑' }, interval: 180, file: { media_mid: 'media-mid-1', size_128mp3: 1024 } },
            { id: 2, mid: 'song-mid-2', name: '歌曲二', singer: [{ name: '歌手' }], album: { mid: 'album-mid', name: '专辑' }, interval: 180, file: { media_mid: 'media-mid-2', size_128mp3: 1024 } },
          ],
        }],
      }),
    }))

    await getRecommendedPlaylistDetail('tx', 'serial-write-playlist')

    expect(upsertMusicInfosInTransaction).toHaveBeenCalledTimes(1)
    expect(upsertMusicInfosInTransaction.mock.calls[0]?.[0]).toHaveLength(2)
  })

  it('批量入库失败时不返回或缓存不可播放的歌单详情', async () => {
    const databaseError = Object.assign(new Error('database timeout'), { code: 'P1008' })
    upsertMusicInfosInTransaction.mockRejectedValueOnce(databaseError)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 0,
        cdlist: [{
          songlist: [{
            id: 1, mid: 'song-mid', name: '测试歌曲', singer: [{ name: '测试歌手' }],
            album: { mid: 'album-mid', name: '测试专辑' }, interval: 180,
            file: { media_mid: 'media-mid', size_128mp3: 1024 },
          }],
        }],
      }),
    }))

    await expect(getRecommendedPlaylistDetail('tx', 'failed-transaction-playlist')).rejects.toBe(databaseError)
    expect(set).not.toHaveBeenCalled()
  })

  it('tx 隐私歌单（subcode 4000）抛 PlaylistUnavailableError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, subcode: 4000, msg: 'check privacy error!' }),
    }))

    await expect(getRecommendedPlaylistDetail('tx', 'privacy-playlist')).rejects.toBeInstanceOf(PlaylistUnavailableError)
    await getRecommendedPlaylistDetail('tx', 'privacy-playlist-2').catch((e: Error) => {
      expect(e.message).toContain('隐私')
    })
    expect(set).not.toHaveBeenCalled()
  })
})

describe('getPlaylistTags（wy/kw 完整标签树）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    get.mockReturnValue(undefined)
  })

  it('wy 返回热门标签 + 分类目录分组（id 为类目名直传）', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 200, tags: [{ playlistTag: { name: '华语' } }, { playlistTag: { name: '流行' } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 200,
          categories: { '0': '语种', '1': '风格' },
          sub: [
            { name: '华语', category: 0 }, { name: '欧美', category: 0 },
            { name: '流行', category: 1 }, { name: '摇滚', category: 1 }, { name: '无组标签', category: 9 },
          ],
        }),
      }))

    const result = await getPlaylistTags('wy')

    expect(result.hotTag).toEqual([{ id: '华语', name: '华语' }, { id: '流行', name: '流行' }])
    expect(result.tags).toEqual([
      { name: '语种', list: [{ id: '华语', name: '华语' }, { id: '欧美', name: '欧美' }] },
      { name: '风格', list: [{ id: '流行', name: '流行' }, { id: '摇滚', name: '摇滚' }] },
    ])
  })

  it('wy 目录获取失败时退回仅热门标签', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 200, tags: [{ playlistTag: { name: '流行' } }] }) })
      .mockRejectedValueOnce(new Error('catalogue down')))

    const result = await getPlaylistTags('wy')

    expect(result.hotTag).toEqual([{ id: '流行', name: '流行' }])
    expect(result.tags).toEqual([])
  })

  it('kw 返回热门标签 + 标签树（id 带 digest 后缀），空组被过滤', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: 200, data: [{ data: [{ id: 1265, digest: 10000, name: '经典' }] }] }),
    }))
    nativeGetJson.mockResolvedValueOnce({
      code: 200,
      // 实测形态：col.data 直接是条目数组
      data: [
        { name: '曲风流派', data: [{ id: '389', digest: '10000', name: '摇滚' }, { name: '无id脏数据' }] },
        { name: '空组', data: [] },
      ],
    })

    const result = await getPlaylistTags('kw')

    expect(nativeGetJson).toHaveBeenCalledTimes(1)
    expect(String(nativeGetJson.mock.calls[0][0])).toContain('getTagList')
    expect(result.hotTag).toEqual([{ id: '1265-10000', name: '经典' }])
    expect(result.tags).toEqual([{ name: '曲风流派', list: [{ id: '389-10000', name: '摇滚' }] }])
  })

  it('kw 标签树获取失败时退回仅热门标签', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: 200, data: [{ data: [{ id: 1265, digest: 10000, name: '经典' }] }] }),
    }))
    nativeGetJson.mockRejectedValueOnce(new Error('taglist down'))

    const result = await getPlaylistTags('kw')

    expect(result.hotTag).toEqual([{ id: '1265-10000', name: '经典' }])
    expect(result.tags).toEqual([])
  })

  it('kg 返回热门标签 + tagids 分组（getSpecial 不带 cdn 参数）', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 1,
        data: {
          hotTag: { data: { a: { special_id: 12, special_name: '经典' }, b: { special_name: '无id脏数据' } } },
          tagids: {
            风格: { data: [{ id: 1, name: '流行' }, { id: 2, name: '摇滚' }, { name: '无id脏数据' }] },
            空组: { data: [] },
          },
        },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await getPlaylistTags('kg')

    const url = new URL(fetchMock.mock.calls[0][0] as string)
    expect(url.searchParams.has('cdn')).toBe(false)
    expect(result.hotTag).toEqual([{ id: '12', name: '经典' }])
    expect(result.tags).toEqual([{ name: '风格', list: [{ id: '1', name: '流行' }, { id: '2', name: '摇滚' }] }])
  })
})

describe('getRecommendedPlaylists kw 排序档位', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    get.mockReturnValue(undefined)
  })

  function kwListPayload() {
    return {
      ok: true,
      json: async () => ({ code: 200, data: { data: [{ id: 1, name: '歌单', uname: '作者', img: 'http://img/img.jpg', listencnt: 10, total: 5 }] } }),
    }
  }

  it('recommend（默认）不携带 order 参数', async () => {
    const fetchMock = vi.fn().mockResolvedValue(kwListPayload())
    vi.stubGlobal('fetch', fetchMock)

    await getRecommendedPlaylists('kw', 3, 1, { sort: 'recommend' })

    const url = new URL(fetchMock.mock.calls[0][0] as string)
    expect(url.pathname).toBe('/api/pc/classify/playlist/getRcmPlayList')
    expect(url.searchParams.has('order')).toBe(false)
  })

  it('hot/new 分别映射 order 参数', async () => {
    const fetchMock = vi.fn().mockResolvedValue(kwListPayload())
    vi.stubGlobal('fetch', fetchMock)

    await getRecommendedPlaylists('kw', 3, 1, { sort: 'hot' })
    await getRecommendedPlaylists('kw', 3, 1, { sort: 'new' })

    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get('order')).toBe('hot')
    expect(new URL(fetchMock.mock.calls[1][0] as string).searchParams.get('order')).toBe('new')
  })
})

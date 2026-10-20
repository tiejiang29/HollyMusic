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

const { getPlaylistTags, getRecommendedPlaylists, getRecommendedPlaylistDetail, getPlaylistGroups, PlaylistUnavailableError } = await import('./discovery-service')
// wy 列表走原生 https（绕开 undici fetch），要统计它的调用次数必须拿这个导出的 mock
const { httpsPostForm } = await import('./upstream-http')

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

describe('getPlaylistGroups 的 QQ 那份改取新建流水', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    // 只让"标签树"这一类键命中缓存：其余一律 miss，逼 fetcher 真发请求。
    // tx 只给一个可解析类目（流行→3152），其余七类解析不到 ⇒ 直接跳过，好把断言收紧。
    get.mockImplementation((key: string) => {
      if (!key.endsWith(':playlist-tags')) return undefined
      return key.startsWith('discovery:v1:tx:')
        ? { hotTag: [{ id: '3152', name: '流行' }], tags: [] }
        : { hotTag: [], tags: [] }
    })
  })

  const DAY = 86400
  const nowSec = () => Math.floor(Date.now() / 1000)

  const txPayload = (pool: Array<{ tid: number; ct: number }>, size: number) => ({
    ok: true,
    json: async () => ({
      playlist: {
        code: 0,
        data: {
          content: {
            v_item: pool.slice(0, size).map(({ tid, ct }) => ({
              basic: { tid, title: `歌单 ${tid}`, creator: { nick: '作者' }, desc: '', cover: { medium_url: 'http://c/1.jpg' }, play_cnt: 1, song_cnt: 2, create_time: ct },
            })),
          },
        },
      },
    }),
  })

  /** 置顶位那一页永远给这张 2000 天前的老单 */
  const TOP_ONLY = [{ tid: 111, ct: nowSec() - 2000 * DAY }]
  /** 上游实测把新建的单排在窗口尾部且顺序不保证 ⇒ 故意给一个乱序、混年龄的大窗口 */
  const MIXED_WINDOW = [
    { tid: 500, ct: nowSec() - 900 * DAY },
    { tid: 600, ct: nowSec() - 1 * DAY },
    { tid: 700, ct: nowSec() - 3 * DAY },
    { tid: 800, ct: nowSec() - 400 * DAY },
  ]

  function stubPages(pageSeen: Array<{ page: number; size: number }>, freshWindow = MIXED_WINDOW) {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = String(init?.body ?? '')
      if (body.includes('get_category_content')) {
        const param = JSON.parse(body).playlist.param
        pageSeen.push({ page: param.page, size: param.size })
        return txPayload(param.page === 0 ? TOP_ONLY : freshWindow, param.size) as never
      }
      return { ok: true, json: async () => ({}) } as never
    }))
  }

  it('新流水那页要开大窗口（size>=15）：窗口开小了，近半年的单压根不在这一页里', async () => {
    const pageSeen: Array<{ page: number; size: number }> = []
    stubPages(pageSeen)

    await getPlaylistGroups(3)
    // 实测依据：同类目 page=1 时 size=3 只碰到 1 张近半年、size>=6 才整窗新鲜，儿歌/电子要 size=20 才浮出来
    expect(pageSeen.find(p => p.page === 1)?.size).toBeGreaterThanOrEqual(15)
    expect(pageSeen.find(p => p.page === 0)?.size).toBe(1)
  })

  it('大窗口内自己按创建时间从新到旧挑 per-1 张，再补 1 张置顶位', async () => {
    const pageSeen: Array<{ page: number; size: number }> = []
    stubPages(pageSeen)

    const groups = await getPlaylistGroups(3)
    // per=3 ⇒ 取窗口里最新的两张（600、700）+ 置顶 111；500/800 那种老的不该进格
    expect(pageSeen.map(p => p.page).sort()).toEqual([0, 1])
    expect(groups.find(g => g.tag.name === '流行')?.playlists.map(p => p.id)).toEqual(['600', '700', '111'])
  })

  it('上游没给 create_time 时退回原序，既不瞎排也不把格子弄空', async () => {
    const pageSeen: Array<{ page: number; size: number }> = []
    stubPages(pageSeen, [{ tid: 221, ct: 0 }, { tid: 222, ct: 0 }])

    const groups = await getPlaylistGroups(3)
    expect(groups.find(g => g.tag.name === '流行')?.playlists.map(p => p.id)).toEqual(['221', '222', '111'])
  })

  it('两页给出同一张歌单时不重复入格', async () => {
    const pageSeen: Array<{ page: number; size: number }> = []
    stubPages(pageSeen, [{ tid: 777, ct: nowSec() - DAY }, { tid: 111, ct: nowSec() - 2 * DAY }])

    const groups = await getPlaylistGroups(3)
    const ids = groups.find(g => g.tag.name === '流行')?.playlists.map(p => p.id)
    expect(ids).toEqual(['777', '111'])
    expect(new Set(ids).size).toBe(ids?.length)
  })

  it('反证：新流水那页给空时退回置顶混合位，不能把整格弄空', async () => {
    const pageSeen: Array<{ page: number; size: number }> = []
    stubPages(pageSeen, [])

    const groups = await getPlaylistGroups(3)
    expect(groups.find(g => g.tag.name === '流行')?.playlists.map(p => p.id)).toEqual(['111'])
  })

  it('不误伤：只有 tx 被多问一页，其余平台每类目仍各一次请求', async () => {
    const calls: Array<{ tx: boolean }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = String(init?.body ?? '')
      const isTxCategory = body.includes('get_category_content')
      calls.push({ tx: isTxCategory })
      if (isTxCategory) {
        const param = JSON.parse(body).playlist.param
        return txPayload(param.page === 0 ? TOP_ONLY : [{ tid: 221, ct: nowSec() }], param.size) as never
      }
      return { ok: true, json: async () => ({}) } as never
    }))

    await getPlaylistGroups(3)
    // tx：1 个可解析类目 × 2 页
    expect(calls.filter(c => c.tx).length).toBe(2)
    // kw/kg/mg 这轮解析不到 tag ⇒ 压根不发（`if (!tagId) return []` 那道门）；
    // wy 走原生 https，不经过 global fetch，所以这里也是 0
    expect(calls.filter(c => !c.tx).length).toBe(0)
    // wy 按类目名兜底解析，8 个类目各发一次 ⇒ 页位改动没有外溢到其他平台（若跟着挪页会变成 16）
    expect(httpsPostForm.mock.calls.length).toBe(8)
  })
})

const { UnsupportedPlaylistFilterError, PLAYLIST_CAPABILITIES } = await import('./discovery-service')

describe('tx 歌单广场：默认落活类目、档位自己排、关键词明确拒绝', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    get.mockReturnValue(undefined)
  })

  const DAY = 86400
  const nowSec = () => Math.floor(Date.now() / 1000)
  /** 上游给的顺序就是"老的在前"，用来证明排序是我们做的、不是照抄上游 */
  const WINDOW = [
    { tid: 10, ct: nowSec() - 900 * DAY, play: 1 },
    { tid: 11, ct: nowSec() - 1 * DAY, play: 9 },
    { tid: 12, ct: nowSec() - 3 * DAY, play: 5 },
  ]

  /** 按 param.page 回不同批，并把每次发出去的 titleid/size/page 记下来 */
  function stubCategory(pages: Record<string, Array<{ tid: number; ct: number; play: number }>>) {
    const sent: Array<{ titleid: number; size: number; page: number }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = String(init?.body ?? '')
      if (!body.includes('get_category_content')) return { ok: true, json: async () => ({}) } as never
      const param = JSON.parse(body).playlist.param
      sent.push({ titleid: param.titleid, size: param.size, page: param.page })
      const items = (pages[String(param.page)] ?? []).slice(0, param.size)
      return {
        ok: true,
        json: async () => ({
          playlist: {
            code: 0,
            data: { content: { v_item: items.map(x => ({ basic: { tid: x.tid, title: `歌单 ${x.tid}`, creator: { nick: 'n' }, desc: '', cover: { medium_url: 'http://c/1.jpg' }, play_cnt: x.play, song_cnt: 3, create_time: x.ct } })) } },
          },
        }),
      } as never
    }))
    return sent
  }

  it('无 tag 时不再打那条死井，落到实测活的类目 59', async () => {
    const sent = stubCategory({ '0': [{ tid: 1, ct: nowSec() - DAY, play: 5 }] })
    await getRecommendedPlaylists('tx', 3, 1, {})
    expect(sent[0]?.titleid).toBe(59)
  })

  it('sort=new 开大窗口并按创建时间倒序，只回 limit 张', async () => {
    const sent = stubCategory({ '0': WINDOW })
    const list = await getRecommendedPlaylists('tx', 2, 1, { sort: 'new' })
    expect(sent[0]?.size).toBeGreaterThanOrEqual(15)
    expect(list.map(x => x.id)).toEqual(['11', '12'])
  })

  it('sort=hot 用播放量在同一窗口里排', async () => {
    stubCategory({ '0': WINDOW })
    const list = await getRecommendedPlaylists('tx', 3, 1, { sort: 'hot' })
    expect(list.map(x => x.id)).toEqual(['11', '12', '10'])
  })

  it('默认档保持上游置顶顺序，不重排也不开大窗口', async () => {
    const sent = stubCategory({ '0': WINDOW })
    const list = await getRecommendedPlaylists('tx', 2, 1, { sort: 'recommend' })
    expect(sent[0]?.size).toBe(2)
    expect(list.map(x => x.id)).toEqual(['10', '11'])
  })

  it('keyword 一律拒绝（取数函数都不读它，不能继续假装搜索有效）', async () => {
    stubCategory({ '0': [] })
    await expect(getRecommendedPlaylists('tx', 3, 1, { keyword: '周杰伦' }))
      .rejects.toBeInstanceOf(UnsupportedPlaylistFilterError)
  })

  it('能力表钉住实测结论：tx 有 new、wy 没 new、mg 只有 recommend、五源都不支持 keyword', () => {
    expect(PLAYLIST_CAPABILITIES.tx.sorts).toContain('new')
    expect(PLAYLIST_CAPABILITIES.wy.sorts).not.toContain('new')
    expect(PLAYLIST_CAPABILITIES.mg.sorts).toEqual(['recommend'])
    expect(Object.values(PLAYLIST_CAPABILITIES).every(c => c.keyword === false)).toBe(true)
  })
})

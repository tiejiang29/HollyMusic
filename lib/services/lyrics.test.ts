import { describe, expect, it, vi } from 'vitest'
import path from 'path'

const { findMany, findManyMusic, findFirstMusic, fetchKugouWordLyric, getLyric, fetchNativeLyric, access, readFile, writeFile, rename, unlink } = vi.hoisted(() => ({
  findMany: vi.fn(),
  findManyMusic: vi.fn(),
  findFirstMusic: vi.fn(),
  fetchKugouWordLyric: vi.fn(),
  getLyric: vi.fn(),
  fetchNativeLyric: vi.fn(),
  access: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}))

vi.mock('@/lib/audio-serve', () => ({
  getAudioServeConfig: () => ({ enabled: true, cacheDir: '/audio-cache' }),
}))

vi.mock('@/lib/db', () => ({ prisma: { audioCache: { findMany }, musicInfo: { findMany: findManyMusic, findFirst: findFirstMusic } } }))
vi.mock('@/lib/music-source-manager', () => ({ musicSourceManager: { getLyric } }))
vi.mock('@/lib/server/music-lyric', () => ({
  fetchNativeLyric,
  fetchKugouWordLyric,
  // 与实现同口径：QRC 只能按数字 songID 寻址，没有它 tx 就只能去借酷狗
  qqQrcSongId: (musicInfo: { songId?: string | number }) => {
    const songId = String(musicInfo.songId ?? '')
    return /^\d{1,12}$/.test(songId) ? songId : null
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

vi.mock('fs/promises', () => {
  const api = { access, readFile, writeFile, rename, unlink }
  return { default: api, ...api }
})

const { cacheNativeLyricForMusic } = await import('./lyrics')
// 取词结果有 90 秒内存缓存（一次播放多个入口只打一次上游）；用例之间必须清掉，
// 否则同一 songmid 的第二个用例会读到上一个用例的结果
const { lyricCache } = await import('@/lib/cache-manager')

describe('cacheNativeLyricForMusic', () => {
  it('原生接口无结果时，将渠道音源脚本返回的歌词写入缓存音频同级 .lrc', async () => {
    findMany.mockResolvedValue([{ filePath: 'aa/song.flac' }])
    access.mockResolvedValue(undefined)
    readFile.mockRejectedValue(new Error('sidecar missing'))
    fetchNativeLyric.mockResolvedValue(null)
    getLyric.mockResolvedValue({ lyric: '[00:01.00]渠道歌词', tlyric: null })
    writeFile.mockResolvedValue(undefined)
    rename.mockResolvedValue(undefined)

    await cacheNativeLyricForMusic({
      source: 'kw', songmid: '123', name: '测试歌曲', singer: '测试歌手',
      interval: '03:00', types: [], _types: {}, typeUrl: {},
    })

    const lyricPath = path.resolve('/audio-cache', 'aa', 'song.lrc')
    const tempPathPrefix = `${lyricPath}.tmp-`

    expect(getLyric).toHaveBeenCalled()
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining(tempPathPrefix),
      '[00:01.00]渠道歌词',
      'utf-8',
    )
    expect(rename).toHaveBeenCalledWith(
      expect.stringContaining(tempPathPrefix),
      lyricPath,
    )
  })
})

// ————— 逐字（.wlrc）读写与同源约束 —————
const { fetchLyricForMusic } = await import('./lyrics')

// kg 行必须带 hash：补取闸门靠它判断"这首歌有没有可能拿到逐字"
const kgMusicInfo = {
  source: 'kg', songmid: 'KGHASH', name: '测试歌曲', singer: '测试歌手',
  interval: '03:00', hash: 'KGFILEHASH', types: [], _types: {}, typeUrl: {},
}
const ENHANCED = '[01:20.000]<01:20.000>第1字<01:21.000>末字<01:23.000>'

function resetSidecarMocks() {
  lyricCache.clear()
  findMany.mockReset().mockResolvedValue([{ filePath: 'aa/song.flac' }])
  getLyric.mockReset().mockResolvedValue(null)
  fetchNativeLyric.mockReset()
  access.mockReset().mockResolvedValue(undefined)
  readFile.mockReset()
  writeFile.mockReset().mockResolvedValue(undefined)
  rename.mockReset().mockResolvedValue(undefined)
  unlink.mockReset().mockResolvedValue(undefined)
}

/** 按 sidecar 文件名分发读取结果（.tlyric.lrc 也以 .lrc 结尾，故必须给全名）；未列出的一律当作不存在 */
function stubSidecars(map: Record<string, string>) {
  readFile.mockImplementation(async (p: string) => {
    const hit = Object.entries(map).find(([suffix]) => String(p).endsWith(suffix))
    if (hit) return hit[1]
    throw new Error('sidecar missing')
  })
}

describe('fetchLyricForMusic 的逐字通道', () => {
  it('磁盘上 .lrc 与 .wlrc 同在时一起返回（同源对）', async () => {
    resetSidecarMocks()
    stubSidecars({ 'song.lrc': '[01:20.000]第1字末字', 'song.wlrc': ENHANCED })

    const result = await fetchLyricForMusic(kgMusicInfo)
    expect(result).toEqual({ lyric: '[01:20.000]第1字末字', tlyric: null, wordLyric: ENHANCED })
    expect(fetchNativeLyric).not.toHaveBeenCalled() // 命中缓存就不打上游
  })

  it('只有 .lrc 且该源本来没有逐字时，直接用缓存返回、不打上游', async () => {
    resetSidecarMocks()
    stubSidecars({ 'song.lrc': '[01:20.000]第1字末字' })
    fetchNativeLyric.mockResolvedValue(null)

    // 用 kw：它没有逐字通道，所以"缓存命中就早退"仍然是对的行为
    await expect(fetchLyricForMusic({ ...kgMusicInfo, source: 'kw', hash: undefined })).resolves.toEqual({
      lyric: '[01:20.000]第1字末字', tlyric: null, wordLyric: null,
    })
    expect(fetchNativeLyric).not.toHaveBeenCalled()
  })

  it('原生逐字命中时同时写 .lrc 与 .wlrc', async () => {
    resetSidecarMocks()
    stubSidecars({})
    fetchNativeLyric.mockResolvedValue({ lyric: '[01:20.000]第1字末字', tlyric: null, wordLyric: ENHANCED })

    const result = await fetchLyricForMusic(kgMusicInfo)
    expect(result?.wordLyric).toBe(ENHANCED)
    const written = rename.mock.calls.map(call => String(call[1]))
    expect(written).toContain(path.resolve('/audio-cache', 'aa', 'song.lrc'))
    expect(written).toContain(path.resolve('/audio-cache', 'aa', 'song.wlrc'))
  })

  it('逐字与整行不是同一次解析产物时丢弃逐字，并删掉旧的 .wlrc', async () => {
    resetSidecarMocks()
    stubSidecars({})
    fetchNativeLyric.mockResolvedValue({
      lyric: '[01:20.000]只有一行',
      tlyric: null,
      wordLyric: '[01:20.000]<01:20.000>第1字<01:21.000>末字<01:23.000>\n[01:24.000]<01:24.000>多出来一行<01:25.000>',
    })

    const result = await fetchLyricForMusic(kgMusicInfo)
    expect(result?.wordLyric).toBeNull()
    expect(unlink).toHaveBeenCalledWith(path.resolve('/audio-cache', 'aa', 'song.wlrc'))
  })

  it('渠道脚本只给整行时，删掉残留的 .wlrc 以免与新的 .lrc 错配', async () => {
    resetSidecarMocks()
    stubSidecars({})
    fetchNativeLyric.mockResolvedValue(null)
    getLyric.mockResolvedValue({ lyric: '[01:20.000]渠道整行', tlyric: null })

    const result = await fetchLyricForMusic(kgMusicInfo)
    expect(result).toEqual({ lyric: '[01:20.000]渠道整行', tlyric: null, wordLyric: null })
    expect(unlink).toHaveBeenCalledWith(path.resolve('/audio-cache', 'aa', 'song.wlrc'))
  })

  it('第三方标题搜索回退永远不带逐字', async () => {
    resetSidecarMocks()
    stubSidecars({})
    fetchNativeLyric.mockResolvedValue(null)
    getLyric.mockResolvedValue(null)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[01:20.000]第三方歌词')))

    const result = await fetchLyricForMusic(kgMusicInfo)
    expect(result).toEqual({ lyric: '[01:20.000]第三方歌词', tlyric: null, wordLyric: null })
    expect(writeFile).not.toHaveBeenCalled() // 标题搜索结果绝不落盘固化
    vi.unstubAllGlobals()
  })
})

// ————— 跨源借逐字（只对实测与酷狗同一份时间轴的 tx / kw 开放）—————
const { parseKrc } = await import('@/lib/server/word-lyric')

/** 酷狗侧：8 行，行起 10000ms 起步、每行 4s，两字一块 */
const borrowKrc = parseKrc(Array.from({ length: 8 }, (_, i) =>
  `[${10_000 + i * 4000},3000]<0,2000,0>第${i + 1}行<2000,1000,0>字`).join('\n'))!

/** QQ 侧同一首歌：行时间比酷狗晚 100ms（实测两者本就同一份时间轴） */
const txLrc = Array.from({ length: 8 }, (_, i) => `[00:${String(10 + i * 4).padStart(2, '0')}.100]第${i + 1}行字`).join('\n')

const txMusicInfo = {
  source: 'tx', songmid: 'TX001', name: '测试歌曲', singer: '测试歌手',
  interval: '03:00', types: [], _types: {}, typeUrl: {},
}

function resetBorrowMocks() {
  resetSidecarMocks()   // 里面已含 lyricCache.clear()
  fetchKugouWordLyric.mockReset()
  findManyMusic.mockReset().mockResolvedValue([{ songmid: 'KG001', data: JSON.stringify({ source: 'kg', songmid: 'KG001', name: '测试歌曲', hash: 'KGHASH', interval: '03:00' }) }])
}

describe('跨源借逐字', () => {
  it('播 QQ 的歌、库里有同款酷狗副本时，借到的字时间挂在本源行时间上，整行文本一字不改', async () => {
    resetBorrowMocks()
    stubSidecars({})
    fetchNativeLyric.mockResolvedValue({ lyric: txLrc, tlyric: null })
    fetchKugouWordLyric.mockResolvedValue(borrowKrc)

    const result = await fetchLyricForMusic(txMusicInfo)
    expect(result?.lyric).toBe(txLrc)
    // 行尾取"下一行的起点"（本源的节奏），不是借来那行自己的时长
    expect(result?.wordLyric).toContain('[00:10.100]<00:10.100>第1行<00:12.100>字<00:14.100>')
    expect(rename).toHaveBeenCalledWith(expect.stringContaining('song.wlrc.tmp-'), path.resolve('/audio-cache', 'aa', 'song.wlrc'))
    expect(fetchKugouWordLyric).toHaveBeenCalledWith(expect.objectContaining({ hash: 'KGHASH' }))
  })

  it('播酷我的歌、库里有同款酷狗副本时同样能借（实测两侧行时间 0ms 同一份）', async () => {
    resetBorrowMocks()
    stubSidecars({})
    fetchNativeLyric.mockResolvedValue({ lyric: txLrc, tlyric: null })
    fetchKugouWordLyric.mockResolvedValue(borrowKrc)

    const result = await fetchLyricForMusic({ ...txMusicInfo, source: 'kw', songmid: 'KW001' })
    expect(result?.lyric).toBe(txLrc)
    expect(result?.wordLyric).toContain('[00:10.100]<00:10.100>第1行<00:12.100>字<00:14.100>')
    expect(fetchKugouWordLyric).toHaveBeenCalledWith(expect.objectContaining({ hash: 'KGHASH' }))
  })

  it('酷我但库里没有可借的酷狗兄弟行时，一次上游都不打', async () => {
    resetBorrowMocks()
    stubSidecars({})
    findManyMusic.mockResolvedValue([])
    fetchNativeLyric.mockResolvedValue({ lyric: txLrc, tlyric: null })
    fetchKugouWordLyric.mockResolvedValue(borrowKrc)

    const result = await fetchLyricForMusic({ ...txMusicInfo, source: 'kw', songmid: 'KW_NODONOR' })
    expect(result?.wordLyric).toBeNull()
    expect(fetchKugouWordLyric).not.toHaveBeenCalled()
  })

  it('网易不借（实测行时间中位差 200~500ms 且常是另一个版本，对齐率低到 22%）', async () => {
    resetBorrowMocks()
    stubSidecars({})
    fetchNativeLyric.mockResolvedValue({ lyric: txLrc, tlyric: null })

    const result = await fetchLyricForMusic({ ...txMusicInfo, source: 'wy' })
    expect(result?.wordLyric).toBeNull()
    expect(findManyMusic).not.toHaveBeenCalled()
    expect(fetchKugouWordLyric).not.toHaveBeenCalled()
  })

  it('借来的歌词与本源行文本对不上（不是同一版本）就不借，并删掉残留 .wlrc', async () => {
    resetBorrowMocks()
    stubSidecars({})
    fetchNativeLyric.mockResolvedValue({ lyric: txLrc, tlyric: null })
    fetchKugouWordLyric.mockResolvedValue(parseKrc(Array.from({ length: 8 }, (_, i) =>
      `[${10_000 + i * 4000},3000]<0,2000,0>别的<2000,1000,0>词${i}`).join('\n'))!)

    const result = await fetchLyricForMusic(txMusicInfo)
    expect(result?.wordLyric).toBeNull()
    expect(unlink).toHaveBeenCalledWith(path.resolve('/audio-cache', 'aa', 'song.wlrc'))
  })

  it('借来的行时间整体差超过 ±300ms 就不借（网易那种量级）', async () => {
    resetBorrowMocks()
    stubSidecars({})
    fetchNativeLyric.mockResolvedValue({ lyric: Array.from({ length: 8 }, (_, i) => `[00:${String(13 + i * 4).padStart(2, '0')}.000]第${i + 1}行字`).join('\n'), tlyric: null })
    fetchKugouWordLyric.mockResolvedValue(borrowKrc)

    await expect(fetchLyricForMusic(txMusicInfo)).resolves.toMatchObject({ wordLyric: null })
  })

  it('兄弟行没有 hash、或酷狗那边过不了闸门时不借', async () => {
    resetBorrowMocks()
    stubSidecars({})
    fetchNativeLyric.mockResolvedValue({ lyric: txLrc, tlyric: null })
    fetchKugouWordLyric.mockResolvedValue(null)
    await expect(fetchLyricForMusic(txMusicInfo)).resolves.toMatchObject({ wordLyric: null })

    resetBorrowMocks()
    findManyMusic.mockResolvedValue([{ songmid: 'KG002', data: JSON.stringify({ source: 'kg', songmid: 'KG002', name: '测试歌曲' }) }])
    await expect(fetchLyricForMusic(txMusicInfo)).resolves.toMatchObject({ wordLyric: null })
    expect(fetchKugouWordLyric).not.toHaveBeenCalled() // 兄弟行没 hash 就不该打上游
  })

  it('本源自己已有逐字时不去借（不多打一次上游）', async () => {
    resetBorrowMocks()
    stubSidecars({})
    // 本源自带的逐字：行数与行时间都与整行一致才可用
    const own = Array.from({ length: 8 }, (_, i) => `[00:${10 + i * 4}.100]<00:${10 + i * 4}.100>第${i + 1}行<00:${12 + i * 4}.100>字<00:${14 + i * 4}.100>`).join('\\n')
    fetchNativeLyric.mockResolvedValue({ lyric: txLrc, tlyric: null, wordLyric: own })

    const result = await fetchLyricForMusic(txMusicInfo)
    expect(result?.wordLyric).toBe(own)
    expect(fetchKugouWordLyric).not.toHaveBeenCalled()
  })
})

// ————— 早退缺陷的修补：整行命中缓存 ≠ 逐字命中缓存 —————
describe('缓存里只有整行、缺逐字时的补取', () => {
  const ownWord = Array.from({ length: 8 }, (_, i) => `[00:${10 + i * 4}.100]<00:${10 + i * 4}.100>第${i + 1}行<00:${12 + i * 4}.100>字<00:${14 + i * 4}.100>`).join('\n')

  it('kg 行（带 hash）会补取一次，并把整行与逐字一起重写', async () => {
    resetBorrowMocks()
    stubSidecars({ 'song.lrc': '[00:10.100]第1行字' })   // 只有整行，没有 .wlrc
    findFirstMusic.mockResolvedValue(null)
    fetchNativeLyric.mockResolvedValue({ lyric: txLrc, tlyric: null, wordLyric: ownWord })

    const result = await fetchLyricForMusic({ ...kgMusicInfo, songmid: 'KG_RETRY_1' })
    expect(fetchNativeLyric).toHaveBeenCalledTimes(1)
    expect(result?.wordLyric).toBe(ownWord)
    const written = rename.mock.calls.map(c => String(c[1]))
    expect(written).toContain(path.resolve('/audio-cache', 'aa', 'song.lrc'))
    expect(written).toContain(path.resolve('/audio-cache', 'aa', 'song.wlrc'))
  })

  it('同一首在一轮补取失败后不再重试（否则每次播放都白打上游）', async () => {
    resetBorrowMocks()
    stubSidecars({ 'song.lrc': '[00:10.100]第1行字' })
    findFirstMusic.mockResolvedValue(null)
    fetchNativeLyric.mockResolvedValue({ lyric: txLrc, tlyric: null })   // 网络有整行、就是没逐字

    const info = { ...kgMusicInfo, songmid: 'KG_RETRY_2' }
    const first = await fetchLyricForMusic(info)
    expect(first?.wordLyric).toBeNull()
    expect(fetchNativeLyric).toHaveBeenCalledTimes(1)

    const second = await fetchLyricForMusic(info)
    expect(fetchNativeLyric).toHaveBeenCalledTimes(1)   // 第二次直接吃缓存，不再打上游
    expect(second?.wordLyric).toBeNull()
  })

  it('mg 行没有 mrcUrl 就不补取（它本来不可能有逐字）', async () => {
    resetBorrowMocks()
    stubSidecars({ 'song.lrc': '[00:10.100]第1行字' })
    fetchNativeLyric.mockResolvedValue({ lyric: txLrc, tlyric: null, wordLyric: ownWord })

    const result = await fetchLyricForMusic({ ...kgMusicInfo, source: 'mg', songmid: 'MG_NO_MRC', mrcUrl: undefined })
    expect(result?.wordLyric).toBeNull()
    expect(fetchNativeLyric).not.toHaveBeenCalled()
  })

  it('tx 行没有数字 songID 时，只在库里确有带 hash 的酷狗兄弟才补取', async () => {
    resetBorrowMocks()
    stubSidecars({ 'song.lrc': '[00:10.100]第1行字' })
    fetchNativeLyric.mockResolvedValue({ lyric: txLrc, tlyric: null })
    findFirstMusic.mockResolvedValue(null)
    await fetchLyricForMusic({ ...txMusicInfo, songmid: 'TX_NO_DONOR' })
    expect(fetchNativeLyric).not.toHaveBeenCalled()

    resetBorrowMocks()
    stubSidecars({ 'song.lrc': '[00:10.100]第1行字' })
    findFirstMusic.mockResolvedValue({ songmid: 'KG001' })
    fetchNativeLyric.mockResolvedValue({ lyric: txLrc, tlyric: null, wordLyric: ownWord })
    await fetchLyricForMusic({ ...txMusicInfo, songmid: 'TX_WITH_DONOR' })
    expect(fetchNativeLyric).toHaveBeenCalledTimes(1)
  })

  it('tx 行自带数字 songID 时不必等酷狗兄弟，它有自己的云端 QRC', async () => {
    resetBorrowMocks()
    stubSidecars({ 'song.lrc': '[00:10.100]第1行字' })
    findFirstMusic.mockResolvedValue(null)   // 库里没有可借的兄弟行
    fetchNativeLyric.mockResolvedValue({ lyric: txLrc, tlyric: null, wordLyric: ownWord })
    const result = await fetchLyricForMusic({ ...txMusicInfo, songmid: 'TX_OWN_QRC', songId: '8136' })
    expect(fetchNativeLyric).toHaveBeenCalledTimes(1)
    expect(result?.wordLyric).toBe(ownWord)
  })

  it('缓存里逐字已经在，就直接用、不打上游', async () => {
    resetBorrowMocks()
    stubSidecars({ 'song.lrc': '[00:10.100]第1行字', 'song.wlrc': ownWord })
    fetchNativeLyric.mockResolvedValue({ lyric: txLrc, tlyric: null, wordLyric: ownWord })

    const result = await fetchLyricForMusic({ ...kgMusicInfo, songmid: 'KG_HAS_WLRC' })
    expect(result?.wordLyric).toBe(ownWord)
    expect(fetchNativeLyric).not.toHaveBeenCalled()
  })
})

describe('取词结果的内存缓存', () => {
  it('同一首连续要两次（底栏与全屏页各自订阅），上游只被打一次', async () => {
    resetBorrowMocks()
    stubSidecars({})
    fetchNativeLyric.mockResolvedValue({ lyric: '[00:01.000]一次取词', tlyric: null })
    const info = { ...kgMusicInfo, songmid: 'MEMO_ONCE' }

    const first = await fetchLyricForMusic(info)
    const second = await fetchLyricForMusic(info)
    expect(fetchNativeLyric).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })

  it('取词失败不进缓存：下次播放还要再试（不能把一次抖动固化成"没歌词"）', async () => {
    resetBorrowMocks()
    stubSidecars({})
    fetchNativeLyric.mockResolvedValue(null)
    getLyric.mockResolvedValue(null)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    const info = { ...kgMusicInfo, songmid: 'MEMO_FAIL' }

    await expect(fetchLyricForMusic(info)).resolves.toBeNull()
    await expect(fetchLyricForMusic(info)).resolves.toBeNull()
    expect(fetchNativeLyric).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
  })

  it('不同歌曲互不干扰', async () => {
    resetBorrowMocks()
    stubSidecars({})
    fetchNativeLyric
      .mockResolvedValueOnce({ lyric: '[00:01.000]甲歌', tlyric: null })
      .mockResolvedValueOnce({ lyric: '[00:02.000]乙歌', tlyric: null })

    await expect(fetchLyricForMusic({ ...kgMusicInfo, songmid: 'MEMO_A' })).resolves.toMatchObject({ lyric: '[00:01.000]甲歌' })
    await expect(fetchLyricForMusic({ ...kgMusicInfo, songmid: 'MEMO_B' })).resolves.toMatchObject({ lyric: '[00:02.000]乙歌' })
    expect(fetchNativeLyric).toHaveBeenCalledTimes(2)
  })
})

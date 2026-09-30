import { describe, expect, it, vi } from 'vitest'
import path from 'path'

const { findMany, getLyric, fetchNativeLyric, access, readFile, writeFile, rename, unlink } = vi.hoisted(() => ({
  findMany: vi.fn(),
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

vi.mock('@/lib/db', () => ({ prisma: { audioCache: { findMany } } }))
vi.mock('@/lib/music-source-manager', () => ({ musicSourceManager: { getLyric } }))
vi.mock('@/lib/server/music-lyric', () => ({ fetchNativeLyric }))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

vi.mock('fs/promises', () => {
  const api = { access, readFile, writeFile, rename, unlink }
  return { default: api, ...api }
})

const { cacheNativeLyricForMusic } = await import('./lyrics')

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

const kgMusicInfo = {
  source: 'kg', songmid: 'KGHASH', name: '测试歌曲', singer: '测试歌手',
  interval: '03:00', types: [], _types: {}, typeUrl: {},
}
const ENHANCED = '[01:20.000]<01:20.000>第1字<01:21.000>末字<01:23.000>'

function resetSidecarMocks() {
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

  it('只有 .lrc 时 wordLyric 为 null，不影响整行返回', async () => {
    resetSidecarMocks()
    stubSidecars({ 'song.lrc': '[01:20.000]第1字末字' })

    await expect(fetchLyricForMusic(kgMusicInfo)).resolves.toEqual({
      lyric: '[01:20.000]第1字末字', tlyric: null, wordLyric: null,
    })
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

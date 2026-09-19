/**
 * lib/services/music-library.ts 单元测试
 *
 * 覆盖「容器嗅探入库门槛」（3a）：
 * - 字节无法证明是已知音频容器（高熵垃圾，如实测中的「随机数据被误存为 mp3」）
 *   → 拒绝入库，文件留在缓存（仍可播放，LRU 自然淘汰）
 * - 合法容器（ID3 头）→ 正常入库登记
 *
 * 不用「时长探测失败」当门槛的原因（实测结论）：库内 302 个可正常播放的文件
 * 里 116 个 music-metadata 解析不出时长（FLAC STREAMINFO 异常、ADTS/AAC 流等），
 * 而容器嗅探只否掉那 1 个真坏文件，零误伤。
 *
 * 注意：getAudioServeConfig/getLibraryConfig 是模块级缓存，所以 env 必须在
 * import 之前设置好，且整个文件共用同一套临时目录。
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

vi.mock('@/lib/db', () => ({
  prisma: {
    audioCache: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    librarySong: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      aggregate: vi.fn(async () => ({ _sum: { fileSize: 0 } })),
    },
  },
  getStorageSongmidForMusicInfo: vi.fn((mi: { songmid: string }) => mi.songmid),
}))

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// env 必须先于服务模块 import（配置单例在首次调用时固化）
const tmpRoot = path.join(os.tmpdir(), `music-library-test-${Date.now()}-${process.pid}`)
const cacheDir = path.join(tmpRoot, 'cache')
const libraryDir = path.join(tmpRoot, 'library')
process.env.AUDIO_CACHE_DIR = cacheDir
process.env.AUDIO_LIBRARY_DIR = libraryDir

const { ingestFromCache } = await import('@/lib/services/music-library')
const { prisma } = await import('@/lib/db')

const musicInfo = {
  source: 'kw',
  songmid: 'sm-test',
  name: '测试歌',
  singer: '测试歌手',
  albumName: '测试专辑',
  interval: '03:45',
} as never

/** 高熵垃圾字节（无控制字符特征、非文本开头 → unverified） */
function garbageBuffer(n: number): Buffer {
  const buf = Buffer.alloc(n)
  let seed = 7
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    buf[i] = seed % 256
  }
  return buf
}

beforeAll(async () => {
  await fsp.mkdir(cacheDir, { recursive: true })
  await fsp.mkdir(libraryDir, { recursive: true })
})

afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  delete process.env.AUDIO_CACHE_DIR
  delete process.env.AUDIO_LIBRARY_DIR
})

beforeEach(() => {
  vi.mocked(prisma.librarySong.findMany).mockImplementation(async () => [])
  vi.mocked(prisma.librarySong.aggregate).mockImplementation(
    async () => ({ _sum: { fileSize: 0 } }) as never
  )
})

afterEach(async () => {
  // 清空两个目录内容（保留根目录，配置缓存的路径仍然有效）
  for (const dir of [cacheDir, libraryDir]) {
    for (const e of await fsp.readdir(dir).catch(() => [])) {
      await fsp.rm(path.join(dir, e), { recursive: true, force: true })
    }
  }
  vi.restoreAllMocks()
})

/** 在缓存目录放置一个已完成文件并让 audioCache.findUnique 命中 */
async function stageCacheFile(rel: string, content: Buffer, contentType: string) {
  const abs = path.join(cacheDir, rel)
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  await fsp.writeFile(abs, content)
  vi.mocked(prisma.audioCache.findUnique).mockImplementation(
    async () =>
      ({ cacheKey: 'kw:sm-test:320k', filePath: rel, size: content.length, contentType }) as never
  )
  return abs
}

describe('ingestFromCache 容器嗅探入库门槛', () => {
  it('未知容器的垃圾文件 → 拒绝入库，文件保留在缓存', async () => {
    const content = garbageBuffer(64 * 1024)
    const cacheAbs = await stageCacheFile('ab/cdef0123.mp3', content, 'audio/mpeg')

    const result = await ingestFromCache('kw:sm-test:320k', musicInfo, '320k')

    expect(result.status).toBe('skip-error')
    expect(result.message).toContain('容器校验未通过')
    // 不写登记行，文件仍在缓存目录（可继续当缓存播放，LRU 自然淘汰）
    expect(prisma.librarySong.create).not.toHaveBeenCalled()
    await expect(fsp.stat(cacheAbs)).resolves.toBeTruthy()
  })

  it('HTML 假地址文件（若历史缓存残留）→ 同样拒绝入库', async () => {
    const content = Buffer.concat([
      Buffer.from('<!DOCTYPE html><html><body>404</body></html>'),
      Buffer.alloc(1024, 0x20),
    ])
    await stageCacheFile('ab/cdef4567.mp3', content, 'audio/mpeg')

    const result = await ingestFromCache('kw:sm-test:320k', musicInfo, '320k')

    expect(result.status).toBe('skip-error')
    expect(result.message).toContain('容器校验未通过')
    expect(prisma.librarySong.create).not.toHaveBeenCalled()
  })

  it('合法容器（ID3 头）→ 正常入库登记', async () => {
    const content = Buffer.concat([Buffer.from('ID3\x03\x00'), Buffer.alloc(128 * 1024, 0x42)])
    await stageCacheFile('ab/cdef89ab.mp3', content, 'audio/mpeg')

    const result = await ingestFromCache('kw:sm-test:320k', musicInfo, '320k')

    expect(result.status).toBe('ingested')
    expect(prisma.librarySong.create).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(prisma.librarySong.create).mock.calls[0][0] as {
      data: { name: string; singer: string; quality: string; fileSize: number }
    }
    expect(arg.data.name).toBe('测试歌')
    expect(arg.data.quality).toBe('320k')
    expect(arg.data.fileSize).toBe(content.length)
  })

  it('缓存文件已丢失（DB 记录悬空）→ skip-error，不写登记行', async () => {
    const content = Buffer.concat([Buffer.from('ID3\x03\x00'), Buffer.alloc(64 * 1024, 0x42)])
    const abs = await stageCacheFile('ab/cdefdead.mp3', content, 'audio/mpeg')
    await fsp.unlink(abs) // 模拟磁盘文件丢失（DB 记录仍在）

    const result = await ingestFromCache('kw:sm-test:320k', musicInfo, '320k')

    expect(result.status).toBe('skip-error')
    expect(prisma.librarySong.create).not.toHaveBeenCalled()
  })
})

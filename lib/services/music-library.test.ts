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

// 真实时长解析器会在合成字节上读出野值（'fLaC' + 填充会被当成 STREAMINFO），
// 让「±4s 视为同一录音」的判定不可控。固定成"探不出来"，与生产里 302 个可播文件
// 中 116 个探不出时长的那批同形，此时入库回落到 interval。
vi.mock('@/lib/server/audio-integrity', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/server/audio-integrity')>()
  return { ...actual, parseDurationFromFile: vi.fn(async () => null) }
})

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

  it('FLAC 字节 + 记录里谎报的 audio/mpeg → 入库扩展名按容器走 .flac', async () => {
    // 复现全库实测缺陷：源把 FLAC 字节配 audio/mpeg 头返回，缓存文件名与 AudioCache
    // 行都被定成 .mp3，入库若照抄记录就得到一个名叫 .mp3 的 FLAC 正本（115/228 例）
    const content = Buffer.concat([
      Buffer.from('fLaC\x00\x00\x00"'),
      Buffer.alloc(128 * 1024, 0x11),
    ])
    await stageCacheFile('cd/flac0001.mp3', content, 'audio/mpeg')

    const result = await ingestFromCache('kw:sm-test:320k', musicInfo, '320k')

    expect(result.status).toBe('ingested')
    const arg = vi.mocked(prisma.librarySong.create).mock.calls[0][0] as unknown as {
      data: { filePath: string; quality: string }
    }
    expect(arg.data.filePath).toMatch(/\.flac$/)
    // 记账不高于请求档：字节是真 flac，但这次请求的是 320k，就按 320k 记
    expect(arg.data.quality).toBe('320k')
  })
})

/**
 * 2026-11-19 生产普查出的病：514 行 quality='flac' 里只有 447 行字节真是 FLAC，
 * 其余 67 行是 ID3/mp3、Ogg Vorbis（《晚秋》2.0MB/212s = 80kbps）和一份认不出容器的。
 * 病根是入库照抄"请求了哪档"，而去重那步是「库内已有同档或更高就放弃」——
 * 一份冒充无损的有损文件会永久挡住后来的真 flac，且库优先于在线源、没有自愈路径。
 */
describe('ingestFromCache 记账档位以字节为准', () => {
  it('请求 flac、字节是 80kbps 的 Ogg → 记 128k（不再冒充无损）', async () => {
    // 2_250_000 字节 / 225s（musicInfo.interval=03:45）= 80kbps，与《晚秋》同量级
    const content = Buffer.concat([Buffer.from('OggS\x00\x02'), Buffer.alloc(2_250_000, 0x20)])
    await stageCacheFile('ab/ogg00001.ogg', content, 'audio/ogg')

    const result = await ingestFromCache('kw:sm-test:320k', musicInfo, 'flac')

    expect(result.status).toBe('ingested')
    const arg = vi.mocked(prisma.librarySong.create).mock.calls[0][0] as unknown as {
      data: { quality: string; filePath: string }
    }
    expect(arg.data.quality).toBe('128k')
    expect(arg.data.filePath).toMatch(/\.ogg$/)
  })

  it('有损档之间不改判：请求 320k 拿到 80kbps 的 Ogg 仍记 320k（病例只在无损那一档）', async () => {
    const content = Buffer.concat([Buffer.from('OggS\x00\x02'), Buffer.alloc(2_250_000, 0x20)])
    await stageCacheFile('ab/ogg00002.ogg', content, 'audio/ogg')

    const result = await ingestFromCache('kw:sm-test:320k', musicInfo, '320k')

    expect(result.status).toBe('ingested')
    const arg = vi.mocked(prisma.librarySong.create).mock.calls[0][0] as unknown as {
      data: { quality: string }
    }
    expect(arg.data.quality).toBe('320k')
  })

  it('库里已记成 128k 的那份不再挡路：后来的真 flac 字节照常入库并替换旧行', async () => {
    vi.mocked(prisma.librarySong.findMany).mockImplementation(async () => [
      { id: 7, quality: '128k', durationSec: 225.0, filePath: '/somewhere/old.ogg' } as never
    ])
    const content = Buffer.concat([
      Buffer.from('fLaC\x00\x00\x00"'),
      Buffer.alloc(1024 * 1024, 0x11),
    ])
    await stageCacheFile('ab/flac0002.flac', content, 'audio/flac')

    const result = await ingestFromCache('kw:sm-test:320k', musicInfo, 'flac')

    expect(result.status).toBe('ingested')
    expect(vi.mocked(prisma.librarySong.create).mock.calls[0][0]).toHaveProperty(['data', 'quality'], 'flac')
    // 被替换的旧行与旧文件一起清掉，否则那 2MB 垃圾还占着配额
    expect(prisma.librarySong.delete).toHaveBeenCalledWith({ where: { id: 7 } })
  })
})

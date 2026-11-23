/**
 * lib/audio-serve.ts 单元测试
 *
 * 核心覆盖「跟随交付」语义（修复：miss 时截断为片段的缺陷）：
 * - miss + 无 Range → 200 + Content-Length=完整大小 + body 收齐全部字节
 * - miss + Range → 206 完整区间（不按已下载字节数截断）
 * - 上游中途失败 → 响应头正常但 body 流 error（客户端可感知，非假成功）
 * - 多客户端并发 → 上游只打一次，各自拿到完整文件
 * - 命中磁盘缓存 → 现状回归（200/206 从磁盘一次读）
 *
 * 通过 vi.mock 隔离 prisma 与 logger；磁盘用临时目录（AUDIO_CACHE_DIR）；
 * 上游用 mock fetch 返回慢速分块 ReadableStream。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

// --- mock prisma / logger ---------------------------------------------------

vi.mock('@/lib/db', () => ({
  prisma: {
    audioCache: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      aggregate: vi.fn(async () => ({ _sum: { size: 0 } })),
      count: vi.fn(async () => 0),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// 时长闸门（占位定性的第二个信号）由测试控制。默认"时长对得上"，与真实
// checkTrialAudio 在合成字节上解析失败时的行为一致，所以其余用例行为不变。
const { checkTrialAudioMock } = vi.hoisted(() => ({
  checkTrialAudioMock: vi.fn(async () => ({ trial: false, actualSec: null as number | null })),
}))
// 时长/长度判据要跑真实现，否则新分支在测试里是 undefined、永远不亮
vi.mock('@/lib/server/audio-integrity', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server/audio-integrity')>(
    '@/lib/server/audio-integrity'
  )
  return {
    checkTrialAudio: checkTrialAudioMock,
    judgePayloadLength: actual.judgePayloadLength,
  }
})

const { audioServe, _resetAudioServeConfigForTest } = await import('@/lib/audio-serve')
const { prisma } = await import('@/lib/db')
const { sourceHealth } = await import('@/lib/server/source-health')
const { fingerprintStats, resetFingerprintsForTest } = await import('@/lib/server/audio-fingerprint')
type UpstreamUrlResolver = import('@/lib/audio-serve').UpstreamUrlResolver

// --- 辅助 --------------------------------------------------------------------

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let cacheDir = ''
let dirSeq = 0
let originalFetch: typeof globalThis.fetch

/** 生成确定性伪随机字节块（总大小 total，分 chunkCount 块） */
function makeChunks(total: number, chunkCount: number): Buffer[] {
  const per = Math.ceil(total / chunkCount)
  const chunks: Buffer[] = []
  let remaining = total
  let seed = 7
  while (remaining > 0) {
    const n = Math.min(per, remaining)
    const buf = Buffer.alloc(n)
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648
      buf[i] = seed % 256
    }
    chunks.push(buf)
    remaining -= n
  }
  // 2026-11-14 起，"首块认不出已知容器"就是坏证据（生产那 7 份 QMC2 密文靠这条识破）。
  // 纯伪随机字节会被直接拒，所以夹具也要带上真容器头：前 10 字节写成 ID3，其余保持伪随机
  // ——容器嗅探只看前 64 字节，时长闸门又被 mock 掉了，后面的字节是什么不影响任何断言。
  if (chunks.length > 0 && total >= 10) {
    Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1').copy(chunks[0], 0)
  }
  return chunks
}

/** mock 全局 fetch 为「慢速分块上游」：每块间隔 delayMs 发出。返回 spy 与总大小。 */
function mockSlowUpstream(chunks: Buffer[], delayMs: number) {
  const total = chunks.reduce((s, c) => s + c.length, 0)
  const spy = vi.fn(async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const c of chunks) {
          await sleep(delayMs)
          controller.enqueue(new Uint8Array(c))
        }
        controller.close()
      },
    })
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'audio/mpeg',
        'content-length': String(total),
      },
    })
  })
  globalThis.fetch = spy as unknown as typeof fetch
  return { spy, total, expected: Buffer.concat(chunks) }
}

function resolver(): () => Promise<string> {
  return async () => 'https://example.com/song.mp3'
}

// --- 生命周期 ------------------------------------------------------------------

beforeEach(async () => {
  cacheDir = path.join(os.tmpdir(), `audio-serve-test-${Date.now()}-${dirSeq++}`)
  process.env.AUDIO_CACHE_DIR = cacheDir
  _resetAudioServeConfigForTest()
  sourceHealth.reset()
  resetFingerprintsForTest()
  checkTrialAudioMock.mockReset()
  checkTrialAudioMock.mockResolvedValue({ trial: false, actualSec: null })
  await fsp.mkdir(cacheDir, { recursive: true })
  vi.mocked(prisma.audioCache.findUnique).mockImplementation(async () => null)
  vi.mocked(prisma.audioCache.aggregate).mockImplementation(async () => ({ _sum: { size: 0 } }))
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  delete process.env.AUDIO_CACHE_DIR
  await fsp.rm(cacheDir, { recursive: true, force: true }).catch(() => {})
  vi.restoreAllMocks()
})

// ===========================================================================
// miss + 跟随交付（本次修复核心）
// ===========================================================================

describe('AudioServe.serve() 缓存 miss → 跟随交付', () => {
  it('无 Range → 200 + Content-Length=完整大小 + body 收齐全部字节', async () => {
    const { total, expected } = mockSlowUpstream(makeChunks(100_000, 4), 10)

    const resp = await audioServe.serve({
      cacheKey: 'kw:t1:320k',
      upstreamUrlResolver: resolver(),
      rangeHeader: null,
      isHead: false,
    })

    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-length')).toBe(String(total))
    expect(resp.headers.get('accept-ranges')).toBe('bytes')
    const body = Buffer.from(await resp.arrayBuffer())
    expect(body.length).toBe(total)
    expect(body.equals(expected)).toBe(true)
  })

  it('Range: bytes=0- → 206 且 Content-Range 覆盖完整区间', async () => {
    const { total, expected } = mockSlowUpstream(makeChunks(100_000, 4), 10)

    const resp = await audioServe.serve({
      cacheKey: 'kw:t2:320k',
      upstreamUrlResolver: resolver(),
      rangeHeader: 'bytes=0-',
      isHead: false,
    })

    expect(resp.status).toBe(206)
    expect(resp.headers.get('content-range')).toBe(`bytes 0-${total - 1}/${total}`)
    expect(resp.headers.get('content-length')).toBe(String(total))
    const body = Buffer.from(await resp.arrayBuffer())
    expect(body.length).toBe(total)
    expect(body.equals(expected)).toBe(true)
  })

  it('Range: bytes=100-199 → 206 精确区间字节', async () => {
    const { expected } = mockSlowUpstream(makeChunks(100_000, 4), 10)

    const resp = await audioServe.serve({
      cacheKey: 'kw:t3:320k',
      upstreamUrlResolver: resolver(),
      rangeHeader: 'bytes=100-199',
      isHead: false,
    })

    expect(resp.status).toBe(206)
    expect(resp.headers.get('content-range')).toBe(`bytes 100-199/${expected.length}`)
    expect(resp.headers.get('content-length')).toBe('100')
    const body = Buffer.from(await resp.arrayBuffer())
    expect(body.length).toBe(100)
    expect(body.equals(expected.subarray(100, 200))).toBe(true)
  })

  it('HEAD 请求 → 只返回完整头，不带 body', async () => {
    const { total } = mockSlowUpstream(makeChunks(10_000, 2), 10)

    const resp = await audioServe.serve({
      cacheKey: 'kw:t4:320k',
      upstreamUrlResolver: resolver(),
      rangeHeader: null,
      isHead: true,
    })

    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-length')).toBe(String(total))
    expect(resp.body).toBeNull()
  })

  it('上游提前断流（字节数不足）→ 响应头正常但 body 流 error（客户端可感知失败）', async () => {
    // 声明 50000 字节，实际只发 10000 字节就 close —— 触发 runDownload 的
    // 大小校验失败 → entry.error → 跟随流 error（而非保存残缺的"假完整"文件）
    const sent = makeChunks(10_000, 1)[0]
    const total = 50_000
    globalThis.fetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          await sleep(10)
          controller.enqueue(new Uint8Array(sent))
          await sleep(30)
          controller.close()
        },
      })
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'audio/mpeg',
          'content-length': String(total),
        },
      })
    }) as unknown as typeof fetch

    const resp = await audioServe.serve({
      cacheKey: 'kw:t5:320k',
      upstreamUrlResolver: resolver(),
      rangeHeader: null,
      isHead: false,
    })

    // 头按上游声明的完整大小正常返回，失败体现在 body 流上
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-length')).toBe(String(total))
    await expect(resp.arrayBuffer()).rejects.toThrow()
  })

  it('两客户端并发（同一 cacheKey）→ 上游只打一次，各自拿到完整文件', async () => {
    const { spy, total, expected } = mockSlowUpstream(makeChunks(80_000, 4), 10)

    const [r1, r2] = await Promise.all([
      audioServe.serve({
        cacheKey: 'kw:t6:flac',
        upstreamUrlResolver: resolver(),
        rangeHeader: null,
        isHead: false,
      }),
      audioServe.serve({
        cacheKey: 'kw:t6:flac',
        upstreamUrlResolver: resolver(),
        rangeHeader: null,
        isHead: false,
      }),
    ])

    expect(spy).toHaveBeenCalledTimes(1)
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const [b1, b2] = await Promise.all([r1.arrayBuffer(), r2.arrayBuffer()])
    expect(b1.byteLength).toBe(total)
    expect(b2.byteLength).toBe(total)
    expect(Buffer.from(b1).equals(expected)).toBe(true)
    expect(Buffer.from(b2).equals(expected)).toBe(true)
  })
})

// ===========================================================================
// 假地址识别与换源重试（3a）
// ===========================================================================

describe('AudioServe.serve() 假地址识别与换源重试', () => {
  /** 合法音频载荷（ID3 头 + 填充字节，能通过容器嗅探） */
  const AUDIO = Buffer.concat([Buffer.from('ID3\x03\x00'), Buffer.alloc(4096, 0x42)])
  const HTML = '<!DOCTYPE html><html><body>需要开通VIP</body></html>'

  function payloadResponse(data: Buffer | string, ct: string): Response {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8')
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: { 'content-type': ct, 'content-length': String(body.length) },
    })
  }

  it('上游返回 HTML 假地址 → 排除该音源重新解析，第二个源成功（客户端无感知）', async () => {
    const fetchUrls: string[] = []
    const seenExcludes: string[][] = []
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      fetchUrls.push(url)
      return url.includes('bad.example')
        ? payloadResponse(HTML, 'text/html')
        : payloadResponse(AUDIO, 'audio/mpeg')
    }) as unknown as typeof fetch

    const upstreamUrlResolver: UpstreamUrlResolver = async excludeProviders => {
      seenExcludes.push([...excludeProviders])
      return excludeProviders.has('坏源A')
        ? { url: 'https://good.example/a.mp3', provider: '好源B' }
        : { url: 'https://bad.example/a.mp3', provider: '坏源A' }
    }

    const onCached = vi.fn(async () => {})
    const resp = await audioServe.serve({
      cacheKey: 'kw:fake1:320k',
      upstreamUrlResolver,
      rangeHeader: null,
      isHead: false,
      intervalSec: 0,
      onCached,
    })

    expect(resp.status).toBe(200)
    expect(fetchUrls).toHaveLength(2)
    expect(fetchUrls[1]).toContain('good.example')
    expect(seenExcludes[1]).toContain('坏源A')
    // 交付的是第二个源的真实字节，且正常缓存 + 入库
    expect(Buffer.from(await resp.arrayBuffer()).equals(AUDIO)).toBe(true)
    expect(prisma.audioCache.upsert).toHaveBeenCalledTimes(1)
    expect(onCached).toHaveBeenCalledTimes(1)

    // 字节段结论按 `音源×平台` 落账（provider 由 resolver 回传，平台退回 cacheKey 首段）
    expect(sourceHealth.view('坏源A', 'kw')?.badKinds['byte:fake']).toBe(1)
    expect(sourceHealth.view('好源B', 'kw')?.byteOk).toBe(1)
  })

  it('上游 404 → 同样换源重试（坏链路不再挡路）', async () => {
    const fetchUrls: string[] = []
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      fetchUrls.push(url)
      if (url.includes('dead.example')) return new Response('gone', { status: 404 })
      return payloadResponse(AUDIO, 'audio/mpeg')
    }) as unknown as typeof fetch

    const upstreamUrlResolver: UpstreamUrlResolver = async excludeProviders =>
      excludeProviders.has('挂源')
        ? { url: 'https://good.example/b.mp3', provider: '好源B' }
        : { url: 'https://dead.example/b.mp3', provider: '挂源' }

    const resp = await audioServe.serve({
      cacheKey: 'kw:fake2:320k',
      upstreamUrlResolver,
      rangeHeader: null,
      isHead: false,
      intervalSec: 0,
    })

    expect(resp.status).toBe(200)
    expect(fetchUrls).toHaveLength(2)
    expect(fetchUrls[1]).toContain('good.example')
  })

  it('所有音源都返回假地址 → 尝试 1+maxFakeRetries 次后失败（502，不落库）', async () => {
    const fetchSpy = vi.fn(async () => payloadResponse(HTML, 'text/html'))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const resp = await audioServe.serve({
      cacheKey: 'kw:fake3:320k',
      upstreamUrlResolver: async () => ({ url: 'https://bad.example/c.mp3', provider: '坏源' }),
      rangeHeader: null,
      isHead: false,
      intervalSec: 0,
    })

    expect(resp.status).toBe(502)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(prisma.audioCache.upsert).not.toHaveBeenCalled()
  })

  it('resolver 只回传裸地址（provider 未知）→ 无法排除重试，一次失败即终止', async () => {
    const fetchSpy = vi.fn(async () => payloadResponse(HTML, 'text/html'))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const resp = await audioServe.serve({
      cacheKey: 'kw:fake4:320k',
      upstreamUrlResolver: async () => 'https://bad.example/d.mp3',
      rangeHeader: null,
      isHead: false,
      intervalSec: 0,
    })

    expect(resp.status).toBe(502)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('字节认不出已知容器（声明还写着 audio/mpeg）→ 不落缓存，换源重试', async () => {
    // 2026-11-14 改：这类载荷不再"交给播放器判断"。生产实测它是 `.mflac` 的 QMC2 密文
    // （声明 audio/x-ogg、整包 30,276,517 字节、ffmpeg 连容器都开不了），旧行为是照样交付
    // 照样进缓存，于是以后每次命中原样重发、壳里报 UNSUPPORTED_FORMAT，且没有自愈路径。
    const body = Buffer.concat([
      Buffer.from('\x15W\n"N76ZqTHbxw\x9c\xd9\xdc', 'latin1'),
      Buffer.alloc(4096, 0x07),
    ])
    const good = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.alloc(4096, 0x21)])
    const fetchSpy = vi.fn(async (input: unknown) =>
      String(input).includes('weird.example')
        ? payloadResponse(body, 'audio/mpeg')
        : payloadResponse(good, 'audio/mpeg')
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const onCached = vi.fn(async () => {})
    const resp = await audioServe.serve({
      cacheKey: 'kw:suspect1:320k',
      upstreamUrlResolver: async excludeProviders =>
        excludeProviders.has('怪源')
          ? { url: 'https://good.example/e2.mp3', provider: '好源Z' }
          : { url: 'https://weird.example/e.mp3', provider: '怪源' },
      rangeHeader: null,
      isHead: false,
      intervalSec: 0,
      onCached,
    })

    expect(resp.status).toBe(200)
    expect(Buffer.from(await resp.arrayBuffer()).equals(good)).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const saved = vi.mocked(prisma.audioCache.upsert).mock.calls.map(c => c[0].create as { filePath?: string })
    expect(saved).toHaveLength(1) // 密文一行都没落盘，落的是换源后的那份
    expect(onCached).toHaveBeenCalledTimes(1)
    expect(sourceHealth.view('怪源', 'kw')?.badKinds['byte:fake']).toBe(1)
  })

  it('字节认不出容器**且**声明也不是音频（octet-stream 那类加密载荷）→ 不落缓存，换源重试', async () => {
    // 2026-10-10 真机形状：tx 的 320k 回了 1077 万字节高熵载荷，声明 application/octet-stream。
    // 闸门必须在**写盘之前**：一旦落进缓存，以后每次命中都原样发出去（网页转圈、音箱口 415），
    // 账本上还写着"这首歌已缓存"，没有任何自愈路径。
    const junk = Buffer.concat([
      Buffer.from('z52gdv4xS25dM0vms|x40o', 'latin1'),
      Buffer.from('\x00\x01\x02', 'latin1'), // 含控制字符 ⇒ 连"整段可打印"那条文本判据也不触发
      Buffer.alloc(4096, 0x7f),
    ])
    const fetchSpy = vi.fn(async (input: unknown) =>
      String(input).includes('junk.example')
        ? payloadResponse(junk, 'application/octet-stream')
        : payloadResponse(Buffer.from('ID3\x03\x00' + 'x'.repeat(4093), 'latin1'), 'audio/mpeg')
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const resp = await audioServe.serve({
      cacheKey: 'tx:junk1:320k',
      upstreamUrlResolver: async excludeProviders =>
        excludeProviders.has('垃圾源')
          ? { url: 'https://good.example/j1.mp3', provider: '好源B' }
          : { url: 'https://junk.example/j1.mp3', provider: '垃圾源' },
      rangeHeader: null,
      isHead: false,
      intervalSec: 0,
    })

    expect(resp.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    // 坏载荷一行都没落盘（旧行为是照样 upsert 一条 octet-stream）
    const saved = vi.mocked(prisma.audioCache.upsert).mock.calls.map(c => c[0].create as { contentType?: string | null })
    expect(saved.every(s => s.contentType === 'audio/mpeg')).toBe(true)
    expect(sourceHealth.view('垃圾源', 'tx')?.badKinds['byte:fake']).toBe(1)
  })

  it('所有源都给不出可辨音频 → 502 且不落缓存（不再留下会永久 415 的坏行）', async () => {
    const junk = Buffer.from('z52gdv4x\x00\x01\x02', 'latin1')
    const fetchSpy = vi.fn(async () => payloadResponse(junk, 'application/octet-stream'))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const resp = await audioServe.serve({
      cacheKey: 'tx:junk2:320k',
      upstreamUrlResolver: async () => ({ url: 'https://junk.example/j2.mp3', provider: '垃圾源' }),
      rangeHeader: null,
      isHead: false,
      intervalSec: 0,
    })

    expect(resp.status).toBe(502)
    expect(prisma.audioCache.upsert).not.toHaveBeenCalled()
  })

  // --- 交付长度判据（2026-11-24：主判据=首块解真实时长，字节比值退为兜底）--------
  // 这类载荷 HTTP 200、容器合法，字节嗅探放得过。生产实测 vkeys 的罐头字节恒 960887B，
  // 而库里 128k 那 40 行平均 15568 B/s（CBR 128k 应为 16000）⇒ 按 CBR 折算是 60.1 秒。
  // 夹具直接写 MPEG1 Layer-III 128kbps/44.1kHz 的帧头 FF FB 90 00，让时长判据通电。
  function mp3Payload(total: number): Buffer {
    const b = Buffer.alloc(total, 0x42)
    b[0] = 0xff; b[1] = 0xfb; b[2] = 0x90; b[3] = 0x00
    return b
  }
  /** m4a 的时长写在文件尾的 moov，首块解不出 ⇒ 只有这类才退回字节比值兜底 */
  function mp4Payload(total: number): Buffer {
    const b = Buffer.alloc(total, 0x41)
    b.writeUInt32BE(0x18, 0)
    b.write('ftyp', 4, 'latin1')
    b.write('M4A ', 8, 'latin1')
    return b
  }
  const CLIP60 = mp3Payload(960_887)        // ⇒ 60.1s
  const FULL_LOW = mp3Payload(4_078_961)    // ⇒ 254.9s，整曲低音质，不许误杀

  it('首块解出 60 秒而期望 200 秒 → 记 fake、排除该源，交付第二个源的整曲字节', async () => {
    const fetchUrls: string[] = []
    const seenExcludes: string[][] = []
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      fetchUrls.push(url)
      return url.includes('clip.example')
        ? payloadResponse(CLIP60, 'audio/mpeg')
        : payloadResponse(FULL_LOW, 'audio/mpeg')
    }) as unknown as typeof fetch

    const upstreamUrlResolver: UpstreamUrlResolver = async excludeProviders => {
      seenExcludes.push([...excludeProviders])
      return excludeProviders.has('片段源A')
        ? { url: 'https://good.example/full.mp3', provider: '好源B' }
        : { url: 'https://clip.example/clip.mp3', provider: '片段源A' }
    }

    const resp = await audioServe.serve({
      cacheKey: 'tx:len1:flac',
      upstreamUrlResolver,
      rangeHeader: null,
      isHead: false,
      intervalSec: 200,
    })

    expect(resp.status).toBe(200)
    expect(fetchUrls).toHaveLength(2)
    expect(seenExcludes[1]).toContain('片段源A')
    const body = await resp.arrayBuffer()
    expect(body.byteLength).toBe(FULL_LOW.length)
    expect(sourceHealth.view('片段源A', 'tx')?.badKinds['byte:fake']).toBe(1)
    expect(sourceHealth.view('好源B', 'tx')?.byteOk).toBe(1)
    expect(prisma.audioCache.upsert).toHaveBeenCalledTimes(1)
  })

  it('短歌不再漏检：同一份 60 秒罐头、期望 154 秒，仍然判死（0.35 那版正是这一档漏的）', async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      return url.includes('clip.example')
        ? payloadResponse(CLIP60, 'audio/mpeg')
        : payloadResponse(FULL_LOW, 'audio/mpeg')
    }) as unknown as typeof fetch

    const upstreamUrlResolver: UpstreamUrlResolver = async excludeProviders =>
      excludeProviders.has('短歌片段源')
        ? { url: 'https://good.example/f2.mp3', provider: '短歌好源' }
        : { url: 'https://clip.example/c2.mp3', provider: '短歌片段源' }

    const resp = await audioServe.serve({
      cacheKey: 'tx:len2:flac',
      upstreamUrlResolver,
      rangeHeader: null,
      isHead: false,
      intervalSec: 154,
      // 故意不传 minDeclaredBytes：主判据不依赖声明大小
    })

    const body = await resp.arrayBuffer()
    expect(body.byteLength).toBe(FULL_LOW.length)
    expect(sourceHealth.view('短歌片段源', 'tx')?.badKinds['byte:fake']).toBe(1)
  })

  it('合法整曲低音质 mp3（解出 254.9s / 期望 254s）→ 不许误杀', async () => {
    globalThis.fetch = vi.fn(async () => payloadResponse(FULL_LOW, 'audio/mpeg')) as unknown as typeof fetch

    const resp = await audioServe.serve({
      cacheKey: 'tx:len3:flac',
      upstreamUrlResolver: async () => ({ url: 'https://low.example/f3.mp3', provider: '低码率整曲源' }),
      rangeHeader: null,
      isHead: false,
      intervalSec: 254,
      minDeclaredBytes: 4_078_961,
    })

    expect(resp.status).toBe(200)
    const body = await resp.arrayBuffer()
    expect(body.byteLength).toBe(FULL_LOW.length)
    expect(sourceHealth.view('低码率整曲源', 'tx')?.byteOk).toBe(1)
  })

  it('双向对照兜底：m4a 解不出时长时，有声明就按比值拒、没声明就放过', async () => {
    const CLIP_MP4 = mp4Payload(100_000)
    globalThis.fetch = vi.fn(async () => payloadResponse(CLIP_MP4, 'audio/mp4')) as unknown as typeof fetch

    // resolver 按 excludeProviders 换源（生产的真实语义）：让每个 provider 只出现一次
    let seq = 0
    const rejected = await audioServe.serve({
      cacheKey: 'tx:len4a:flac',
      upstreamUrlResolver: async () => ({
        url: `https://mp4.example/a${seq}.m4a`,
        provider: `m4a片段源${++seq}`,
      }),
      rangeHeader: null,
      isHead: false,
      intervalSec: 200,
      minDeclaredBytes: 1_000_000,
    })
    expect(rejected.status).toBe(502)
    expect(sourceHealth.view('m4a片段源1', 'tx')?.badKinds['byte:fake']).toBe(1)
    expect(sourceHealth.view('m4a片段源2', 'tx')?.badKinds['byte:fake']).toBe(1)

    const passed = await audioServe.serve({
      cacheKey: 'tx:len4b:flac',
      upstreamUrlResolver: async () => ({ url: 'https://mp4.example/b.m4a', provider: 'm4a无声明源' }),
      rangeHeader: null,
      isHead: false,
      intervalSec: 200,
    })
    expect(passed.status).toBe(200)
    const body = await passed.arrayBuffer()
    expect(body.byteLength).toBe(CLIP_MP4.length)
    expect(sourceHealth.view('m4a无声明源', 'tx')?.badKinds?.['byte:fake']).toBeUndefined()
  })

  it('每只源都给 60 秒罐头 → 试满 1+8 次后明确失败（护栏 maxUndersizedRetries），不落缓存', async () => {
    const fetchSpy = vi.fn(async () => payloadResponse(CLIP60, 'audio/mpeg'))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    let seq = 0

    const resp = await audioServe.serve({
      cacheKey: 'tx:len5:flac',
      upstreamUrlResolver: async () => ({
        url: `https://clip.example/c5-${seq}.mp3`,
        provider: `罐头源${++seq}`,
      }),
      rangeHeader: null,
      isHead: false,
      intervalSec: 200,
    })

    expect(resp.status).toBe(502)
    expect(fetchSpy).toHaveBeenCalledTimes(9)
    expect(prisma.audioCache.upsert).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// contentType 以字节为准（上游把 FLAC 标成 audio/mpeg 是常态）
// ===========================================================================

describe('AudioServe.serve() 容器与上游声明不符', () => {
  function payloadResponse(data: Buffer, ct: string): Response {
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: { 'content-type': ct, 'content-length': String(data.length) },
    })
  }

  function upsertCreate() {
    const arg = vi.mocked(prisma.audioCache.upsert).mock.calls[0][0] as unknown as {
      create: { contentType: string | null; filePath: string }
    }
    return arg.create
  }

  it('FLAC 字节 + audio/mpeg 头 → 响应头、AudioCache 行、缓存文件名三处都按字节走', async () => {
    const flac = Buffer.concat([Buffer.from('fLaC\x00\x00\x00"'), Buffer.alloc(4096, 0x11)])
    globalThis.fetch = vi.fn(
      async () => payloadResponse(flac, 'audio/mpeg')
    ) as unknown as typeof fetch

    const resp = await audioServe.serve({
      cacheKey: 'kw:liar1:flac',
      upstreamUrlResolver: async () => ({
        url: 'https://example.com/liar.mp3',
        provider: '说谎源',
      }),
      rangeHeader: null,
      isHead: false,
      intervalSec: 0,
    })

    expect(resp.headers.get('content-type')).toContain('audio/flac')
    const created = upsertCreate()
    expect(created.contentType).toBe('audio/flac')
    // 缓存文件名同源于 contentType（extFromContentType），不再落成 .mp3
    expect(created.filePath).toMatch(/\.flac$/)
  })

  it('mp4 容器可能装视频 → 不覆盖上游声明，交回原逻辑定名', async () => {
    const mp4 = Buffer.alloc(4096, 0x00)
    mp4.write('ftyp', 4, 'ascii')
    globalThis.fetch = vi.fn(
      async () => payloadResponse(mp4, 'application/octet-stream')
    ) as unknown as typeof fetch

    const resp = await audioServe.serve({
      cacheKey: 'kw:mp4a:320k',
      upstreamUrlResolver: async () => ({
        url: 'https://example.com/maybe-mv',
        provider: '混发 MV 的源',
      }),
      rangeHeader: null,
      isHead: false,
      intervalSec: 0,
    })

    expect(resp.status).toBe(200)
    const created = upsertCreate()
    expect(created.contentType).toBe('application/octet-stream')
    expect(created.filePath).toMatch(/\.mp3$/)
  })
})

// ===========================================================================
// 命中磁盘缓存（现状回归）
// ===========================================================================

describe('AudioServe.serve() 命中磁盘缓存（回归保护）', () => {
  it('无 Range → 200 完整文件', async () => {
    const data = Buffer.concat([
      Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1'),
      Buffer.from('cached-audio-bytes-0123456789', 'latin1'),
    ])
    const relative = 'ab/cdef0123.mp3'
    const filePath = path.join(cacheDir, relative)
    await fsp.mkdir(path.dirname(filePath), { recursive: true })
    await fsp.writeFile(filePath, data)
    vi.mocked(prisma.audioCache.findUnique).mockImplementation(
      async () =>
        ({
          cacheKey: 'kw:hit1:320k',
          filePath: relative,
          size: data.length,
          contentType: 'audio/mpeg',
        }) as never
    )

    const resp = await audioServe.serve({
      cacheKey: 'kw:hit1:320k',
      upstreamUrlResolver: resolver(),
      rangeHeader: null,
      isHead: false,
    })

    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-length')).toBe(String(data.length))
    expect(Buffer.from(await resp.arrayBuffer()).equals(data)).toBe(true)
  })

  it('Range: bytes=5-9 → 206 精确区间', async () => {
    const data = Buffer.concat([
      Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1'),
      Buffer.from('cached-audio-bytes-0123456789', 'latin1'),
    ])
    const relative = 'ab/cdef0456.mp3'
    const filePath = path.join(cacheDir, relative)
    await fsp.mkdir(path.dirname(filePath), { recursive: true })
    await fsp.writeFile(filePath, data)
    vi.mocked(prisma.audioCache.findUnique).mockImplementation(
      async () =>
        ({
          cacheKey: 'kw:hit2:320k',
          filePath: relative,
          size: data.length,
          contentType: 'audio/mpeg',
        }) as never
    )

    const resp = await audioServe.serve({
      cacheKey: 'kw:hit2:320k',
      upstreamUrlResolver: resolver(),
      rangeHeader: 'bytes=5-9',
      isHead: false,
    })

    expect(resp.status).toBe(206)
    expect(resp.headers.get('content-range')).toBe(`bytes 5-9/${data.length}`)
    expect(Buffer.from(await resp.arrayBuffer()).equals(data.subarray(5, 10))).toBe(true)
  })

  it('账本里那份字节认不出容器（历史遗留的 octet-stream 行）→ 删行删文件、当 miss 重解析', async () => {
    // 写入侧加闸门之前，这类行是真被缓存下来的（dev 实测 6 行、178MB）。命中时旧行为是照样发出去
    // ⇒ 网页转圈、音箱口 415，而且账本看着像"已经缓存好"永远不会再试。所以读侧也要按字节自愈一次。
    const junk = Buffer.from('z52gdv4xS25dM0vms', 'latin1')
    const relative = 'ab/cdef0789.mp3'
    const filePath = path.join(cacheDir, relative)
    await fsp.mkdir(path.dirname(filePath), { recursive: true })
    await fsp.writeFile(filePath, junk)
    vi.mocked(prisma.audioCache.findUnique).mockImplementation(async () => ({
      cacheKey: 'tx:poison1:320k', filePath: relative, size: junk.length,
      contentType: 'application/octet-stream',
    }) as never)
    const good = Buffer.from('ID3\x03\x00' + 'y'.repeat(200), 'latin1')
    const fetchSpy = vi.fn(async () => payloadResponseStatic(good, 'audio/mpeg'))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const resp = await audioServe.serve({
      cacheKey: 'tx:poison1:320k',
      upstreamUrlResolver: async () => ({ url: 'https://good.example/p1.mp3', provider: '好源B' }),
      rangeHeader: null,
      isHead: false,
      intervalSec: 0,
    })

    expect(prisma.audioCache.delete).toHaveBeenCalledWith({ where: { cacheKey: 'tx:poison1:320k' } })
    expect(await fsp.readFile(filePath, 'utf-8').catch(() => null)).toBeNull()
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toContain('audio/mpeg')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  /**
   * 2026-11-14 生产形状：7 份 `tx:*:flac` 缓存行，声明写着 audio/x-ogg、文件名却是 .mp3，
   * 字节是 `.mflac` 的 QMC2 密文（头 16 字节就是现场那份）。旧读侧闸门只看声明，
   * `audio/*` 一律放行 ⇒ 每次点这首歌都原样重发同一份密文，播放器每次报不支持，
   * 账本上还挂着"这首歌已缓存好"，没有任何自愈路径。改按字节复核后必须被删掉重解析。
   */
  it('缓存命中 .mflac 密文（声明 audio/x-ogg）→ 删行删文件、换源重取（生产存量形状）', async () => {
    const cipher = Buffer.concat([
      Buffer.from('0b7f1212343444617e552734384a57587c2b648215c86e855afd5b9af0c73b0f', 'hex'),
      Buffer.alloc(4096, 0x5a),
    ])
    const relative = 'a8/8b2ed514f4a9b4ff495b43b64a61d89ad142c8c471c569fc9d236585c44be8.mp3'
    const filePath = path.join(cacheDir, relative)
    await fsp.mkdir(path.dirname(filePath), { recursive: true })
    await fsp.writeFile(filePath, cipher)
    vi.mocked(prisma.audioCache.findUnique).mockImplementation(async () => ({
      cacheKey: 'tx:002B2EAA3brD5b:flac', filePath: relative, size: cipher.length,
      contentType: 'audio/x-ogg',
    }) as never)
    const good = Buffer.concat([Buffer.from('fLaC\x00\x00\x00"', 'latin1'), Buffer.alloc(4096, 0x11)])
    const fetchSpy = vi.fn(async () => payloadResponseStatic(good, 'audio/x-ogg'))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const resp = await audioServe.serve({
      cacheKey: 'tx:002B2EAA3brD5b:flac',
      upstreamUrlResolver: async () => ({ url: 'https://good.example/qmc.flac', provider: '好源B' }),
      rangeHeader: null,
      isHead: false,
      intervalSec: 0,
    })

    expect(prisma.audioCache.delete).toHaveBeenCalledWith({ where: { cacheKey: 'tx:002B2EAA3brD5b:flac' } })
    expect(await fsp.readFile(filePath, 'utf-8').catch(() => null)).toBeNull()
    expect(resp.status).toBe(200)
    expect(Buffer.from(await resp.arrayBuffer()).equals(good)).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // 交付头按字节走 audio/flac，不再沿用那句撒谎的 x-ogg
    expect(resp.headers.get('content-type')).toContain('audio/flac')
  })

  it('老数据里 contentType 是空的行为什么不能一起删：它过去就是按 audio/mpeg 发的', async () => {
    // 闸门看的是字节，不是声明有没有写过。空声明是历史数据（写这列之前的行），
    // 只要字节认得出容器就照常交付；反过来声明写着 audio/* 但字节是密文照样删（上一条）。
    const data = Buffer.concat([
      Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1'),
      Buffer.from('legacy-cached-mp3-bytes', 'latin1'),
    ])
    const relative = 'ab/cdef0abc.mp3'
    const filePath = path.join(cacheDir, relative)
    await fsp.mkdir(path.dirname(filePath), { recursive: true })
    await fsp.writeFile(filePath, data)
    vi.mocked(prisma.audioCache.findUnique).mockImplementation(async () => ({
      cacheKey: 'kw:legacy1:320k', filePath: relative, size: data.length, contentType: null,
    }) as never)

    const resp = await audioServe.serve({
      cacheKey: 'kw:legacy1:320k',
      upstreamUrlResolver: resolver(),
      rangeHeader: null,
      isHead: false,
    })

    expect(resp.status).toBe(200)
    expect(prisma.audioCache.delete).not.toHaveBeenCalled()
    expect(Buffer.from(await resp.arrayBuffer()).equals(data)).toBe(true)
  })
})

/** 给"命中磁盘缓存"那一组用的响应构造器（与上面几组的同名函数各自独立） */
function payloadResponseStatic(data: Buffer, ct: string): Response {
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: { 'content-type': ct, 'content-length': String(data.length) },
  })
}

// ===========================================================================
// 占位载荷指纹（2026-11-12 生产：某聚合源的上游对每首歌都回同一条 TTS 语音）
// ===========================================================================

describe('AudioServe.serve() 占位载荷指纹与换源', () => {
  // 两份都超过 32KiB 且单块送达，保证首块头部可比
  const PLACEHOLDER = Buffer.concat([Buffer.from('ID3\x03\x00', 'latin1'), Buffer.alloc(40_000, 0x42)])
  const REAL_SONG = Buffer.concat([Buffer.from('ID3\x03\x00', 'latin1'), Buffer.alloc(40_000, 0x77)])

  /** 坏源A 永远回同一份占位字节；好源B 回各自不同的真内容 */
  function wire(args: { badUrl?: string }) {
    const badUrl = args.badUrl ?? 'https://tts.example/p.mp3'
    const fetchUrls: string[] = []
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      fetchUrls.push(url)
      return url === badUrl
        ? payloadResponseStatic(PLACEHOLDER, 'audio/mpeg')
        : payloadResponseStatic(REAL_SONG, 'audio/mpeg')
    }) as unknown as typeof fetch

    const excludeHistory: string[][] = []
    const upstreamUrlResolver: UpstreamUrlResolver = async excludeProviders => {
      excludeHistory.push([...excludeProviders])
      return excludeProviders.has('坏源A')
        ? { url: 'https://good.example/song.mp3', provider: '好源B' }
        : { url: badUrl, provider: '坏源A' }
    }
    return { fetchUrls, excludeHistory, upstreamUrlResolver }
  }

  const serveOne = (upstreamUrlResolver: UpstreamUrlResolver, cacheKey: string) => audioServe.serve({
    cacheKey,
    upstreamUrlResolver,
    rangeHeader: null,
    isHead: false,
    intervalSec: 200,
  })

  it('同一份字节 + 时长对不上：前两首放行，第三首在首块阶段换源且不落库', async () => {
    checkTrialAudioMock.mockResolvedValue({ trial: true, actualSec: 20 })

    // 第 1 首：没有历史，只能放行并登记
    const first = wire({})
    const r1 = await serveOne(first.upstreamUrlResolver, 'tx:p1:flac')
    expect(r1.status).toBe(200)
    expect(first.fetchUrls).toEqual(['https://tts.example/p.mp3'])
    expect(fingerprintStats()).toEqual({ entries: 1, placeholders: 0 })

    // 第 2 首：撞上同一份字节 ⇒ 定性为占位，并给这个源记一条 fake 坏样本
    const second = wire({})
    const r2 = await serveOne(second.upstreamUrlResolver, 'tx:p2:flac')
    expect(r2.status).toBe(200)
    expect(second.fetchUrls).toEqual(['https://tts.example/p.mp3'])
    expect(fingerprintStats()).toEqual({ entries: 1, placeholders: 1 })
    expect(sourceHealth.view('坏源A', 'tx')?.badKinds['byte:fake']).toBe(1)
    // 试听/占位都不写缓存行（占位这条是新加的第一道，先于试听判据命中）
    expect(prisma.audioCache.upsert).not.toHaveBeenCalled()

    // 第 3 首：此时字节尚未交付就被指纹识破 ⇒ 排除坏源A、换好源B，客户端无感知
    const third = wire({})
    const r3 = await serveOne(third.upstreamUrlResolver, 'tx:p3:flac')
    expect(r3.status).toBe(200)
    expect(Buffer.from(await r3.arrayBuffer()).equals(REAL_SONG)).toBe(true)
    expect(third.fetchUrls).toEqual(['https://tts.example/p.mp3', 'https://good.example/song.mp3'])
    expect(third.excludeHistory[1]).toContain('坏源A')
    expect(sourceHealth.view('坏源A', 'tx')?.badKinds['byte:fake']).toBe(2)
  })

  it('只撞内容、时长对得上 ⇒ 合法重复录音：照样交付，不换源也不记坏', async () => {
    checkTrialAudioMock.mockResolvedValue({ trial: false, actualSec: 200 })

    const a = await serveOne(wire({}).upstreamUrlResolver, 'tx:d1:flac')
    expect(a.status).toBe(200)
    const bWire = wire({})
    const b = await serveOne(bWire.upstreamUrlResolver, 'tx:d2:flac')
    expect(b.status).toBe(200)
    expect(Buffer.from(await b.arrayBuffer()).equals(PLACEHOLDER)).toBe(true)
    expect(bWire.fetchUrls).toEqual(['https://tts.example/p.mp3'])
    expect(fingerprintStats()).toEqual({ entries: 1, placeholders: 0 })
    expect(sourceHealth.view('坏源A', 'tx')?.badKinds['byte:fake']).toBeUndefined()
    // 两首都按正常完整载荷进缓存
    expect(prisma.audioCache.upsert).toHaveBeenCalledTimes(2)
  })

  it('同一首歌换音质档拿到同一个文件（源不认档位）⇒ 不算占位', async () => {
    checkTrialAudioMock.mockResolvedValue({ trial: true, actualSec: 20 })

    const w1 = wire({})
    expect((await serveOne(w1.upstreamUrlResolver, 'tx:same:320k')).status).toBe(200)
    const w2 = wire({})
    expect((await serveOne(w2.upstreamUrlResolver, 'tx:same:flac')).status).toBe(200)

    expect(fingerprintStats().placeholders).toBe(0)
    expect(w2.fetchUrls).toEqual(['https://tts.example/p.mp3'])
    expect(sourceHealth.view('坏源A', 'tx')?.badKinds['byte:fake']).toBeUndefined()
  })
})

// ===========================================================================
// 占位载荷 × 真实网络分块（2026-11-20 生产：柳云API 对每首歌回同一条 20s TTS）
//
// 上面那组夹具是"整份 40KB 单块送达"，而真实 HTTPS 首块只有一个 TLS 记录那么大
// （生产容器内实测同一地址三次都是 16147 字节）。首块闸门要求单块 ≥32KiB 才算得出
// 指纹，于是它在生产里恒不生效：4 次占位载荷全部交付到客户端，只在完成阶段阻止落库。
// 这组按真实分块复现，钉住"第三首必须在字节发出前换源"与"死源要能进冷却"。
// ===========================================================================

/** 按固定块大小交付，模拟真实网络分块（默认 16147 = 生产实测首块字节数） */
function payloadResponseChunked(data: Buffer, ct: string, chunkBytes = 16_147): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let off = 0; off < data.length; off += chunkBytes) {
        c.enqueue(new Uint8Array(data.subarray(off, Math.min(off + chunkBytes, data.length))))
      }
      c.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': ct, 'content-length': String(data.length) },
  })
}

describe('AudioServe.serve() 占位载荷 × 真实分块', () => {
  // 118,995 字节 = 生产那 5 份提示音的实际大小（sha256 全等）
  const NOTICE = Buffer.concat([Buffer.from('ID3\x03\x00', 'latin1'), Buffer.alloc(118_990, 0x42)])
  const REAL = Buffer.concat([Buffer.from('ID3\x03\x00', 'latin1'), Buffer.alloc(199_990, 0x77)])

  function wireNet() {
    const badUrl = 'https://tts.example/notice.mp3'
    const fetchUrls: string[] = []
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      fetchUrls.push(url)
      return url === badUrl
        ? payloadResponseChunked(NOTICE, 'audio/mpeg')
        : payloadResponseChunked(REAL, 'audio/mpeg')
    }) as unknown as typeof fetch

    const excludeHistory: string[][] = []
    const upstreamUrlResolver: UpstreamUrlResolver = async excludeProviders => {
      excludeHistory.push([...excludeProviders])
      return excludeProviders.has('坏源A')
        ? { url: 'https://good.example/song.mp3', provider: '好源B' }
        : { url: badUrl, provider: '坏源A' }
    }
    return { fetchUrls, excludeHistory, upstreamUrlResolver }
  }

  const serveNet = (w: ReturnType<typeof wireNet>, cacheKey: string) => audioServe.serve({
    cacheKey,
    upstreamUrlResolver: w.upstreamUrlResolver,
    rangeHeader: null,
    isHead: false,
    intervalSec: 285,
  })

  it('首块只有 16KiB 时，第三首仍须在字节发出前换源（不是发完才判）', async () => {
    checkTrialAudioMock.mockResolvedValue({ trial: true, actualSec: 20 })

    // 第 1 首：无历史，放行并登记（《冬天的故事》那一格）
    const w1 = wireNet()
    const r1 = await serveNet(w1, 'tx:net1:flac')
    expect(Buffer.from(await r1.arrayBuffer()).equals(NOTICE)).toBe(true)
    await vi.waitFor(() => expect(fingerprintStats()).toEqual({ entries: 1, placeholders: 0 }))

    // 第 2 首：完成阶段定性为占位。这一首按设计仍会漏出去（没有历史就无从判定）
    const w2 = wireNet()
    const r2 = await serveNet(w2, 'tx:net2:flac')
    expect(Buffer.from(await r2.arrayBuffer()).equals(NOTICE)).toBe(true)
    await vi.waitFor(() => expect(fingerprintStats()).toEqual({ entries: 1, placeholders: 1 }))

    // 第 3 首：首块阶段就该识破 ⇒ 排除坏源A、换好源B，客户端拿到真字节
    const w3 = wireNet()
    const r3 = await serveNet(w3, 'tx:net3:flac')
    expect(Buffer.from(await r3.arrayBuffer()).equals(REAL)).toBe(true)
    expect(w3.fetchUrls).toEqual(['https://tts.example/notice.mp3', 'https://good.example/song.mp3'])
    expect(w3.excludeHistory[1]).toContain('坏源A')
  })

  it('占位载荷不许先领一次"字节成功"：连续两首之后该源进冷却', async () => {
    checkTrialAudioMock.mockResolvedValue({ trial: true, actualSec: 20 })

    for (const key of ['tx:cool1:flac', 'tx:cool2:flac', 'tx:cool3:flac']) {
      const w = wireNet()
      const r = await serveNet(w, key)
      await r.arrayBuffer()
    }

    // 第 1 首是试听（好样本），第 2、3 首各一条 fake ⇒ 连续坏达到 2 ⇒ 冷却
    await vi.waitFor(() => {
      expect(sourceHealth.view('坏源A', 'tx')?.badKinds['byte:fake']).toBe(2)
    })
    expect(sourceHealth.coolStatus('坏源A', 'tx').cooling).toBe(true)
  })
})

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

const { audioServe, _resetAudioServeConfigForTest } = await import('@/lib/audio-serve')
const { prisma } = await import('@/lib/db')
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

  it('unverified 载荷（声称 audio 但字节是未知容器）→ 正常交付 + 进缓存，但不触发入库', async () => {
    // 实测坏文件的首块特征：高熵、无控制字符外特征、非文本开头 → unverified
    const body = Buffer.concat([
      Buffer.from('\x15W\n"N76ZqTHbxw\x9c\xd9\xdc', 'latin1'),
      Buffer.alloc(4096, 0x07),
    ])
    globalThis.fetch = vi.fn(async () =>
      payloadResponse(body, 'audio/mpeg')
    ) as unknown as typeof fetch

    const onCached = vi.fn(async () => {})
    const resp = await audioServe.serve({
      cacheKey: 'kw:suspect1:320k',
      upstreamUrlResolver: async () => ({ url: 'https://weird.example/e.mp3', provider: '怪源' }),
      rangeHeader: null,
      isHead: false,
      intervalSec: 0,
      onCached,
    })

    expect(resp.status).toBe(200)
    expect(Buffer.from(await resp.arrayBuffer()).equals(body)).toBe(true)
    expect(prisma.audioCache.upsert).toHaveBeenCalledTimes(1) // 仍进缓存
    expect(onCached).not.toHaveBeenCalled() // 但不入永久库
  })
})

// ===========================================================================
// 命中磁盘缓存（现状回归）
// ===========================================================================

describe('AudioServe.serve() 命中磁盘缓存（回归保护）', () => {
  it('无 Range → 200 完整文件', async () => {
    const data = Buffer.from('cached-audio-bytes-0123456789')
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
    const data = Buffer.from('cached-audio-bytes-0123456789')
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
})

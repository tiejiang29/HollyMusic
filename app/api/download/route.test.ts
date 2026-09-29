/**
 * app/api/download/route.ts 集成测试
 *
 * 两种模式：
 * - uid 模式（推荐）：复用 audioServe 磁盘缓存，mock audioServe.serve 返回
 * - url 模式（兼容）：直接代理上游，mock global fetch
 *
 * 通过 vi.mock 隔离 requireUser / resolveMusicInfoById / audioServe，不触达真实 DB/网络/缓存。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseBuffer } from 'music-metadata'
import { NextRequest } from 'next/server'

// --- mock requireUser / AuthError -----------------------------------------

type AuthMode = 'ok' | 'unauth'

let authMode: AuthMode = 'ok'

class MockAuthError extends Error {
  statusCode = 401
  constructor(message = '未登录') {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/services/user-context', () => ({
  requireUser: vi.fn(async () => {
    if (authMode === 'unauth') throw new MockAuthError('未登录')
    return { username: 'tester' }
  }),
  AuthError: MockAuthError,
}))

// --- mock resolveMusicInfoById --------------------------------------------

let resolveResult: { songmid: string; source: 'kw'; name: string; singer: string } | null = {
  songmid: '196030664',
  source: 'kw',
  name: '杀死那个石家庄人',
  singer: '万能青年旅店',
}

vi.mock('@/lib/db', () => ({
  resolveMusicInfoById: vi.fn(async (uid: string) => {
    if (uid === 'not-found') return null
    return resolveResult
  }),
}))

// --- mock audioServe -------------------------------------------------------

let audioServeResponse: Response
/** 设了就代表"这次是本地整文件交付"，路由据此才会尝试打标签 */
let servedFromDiskInfo: { filePath: string; size: number; contentType: string } | null = null
let coverBytes: { mime: string; data: Buffer } | null = null

vi.mock('@/lib/audio-serve', () => ({
  audioServe: {
    ensureInitialized: vi.fn(async () => {}),
    serve: vi.fn(async (opts: { onServedFromDisk?: (i: typeof servedFromDiskInfo) => void }) => {
      if (servedFromDiskInfo) opts.onServedFromDisk?.(servedFromDiskInfo)
      return audioServeResponse
    }),
  },
}))

// 封面走内部函数（不是自环 HTTP），测试里给固定字节
vi.mock('@/lib/services/cover', () => ({
  getCoverBytesById: vi.fn(async () => coverBytes),
}))

// --- 辅助 ------------------------------------------------------------------

function makeGetRequest(url: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'), { headers })
}

// --- mock music-library（本地优先播放：默认未命中，走 audioServe 路径） -----

vi.mock('@/lib/services/music-library', () => ({
  findLibrarySong: vi.fn(async () => null),
}))

// 延迟导入，确保 vi.mock 先生效
const { GET } = await import('./route')
const { audioServe } = await import('@/lib/audio-serve')

// ===========================================================================
// uid 模式
// ===========================================================================

describe('GET /api/download (uid 模式)', () => {
  beforeEach(() => {
    authMode = 'ok'
    resolveResult = {
      songmid: '196030664',
      source: 'kw',
      name: '杀死那个石家庄人',
      singer: '万能青年旅店',
    }
    audioServeResponse = new Response('audio-bytes', {
      status: 200,
      headers: { 'content-type': 'audio/mpeg', 'content-length': '11' },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('未登录 → 401', async () => {
    authMode = 'unauth'
    const req = makeGetRequest('/api/download?uid=kw-123&quality=320k')
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('缺少 uid 和 url → 400', async () => {
    const req = makeGetRequest('/api/download?filename=x.mp3')
    const res = await GET(req)
    expect(res.status).toBe(400)
  })

  it('不支持的音质 → 400', async () => {
    const req = makeGetRequest('/api/download?uid=kw-123&quality=lossless')
    const res = await GET(req)
    expect(res.status).toBe(400)
  })

  it('uid 未找到 → 404', async () => {
    const req = makeGetRequest('/api/download?uid=not-found&quality=320k')
    const res = await GET(req)
    expect(res.status).toBe(404)
  })

  it('缓存命中 → 200 + Content-Disposition: attachment（文件名后端组装）', async () => {
    // uid 模式不传 filename，后端用 resolveMusicInfoById 的 MusicInfo 组装
    // resolveResult: singer=万能青年旅店, name=杀死那个石家庄人
    const req = makeGetRequest('/api/download?uid=kw-196030664&quality=320k')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const cd = res.headers.get('content-disposition') ?? ''
    expect(cd).toContain('attachment')
    // 后端组装的文件名经 RFC 5987 编码（中文）
    expect(cd).toContain("filename*=UTF-8''")
    // 解码后应含歌名
    expect(decodeURIComponent(cd.split("filename*=UTF-8''")[1])).toBe('万能青年旅店 - 杀死那个石家庄人.mp3')
    // audioServe 的 Content-Type 被透传
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
  })

  it('前端传 filename 参数会被忽略（安全：uid 模式文件名完全后端控制）', async () => {
    // 即使前端传 filename，uid 模式也不读取，后端组装
    const req = makeGetRequest('/api/download?uid=kw-196030664&quality=320k&filename=evil.exe')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const cd = res.headers.get('content-disposition') ?? ''
    // 文件名是后端组装的 .mp3，不是前端传的 evil.exe
    expect(cd).not.toContain('evil')
    expect(cd).toContain('.mp3')
  })

  it('audioServe 返回 502 → 透传 502', async () => {
    audioServeResponse = new Response(JSON.stringify({ error: '上游错误' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
    const req = makeGetRequest('/api/download?uid=kw-123&quality=320k')
    const res = await GET(req)
    expect(res.status).toBe(502)
  })

  it('cacheKey 与 /api/audio 一致（复用缓存的关键）', async () => {
    const serveSpy = vi.mocked(audioServe.serve)
    const req = makeGetRequest('/api/download?uid=kw-196030664&quality=320k')
    await GET(req)
    expect(serveSpy).toHaveBeenCalledTimes(1)
    const arg = serveSpy.mock.calls[0][0]
    expect(arg.cacheKey).toBe('kw:196030664:320k')
  })

  it('无 Range 请求 → serve 收到 rangeHeader=null（普通下载，交付完整 200）', async () => {
    const serveSpy = vi.mocked(audioServe.serve)
    const req = makeGetRequest('/api/download?uid=kw-196030664&quality=320k')
    await GET(req)
    const arg = serveSpy.mock.calls[0][0]
    expect(arg.rangeHeader).toBeNull()
  })

  it('请求带 Range → 透传给 audioServe（浏览器断点续传）', async () => {
    const serveSpy = vi.mocked(audioServe.serve)
    const req = makeGetRequest('/api/download?uid=kw-196030664&quality=320k', {
      range: 'bytes=100-',
    })
    await GET(req)
    const arg = serveSpy.mock.calls[0][0]
    expect(arg.rangeHeader).toBe('bytes=100-')
  })
})

// ===========================================================================
// url 模式（兼容直链）
// ===========================================================================

describe('GET /api/download (url 模式)', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    authMode = 'ok'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('url 编码无效 → 400', async () => {
    const req = makeGetRequest('/api/download?url=%E0%A4%A&filename=song.mp3')
    const res = await GET(req)
    expect(res.status).toBe(400)
  })

  it('远端 403 → 透传 403', async () => {
    globalThis.fetch = vi.fn(async () => new Response('forbidden', { status: 403 })) as typeof fetch
    const req = makeGetRequest(
      '/api/download?url=' + encodeURIComponent('https://x.com/song.mp3') + '&filename=song.mp3'
    )
    const res = await GET(req)
    expect(res.status).toBe(403)
  })

  it('fetch 网络错误 → 502', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed: ENOTFOUND')
    }) as typeof fetch
    const req = makeGetRequest(
      '/api/download?url=' + encodeURIComponent('https://x.com/song.mp3') + '&filename=song.mp3'
    )
    const res = await GET(req)
    expect(res.status).toBe(502)
  })

  it('Content-Length 超过 500MB → 413', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('big', {
        status: 200,
        headers: {
          'content-type': 'audio/mpeg',
          'content-length': String(501 * 1024 * 1024),
        },
      })
    ) as typeof fetch
    const req = makeGetRequest(
      '/api/download?url=' + encodeURIComponent('https://x.com/song.mp3') + '&filename=song.mp3'
    )
    const res = await GET(req)
    expect(res.status).toBe(413)
  })

  it('成功 → 200 + attachment + 携带 Referer', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response('audio', { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    ) as typeof fetch
    globalThis.fetch = fetchSpy
    const req = makeGetRequest(
      '/api/download?url=' + encodeURIComponent('https://musicapi.haitangw.net/kw.php?id=1') +
        '&filename=song.mp3'
    )
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('attachment')
    const [, init] = fetchSpy.mock.calls[0]
    const headers = init?.headers as Record<string, string>
    expect(headers['Referer']).toBe('https://haitangw.net')
  })
})

// ===========================================================================
// 元数据打标交付
// 断言只看可观察面：响应头是否自洽（长度必须等于实际字节数）、第三方解析器读不读得到、
// 磁盘原件是否被碰过。内部函数调没调不算证据。
// ===========================================================================

const blkOf = (type: number, len: number, last = false) => {
  const h = Buffer.alloc(4)
  h[0] = (last ? 0x80 : 0) | type
  h[1] = (len >> 16) & 0xff; h[2] = (len >> 8) & 0xff; h[3] = len & 0xff
  return Buffer.concat([h, Buffer.alloc(len, 0x30 + type)])
}
/** 写一个临时 FLAC（链头 + 音频字节），返回路径与原始字节 */
function writeTempFlac(audio = 4096) {
  const chain = Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    blkOf(0, 34), blkOf(1, 120), blkOf(3, 64), blkOf(4, 100, true),
  ])
  const file = Buffer.concat([chain, Buffer.alloc(audio, 0xcd)])
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-tag-')), 'song.flac')
  fs.writeFileSync(p, file)
  return { p, file, chainLen: chain.length }
}

describe('GET /api/download 元数据打标', () => {
  beforeEach(() => {
    authMode = 'ok'
    resolveResult = {
      songmid: '196030664', source: 'kw',
      name: '杀死那个石家庄人', singer: '万能青年旅店',
    }
    servedFromDiskInfo = null
    coverBytes = null
    audioServeResponse = new Response('audio-bytes', {
      status: 200,
      headers: { 'content-type': 'audio/flac', 'content-length': '11', 'accept-ranges': 'bytes' },
    })
  })
  afterEach(() => { servedFromDiskInfo = null; coverBytes = null })

  it('FLAC + 本地整文件交付 → 打出标签，长度自洽，并去掉 Accept-Ranges', async () => {
    const { p, file } = writeTempFlac()
    servedFromDiskInfo = { filePath: p, size: file.length, contentType: 'audio/flac' }
    coverBytes = { mime: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0x00, 0xff, 0xd9]) }

    const res = await GET(makeGetRequest('/api/download?uid=kw-196030664&quality=flac'))
    expect(res.status).toBe(200)
    const declared = Number(res.headers.get('content-length'))
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.length, 'Content-Length 必须等于实际字节数').toBe(declared)
    expect(declared).not.toBe(file.length)            // 链头被换过，长度必然不同（可大可小）
    expect(res.headers.get('accept-ranges'), '交付长度与原件不同，不能再声明可分段').toBeNull()
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-disposition')).toContain('attachment')

    // 第三方解析器读得到（不是自证）
    const md = await parseBuffer(body, { duration: false, skipCovers: false })
    expect(md.common.title).toBe('杀死那个石家庄人')
    expect(md.common.artist).toBe('万能青年旅店')
    expect((md.common.picture || []).length).toBe(1)
    /** 磁盘原件一字节都不能变：音频缓存的长度取自 DB 且从不重新 stat() */
    expect(fs.readFileSync(p)).toEqual(file)
  })

  it('带 Range → 原样透传，绝不改写（206 分片前插标签会让所有偏移错位）', async () => {
    const { p, file } = writeTempFlac()
    servedFromDiskInfo = { filePath: p, size: file.length, contentType: 'audio/flac' }
    const res = await GET(makeGetRequest('/api/download?uid=kw-196030664&quality=flac', { Range: 'bytes=0-1023' }))
    expect(res.headers.get('content-length')).toBe('11')       // 还是 audioServe 给的那套头
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.length).toBe(11)
    expect(fs.readFileSync(p)).toEqual(file)
  })

  it('本轮不碰 MP3：容器不是 flac 时响应与今天完全一致', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-tag-'))
    const p = path.join(dir, 'song.mp3')
    const raw = Buffer.alloc(512, 0xff)
    fs.writeFileSync(p, raw)
    servedFromDiskInfo = { filePath: p, size: raw.length, contentType: 'audio/mpeg' }
    const res = await GET(makeGetRequest('/api/download?uid=kw-196030664&quality=320k'))
    expect(res.headers.get('content-length')).toBe('11')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    await res.arrayBuffer()
  })

  it('没走本地整文件（缓存 miss 跟随回源）→ 不改写，也不报错', async () => {
    servedFromDiskInfo = null
    const res = await GET(makeGetRequest('/api/download?uid=kw-196030664&quality=flac'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('11')
    await res.arrayBuffer()
  })

  it('链头坏掉（文件被截断）→ 退回原样交付，下载不失败', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-tag-'))
    const p = path.join(dir, 'broken.flac')
    const raw = Buffer.concat([Buffer.from('fLaC', 'latin1'), Buffer.alloc(8, 0x22)])
    fs.writeFileSync(p, raw)
    servedFromDiskInfo = { filePath: p, size: raw.length, contentType: 'audio/flac' }
    const res = await GET(makeGetRequest('/api/download?uid=kw-196030664&quality=flac'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('11')
    await res.arrayBuffer()
  })
})

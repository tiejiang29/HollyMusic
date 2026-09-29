/**
 * app/api/audio/route.ts 集成测试
 *
 * 鉴权矩阵（2026-09 新增）：登录会话 / 分享 st token 旁路 / 匿名 401。
 * 通过 vi.mock 隔离鉴权、DB、audioServe、音乐库，不触达真实磁盘与上游；
 * share token 签发走真实的 lib/services/auth（HMAC），与路由侧共用同一模块实例。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// --- mock 鉴权（getAuthState） ----------------------------------------------

type AuthMode = 'ok' | 'unauth'
let authMode: AuthMode = 'unauth'

vi.mock('@/lib/services/user-context', () => ({
  getAuthState: vi.fn(async () =>
    authMode === 'ok'
      ? { authenticated: true, user: { id: 1, username: 'tester' }, mustChangePassword: false }
      : { authenticated: false, user: null, mustChangePassword: false },
  ),
}))

// --- mock db ------------------------------------------------------------------

vi.mock('@/lib/db', () => ({
  resolveMusicInfoById: vi.fn(async (uid: string) => {
    if (uid === 'not-found') return null
    return {
      songmid: uid.split('-').slice(1).join('-'),
      source: 'kw',
      name: '测试歌曲',
      singer: '测试歌手',
      interval: '03:00',
      types: [{ type: '320k' }],
    }
  }),
}))

// --- mock audioServe / 音乐库 / 歌词 / 音源管理器 -------------------------------

vi.mock('@/lib/audio-serve', () => ({
  audioServe: {
    ensureInitialized: vi.fn(async () => {}),
    serve: vi.fn(async () => new Response(null, { status: 200 })),
  },
}))

vi.mock('@/lib/services/music-library', () => ({
  serveFromLibrary: vi.fn(async () => null),
  ingestFromCache: vi.fn(async () => {}),
}))

vi.mock('@/lib/services/lyrics', () => ({
  cacheNativeLyricForMusic: vi.fn(async () => {}),
}))

vi.mock('@/lib/music-source-manager', () => ({
  musicSourceManager: {
    isInitialized: vi.fn(() => true),
    initialize: vi.fn(async () => {}),
    getMusicUrl: vi.fn(async () => 'https://example.com/a.mp3'),
  },
}))

// --- 延迟导入：真实 share token 签发 + 路由（确保 vi.mock 先生效） --------------

const { createShareAudioToken } = await import('@/lib/services/auth')
const { GET, HEAD } = await import('./route')

// --- 辅助 ----------------------------------------------------------------------

function makeRequest(params: Record<string, string>, headers?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/audio')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url, { headers })
}

const UID = 'kw-196030664'

describe('GET /api/audio 鉴权矩阵', () => {
  beforeEach(() => {
    authMode = 'unauth'
  })

  it('匿名且无 st → 401', async () => {
    const res = await GET(makeRequest({ uid: UID, quality: '320k' }))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error.code).toBe('UNAUTHORIZED')
  })

  it('匿名且伪造 st → 401', async () => {
    const res = await GET(makeRequest({ uid: UID, quality: '320k', st: 'forged.deadbeef' }))
    expect(res.status).toBe(401)
  })

  it('匿名 + 有效 st → 放行（命中 audioServe.serve）', async () => {
    const st = createShareAudioToken(UID, '320k')
    const res = await GET(makeRequest({ uid: UID, quality: '320k', st }))
    expect(res.status).toBe(200)
    const { audioServe } = await import('@/lib/audio-serve')
    expect(audioServe.serve).toHaveBeenCalled()
  })

  it('匿名 + 有效 st 但篡改 quality → 401（token 绑定音质，借 token 拉无损被拒）', async () => {
    const st = createShareAudioToken(UID, '320k')
    const res = await GET(makeRequest({ uid: UID, quality: 'flac', st }))
    expect(res.status).toBe(401)
  })

  it('匿名 + 有效 st 但 uid 不符 → 401（token 不能挪用到其它歌曲）', async () => {
    const st = createShareAudioToken(UID, '320k')
    const res = await GET(makeRequest({ uid: 'tx-999999', quality: '320k', st }))
    expect(res.status).toBe(401)
  })

  it('已登录无 st → 放行', async () => {
    authMode = 'ok'
    const res = await GET(makeRequest({ uid: UID, quality: '320k' }))
    expect(res.status).toBe(200)
  })

  it('缺 uid → 400（先于鉴权）', async () => {
    const res = await GET(makeRequest({ quality: '320k' }))
    expect(res.status).toBe(400)
  })

  it('非法 quality → 400', async () => {
    authMode = 'ok'
    const res = await GET(makeRequest({ uid: UID, quality: '999k' }))
    expect(res.status).toBe(400)
  })

  it('HEAD 匿名 → 401（<audio> 探测同样受保护）', async () => {
    const res = await HEAD(makeRequest({ uid: UID, quality: '320k' }))
    expect(res.status).toBe(401)
  })

  it('已登录但歌曲不存在 → 404（鉴权已通过）', async () => {
    authMode = 'ok'
    const res = await GET(makeRequest({ uid: 'not-found', quality: '320k' }))
    expect(res.status).toBe(404)
  })
})

/**
 * 车机封面改道。判据来自 2026-09-29 车机实测（同一次播放里两个客户端的形状对比）：
 * CarWith 的 Glide = 未认证 + 无 cookie + 无 Range + **不发 Accept** + UA=Dalvik/2.1.0(…)，
 * 一首歌重试 22 次；我们自己的 App（okhttp）首个请求**同样不带 Range**，只靠 cookie 保住。
 * 所以"无 Range"不能单独当判据，必须叠正向特征，且鉴权条件必须在最前面。
 */
const CAR_HEADERS = { 'user-agent': 'Dalvik/2.1.0 (Linux; U; Android 16; 25019PNF3C Build/BP2A.250605.031.A3)' }

describe('未认证的取图式请求改道到公开封面', () => {
  beforeEach(() => {
    authMode = 'unauth'
  })

  it('车机实测形状 → 302 到 /api/cover/<uid>，并 no-store', async () => {
    const res = await GET(makeRequest({ uid: UID, quality: 'flac' }, CAR_HEADERS))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/api/cover/${UID}`)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('Accept 声明 image 也算取图（第二个正向信号：万一小米把取图器换成 OkHttp）', async () => {
    const res = await GET(makeRequest({ uid: UID, quality: '320k' }, { accept: 'image/webp,*/*' }))
    expect(res.status).toBe(302)
  })

  it('带 Range 就不改道：那是来取音频的，仍然 401', async () => {
    const res = await GET(makeRequest({ uid: UID, quality: '320k' }, { ...CAR_HEADERS, range: 'bytes=0-1023' }))
    expect(res.status).toBe(401)
  })

  it('HEAD 永不改道（探测/预取不该被引到图片上）', async () => {
    const res = await HEAD(makeRequest({ uid: UID, quality: '320k' }, CAR_HEADERS))
    expect(res.status).toBe(401)
  })

  it('curl 与 okhttp 形状不改道：401 仍然是可信的鉴权断言，运维探针不破', async () => {
    const curl = await GET(makeRequest({ uid: UID, quality: '320k' }, { 'user-agent': 'curl/8.12.1', accept: '*/*' }))
    const ourApp = await GET(makeRequest({ uid: UID, quality: 'flac' }, { 'user-agent': 'okhttp/4.12.0' }))
    expect(curl.status).toBe(401)
    expect(ourApp.status).toBe(401)
  })

  it('有效 st + 车机 UA → 出音频不改道（借分享链接听歌的人不该拿到一张图）', async () => {
    const st = createShareAudioToken(UID, '320k')
    const res = await GET(makeRequest({ uid: UID, quality: '320k', st }, CAR_HEADERS))
    expect(res.status).toBe(200)
  })

  it('已登录 + 车机 UA + 无 Range → 出音频（鉴权在最前面，判据碰不到合法客户端）', async () => {
    authMode = 'ok'
    const res = await GET(makeRequest({ uid: UID, quality: 'flac' }, CAR_HEADERS))
    expect(res.status).toBe(200)
  })

  it('uid 进 Location 前被编码，路径穿越出不了 /api/cover/', async () => {
    const res = await GET(makeRequest({ uid: '../admin', quality: '320k' }, CAR_HEADERS))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/api/cover/..%2Fadmin')
  })
})

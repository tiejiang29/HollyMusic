/**
 * 投歌接口（G1，`/api/speaker`）测试。
 *
 * 三条要紧的：
 * 1. **未登录 401**（这是能指挥别人家音箱的口子）；
 * 2. **就绪判据在前端可见**：没配局域网地址 / 没在线纳管音箱时 `ready=false`，
 *    这样播放页不会摆一个点了只会报错的按钮；
 * 3. **小米侧的 401 不许发成本站 401**（否则会话被作废，用户会被踢下线）—— 与 `/api/admin/speaker` 同一口径。
 * 另钉一条：推歌"受理但没在放"要回 200 且带 reason，不能报成功。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

let authMode: 'user' | 'anonymous' = 'user'

class MockAuthError extends Error {
  constructor(message = '未登录') { super(message); this.name = 'AuthError' }
}

vi.mock('@/lib/services/user-context', () => ({
  requireUser: vi.fn(async () => {
    if (authMode === 'anonymous') throw new MockAuthError('未登录')
    return { username: 'tiejiang' }
  }),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const h = vi.hoisted(() => ({
  readSpeakerConfig: vi.fn(),
  playOnSpeaker: vi.fn(),
  controlSpeaker: vi.fn(),
  setSpeakerVolume: vi.fn(),
  readSpeakerStatus: vi.fn(),
}))
vi.mock('@/lib/services/xiaomi/token-store', () => ({ readSpeakerConfig: h.readSpeakerConfig }))
vi.mock('@/lib/services/xiaomi/speaker-play', () => ({
  SpeakerError: class SpeakerError extends Error {
    status: number
    constructor(m: string, s = 409) { super(m); this.name = 'SpeakerError'; this.status = s }
  },
  playOnSpeaker: h.playOnSpeaker,
  controlSpeaker: h.controlSpeaker,
  setSpeakerVolume: h.setSpeakerVolume,
  readSpeakerStatus: h.readSpeakerStatus,
}))

const { GET, POST } = await import('@/app/api/speaker/route')
const { XiaomiAuthError } = await import('@/lib/services/xiaomi/mina-client')

const device = {
  deviceID: '1', name: '小爱音箱Play', hardware: 'L05B', model: 'L05B',
  miotDID: '867224854', presence: 'online', managed: true,
}
const configOf = (over = {}) => ({
  enabled: true, credentials: {}, devices: [device], lastSyncAt: null, lastError: null,
  serverHost: '172.16.1.20:3000', playQuality: '320k', musicApiDisabledModels: [], ...over,
})

const post = (body: unknown) => new NextRequest('http://localhost/api/speaker', {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
})

beforeEach(() => {
  authMode = 'user'
  for (const f of Object.values(h)) f.mockReset()
  h.readSpeakerConfig.mockResolvedValue(configOf())
})

describe('闸门与就绪', () => {
  it('未登录：GET/POST 都 401，一次业务都不碰', async () => {
    authMode = 'anonymous'
    expect((await GET(new NextRequest('http://localhost/api/speaker'))).status).toBe(401)
    expect((await POST(post({ action: 'play', uid: 'tx-1' }))).status).toBe(401)
    expect(h.playOnSpeaker).not.toHaveBeenCalled()
  })

  it('就绪 = 开关开 + 有在线纳管音箱 + 配了地址，三件缺一个就 ready=false', async () => {
    const body = await (await GET(new NextRequest('http://localhost/api/speaker'))).json()
    expect(body.data.ready).toBe(true)

    h.readSpeakerConfig.mockResolvedValue(configOf({ serverHost: '' }))
    const noHost = await (await GET(new NextRequest('http://localhost/api/speaker'))).json()
    expect(noHost.data.ready).toBe(false)
    expect(noHost.data.serverHostReady).toBe(false)

    h.readSpeakerConfig.mockResolvedValue(configOf({ devices: [{ ...device, presence: 'offline' }] }))
    expect((await (await GET(new NextRequest('http://localhost/api/speaker'))).json()).data.ready).toBe(false)
  })

  it('只回公开字段：设备名/型号/在线，没有任何凭据字段', async () => {
    const text = await (await GET(new NextRequest('http://localhost/api/speaker'))).text()
    expect(text).not.toContain('serviceToken')
    expect(text).not.toContain('passToken')
    expect(JSON.parse(text).data.devices).toEqual([
      { deviceID: '1', name: '小爱音箱Play', hardware: 'L05B', online: true, managed: true },
    ])
  })

  it('没纳管的设备不出现在列表里', async () => {
    h.readSpeakerConfig.mockResolvedValue(configOf({ devices: [{ ...device, managed: false }] }))
    const body = await (await GET(new NextRequest('http://localhost/api/speaker'))).json()
    expect(body.data.devices).toEqual([])
  })
})

describe('动作', () => {
  it('play 要带 uid；投出去后把"在不在放"原样带回', async () => {
    expect((await POST(post({ action: 'play' }))).status).toBe(400)
    h.playOnSpeaker.mockResolvedValue({ playing: true, pushed: true, deviceName: '小爱音箱Play', hardware: 'L05B', status: null, reason: null })
    const body = await (await POST(post({ action: 'play', uid: 'tx-1' }))).json()
    expect(body.data.playing).toBe(true)
    expect(h.playOnSpeaker).toHaveBeenCalledWith({ uid: 'tx-1', deviceID: undefined })
  })

  it('受理了但没在放：仍是 200，但 playing=false 且 reason 说清', async () => {
    h.playOnSpeaker.mockResolvedValue({ playing: false, pushed: true, deviceName: 'A', hardware: 'L05B', status: { status: 0 }, reason: '状态码 0' })
    const res = await POST(post({ action: 'play', uid: 'tx-1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.playing).toBe(false)
    expect(body.data.reason).toContain('状态码 0')
  })

  it('resume 翻译成小米的 play，pause/stop 原样下去', async () => {
    h.controlSpeaker.mockResolvedValue(device)
    await POST(post({ action: 'resume', deviceID: '1' }))
    expect(h.controlSpeaker).toHaveBeenCalledWith('play', '1')
    await POST(post({ action: 'pause' }))
    expect(h.controlSpeaker).toHaveBeenLastCalledWith('pause', undefined)
    await POST(post({ action: 'stop' }))
    expect(h.controlSpeaker).toHaveBeenLastCalledWith('stop', undefined)
  })

  it('音量原样传下去，未知 action 400', async () => {
    h.setSpeakerVolume.mockResolvedValue(device)
    await POST(post({ action: 'volume', volume: 42 }))
    expect(h.setSpeakerVolume).toHaveBeenCalledWith(42, undefined)
    expect((await POST(post({ action: 'reboot' }))).status).toBe(400)
  })
})

describe('错误身份', () => {
  it('地址没配 / 都离线这类"要去面板上做点什么"的错 ⇒ SPEAKER_NOT_READY + 原状态码', async () => {
    const { SpeakerError } = await import('@/lib/services/xiaomi/speaker-play')
    h.playOnSpeaker.mockRejectedValue(new SpeakerError('先在面板上填「音箱可达的服务地址」', 409))
    const res = await POST(post({ action: 'play', uid: 'tx-1' }))
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('SPEAKER_NOT_READY')
  })

  it('小米侧 401 ⇒ 本站 502（发 401 会把用户从前端踢下线）', async () => {
    h.playOnSpeaker.mockRejectedValue(new XiaomiAuthError('小爱的票已失效，需要重新登录', 401))
    const res = await POST(post({ action: 'play', uid: 'tx-1' }))
    expect(res.status).toBe(502)
    expect((await res.json()).error.code).toBe('XIAOMI_UNAUTHORIZED')
  })

  it('上游 5xx ⇒ XIAOMI_UPSTREAM_ERROR，不冒充"要重新扫码"', async () => {
    h.playOnSpeaker.mockRejectedValue(new XiaomiAuthError('播控被云端拒绝（player_play_url，HTTP 500）', 502))
    const res = await POST(post({ action: 'play', uid: 'tx-1' }))
    expect((await res.json()).error.code).toBe('XIAOMI_UPSTREAM_ERROR')
  })
})

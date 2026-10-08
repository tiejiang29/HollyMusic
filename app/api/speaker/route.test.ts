/**
 * 投歌接口（G1，`/api/speaker`）测试。
 *
 * 三条要紧的：
 * 1. **未登录 401**（这是能指挥别人家音箱的口子）；
 * 2. **就绪判据在前端可见**：没配局域网地址 / 没在线纳管音箱时 `ready=false`，
 *    这样播放页不会摆一个点了只会报错的按钮；
 * 3. **小米侧的 401 不许发成本站 401**（否则会话被作废，用户会被踢下线）—— 与 `/api/admin/speaker` 同一口径。
 * 另钉一条：推歌"受理但没在放"要回 200 且带 reason，不能报成功。
 *
 * G2 投放态再加三条要紧的：`castStatus` **只读服务端会话、一次小米都不打**（客户端每几秒问一次，
 * 照着打到小米就是限流）；`cast` 收的是**播放顺序**（当前曲 + rest），顺序错了播的就不是他要的歌；
 * 以及 `stop` 必须连会话一起清 —— 留着看门狗只会让进度条在设备已经安静之后继续假装走。
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
const c = vi.hoisted(() => ({
  startCast: vi.fn(),
  updateCastRest: vi.fn(),
  skipCast: vi.fn(),
  seekCast: vi.fn(),
  stopCast: vi.fn(async () => undefined),
  castView: vi.fn(async () => null),
  refreshCast: vi.fn(),
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

vi.mock('@/lib/services/xiaomi/cast-session', () => c)

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

const view = {
  deviceID: '1', deviceName: '小爱音箱Play', hardware: 'L05B', uid: 'tx-S1',
  posSec: 12, durSec: 220, playing: true, status: 1, volume: 40,
  windowSize: 10, pendingTracks: 25, lastError: null,
}

beforeEach(() => {
  authMode = 'user'
  for (const f of [...Object.values(h), ...Object.values(c)]) f.mockReset()
  h.readSpeakerConfig.mockResolvedValue(configOf())
  c.castView.mockResolvedValue(null)
  c.stopCast.mockResolvedValue(undefined)
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

describe('投放会话动作（G2）', () => {
  it('cast：把当前曲与之后的顺序整个交给会话', async () => {
    c.startCast.mockResolvedValue(view)
    const res = await POST(post({
      action: 'cast', current: { uid: 'tx-S1', durSec: 220 },
      rest: [{ uid: 'tx-S2', durSec: 180 }, { uid: 'kw-9', durSec: 0 }], deviceID: '1',
    }))
    expect((await res.json()).data.uid).toBe('tx-S1')
    expect(c.startCast).toHaveBeenCalledWith({
      current: { uid: 'tx-S1', durSec: 220 },
      rest: [{ uid: 'tx-S2', durSec: 180 }, { uid: 'kw-9', durSec: 0 }],
      deviceID: '1', seekSec: 0, loopOne: false,
    })
  })

  it('cast 缺 current ⇒ 400，不去猜要投什么', async () => {
    const res = await POST(post({ action: 'cast', rest: [] }))
    expect(res.status).toBe(400)
    expect(c.startCast).not.toHaveBeenCalled()
  })

  it('脏条目丢掉：不是数组的 rest 当空表，uid 为空的条目不进列表', async () => {
    c.updateCastRest.mockReturnValue(view)
    await POST(post({ action: 'castRest', rest: [{ uid: '', durSec: 5 }, { uid: 'tx-S3', durSec: '180' }, null] }))
    expect(c.updateCastRest).toHaveBeenCalledWith([{ uid: 'tx-S3', durSec: 180 }], undefined)
    await POST(post({ action: 'castRest', rest: '不是数组' }))
    expect(c.updateCastRest).toHaveBeenLastCalledWith([], undefined)
  })

  it('下一首/上一首只挪一格（前端传几都只跳一首）', async () => {
    c.skipCast.mockResolvedValue(view)
    await POST(post({ action: 'castSkip', delta: 7 }))
    expect(c.skipCast).toHaveBeenCalledWith(1, undefined)
    await POST(post({ action: 'castSkip', delta: -3 }))
    expect(c.skipCast).toHaveBeenLastCalledWith(-1, undefined)
  })

  it('seek 原样把秒数交给会话（服务端再换算成字节偏移重推）', async () => {
    c.seekCast.mockResolvedValue(view)
    await POST(post({ action: 'seek', sec: 96.5 }))
    expect(c.seekCast).toHaveBeenCalledWith(96.5, undefined)
  })

  it('castStatus 只读会话，一次都不打小米（客户端轮询不能放大成 ubus 洪水）', async () => {
    c.castView.mockResolvedValue(view)
    const res = await POST(post({ action: 'castStatus' }))
    expect((await res.json()).data.casting.posSec).toBe(12)
    expect(h.readSpeakerStatus).not.toHaveBeenCalled()
    expect(h.playOnSpeaker).not.toHaveBeenCalled()
  })

  it('GET 也带会话：刷新页面后认得出"还在投着"', async () => {
    c.castView.mockResolvedValue(view)
    const res = await GET(new NextRequest('http://localhost/api/speaker'))
    expect((await res.json()).data.casting?.uid).toBe('tx-S1')
  })

  it('castStop 清会话并回 casting:null', async () => {
    const res = await POST(post({ action: 'castStop', deviceID: '1' }))
    expect(c.stopCast).toHaveBeenCalledWith('1')
    expect((await res.json()).data.casting).toBeNull()
  })

  it('stop 既停设备也清会话（留着看门狗进度会假装在走）', async () => {
    h.controlSpeaker.mockResolvedValue(device)
    const res = await POST(post({ action: 'stop' }))
    expect(c.stopCast).toHaveBeenCalledTimes(1)
    expect((await res.json()).data.casting).toBeNull()
  })

  it('暂停之后刷一次会话状态，好让进度定住而不是按墙钟跑', async () => {
    h.controlSpeaker.mockResolvedValue(device)
    c.refreshCast.mockResolvedValue(view)
    const res = await POST(post({ action: 'pause' }))
    expect(c.refreshCast).toHaveBeenCalledTimes(1)
    expect((await res.json()).data.casting.uid).toBe('tx-S1')
  })

  it('会话报错（没在投）沿用 SPEAKER_NOT_READY，小米 401 仍降成 502', async () => {
    const { SpeakerError } = await import('@/lib/services/xiaomi/speaker-play')
    c.seekCast.mockRejectedValue(new SpeakerError('现在没有投放会话（先点「投到小爱」）', 409))
    const res = await POST(post({ action: 'seek', sec: 10 }))
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('SPEAKER_NOT_READY')
    c.skipCast.mockRejectedValue(new XiaomiAuthError('小爱的票已失效，需要重新登录', 401))
    const res2 = await POST(post({ action: 'castSkip', delta: 1 }))
    expect(res2.status).toBe(502)
    expect((await res2.json()).error.code).toBe('XIAOMI_UNAUTHORIZED')
  })
})

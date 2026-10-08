/**
 * app/api/admin/speaker/route.ts 测试
 *
 * 两条最要紧的：
 * 1. **非管理员一律 401/403**（这接口能扫码登录到一个能列出全账号设备的入口）；
 * 2. **小米侧的 401 不许原样发成 HTTP 401** —— `lib/api/client` 一见到 401 就作废管理员
 *    在本站的会话（`hooks/useAuth` 注册的处置），那会变成"小爱的票过期 → 把你从后台踢下线"。
 *    所以这里降级成 502 + `XIAOMI_UNAUTHORIZED`，靠 code 区分身份。
 *
 * 另外钉一条隐私的：`qrPoll` 成功那条只回视图，凭据一个字节都不出网。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

let authMode: 'admin' | 'user' | 'anonymous' = 'admin'

class MockAuthError extends Error {
  constructor(message = '未登录') { super(message); this.name = 'AuthError' }
}
class MockForbiddenError extends Error {
  constructor(message = '需要管理员') { super(message); this.name = 'ForbiddenError' }
}

vi.mock('@/lib/services/user-context', () => ({
  requireAdmin: vi.fn(async () => {
    if (authMode === 'anonymous') throw new MockAuthError('未登录')
    if (authMode === 'user') throw new MockForbiddenError('需要管理员权限')
    return { username: 'admin' }
  }),
  AuthError: MockAuthError,
  ForbiddenError: MockForbiddenError,
}))

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

// 错误类型用真的（instanceof 靠它），会出网的函数全隔掉
const h = vi.hoisted(() => ({
  startQrLogin: vi.fn(),
  pollQrLogin: vi.fn(),
  abandonQrLogin: vi.fn(),
  getSpeakerView: vi.fn(),
  saveCredentials: vi.fn(),
  clearSpeakerLogin: vi.fn(),
  syncDevices: vi.fn(),
  setDeviceManaged: vi.fn(),
  setSpeakerEnabled: vi.fn(),
  // 面板项那三组（对话轮询 / 转码 / 接管）：都是写库的，隔掉
  setSpeakerConversation: vi.fn(),
  setSpeakerTranscode: vi.fn(),
  setSpeakerTakeover: vi.fn(),
  readSpeakerConfig: vi.fn(),
  ensureConversationMonitor: vi.fn(),
  getConversationFeed: vi.fn(),
  probeFfmpeg: vi.fn(),
  resetFfmpegProbe: vi.fn(),
  getTakeoverLog: vi.fn(),
  handleAskNow: vi.fn(),
}))

vi.mock('@/lib/services/xiaomi/qr-login', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/services/xiaomi/qr-login')>()
  return { ...real, startQrLogin: h.startQrLogin, pollQrLogin: h.pollQrLogin, abandonQrLogin: h.abandonQrLogin }
})
vi.mock('@/lib/services/xiaomi/token-store', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/services/xiaomi/token-store')>()
  return {
    ...real,
    getSpeakerView: h.getSpeakerView,
    saveCredentials: h.saveCredentials,
    clearSpeakerLogin: h.clearSpeakerLogin,
    syncDevices: h.syncDevices,
    setDeviceManaged: h.setDeviceManaged,
    setSpeakerEnabled: h.setSpeakerEnabled,
    setSpeakerConversation: h.setSpeakerConversation,
    setSpeakerTranscode: h.setSpeakerTranscode,
    setSpeakerTakeover: h.setSpeakerTakeover,
    readSpeakerConfig: h.readSpeakerConfig,
  }
})
vi.mock('@/lib/services/xiaomi/conversation-monitor', () => ({
  ensureConversationMonitor: h.ensureConversationMonitor,
  getConversationFeed: h.getConversationFeed,
}))
vi.mock('@/lib/server/audio-transcode', () => ({
  probeFfmpeg: h.probeFfmpeg, resetFfmpegProbe: h.resetFfmpegProbe,
}))
vi.mock('@/lib/services/xiaomi/voice-takeover', () => ({
  getTakeoverLog: h.getTakeoverLog, handleAskNow: h.handleAskNow,
}))

// 客户端与服务端的 action 名要能对上：两边各改一半时这条会红
const sent = vi.hoisted(() => ({ calls: [] as Array<{ url: string; body: unknown }> }))
vi.mock('@/lib/api/client', () => ({
  apiGet: vi.fn(async (url: string) => { sent.calls.push({ url, body: undefined }); return VIEW }),
  apiPost: vi.fn(async (url: string, body: unknown) => { sent.calls.push({ url, body }); return VIEW }),
}))

const { GET, POST } = await import('@/app/api/admin/speaker/route')
const { XiaomiAuthError } = await import('@/lib/services/xiaomi/mina-client')
const { XiaomiLoginError } = await import('@/lib/services/xiaomi/qr-login')

const VIEW = {
  enabled: true, loggedIn: true, accountTail: '4121', tokenTail: '****9Q==',
  expiresAt: '2026-10-08T07:12:01.000Z', msToExpiry: 3600000, needsRefresh: false,
  devices: [{ deviceID: '705427729', name: '小爱音箱Play', hardware: 'L05B', model: 'L05B', miotDID: '867224854', presence: 'online', managed: true }],
  lastSyncAt: '2026-10-07T07:12:01.000Z', lastError: null,
}

const req = (body: unknown) => new NextRequest('http://localhost/api/admin/speaker', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' },
})
const getReq = () => new NextRequest('http://localhost/api/admin/speaker')

beforeEach(() => {
  authMode = 'admin'
  for (const f of Object.values(h)) f.mockReset()
  h.getSpeakerView.mockResolvedValue(VIEW)
  // 给每个 action 一个"能走通"的默认返回，让对齐那条测试只测 action 名，不去测业务分支
  h.startQrLogin.mockResolvedValue({ sessionId: 's', loginToken: 't', qrPngBase64: 'e', expiresInMs: 300000 })
  h.pollQrLogin.mockResolvedValue({ state: 'waiting' })
  h.syncDevices.mockResolvedValue([])
  for (const f of [h.setSpeakerConversation, h.setSpeakerTranscode, h.setSpeakerTakeover]) f.mockResolvedValue(VIEW)
  h.readSpeakerConfig.mockResolvedValue({ devices: VIEW.devices, ffmpegPath: 'ffmpeg', takeoverEnabled: false })
  h.ensureConversationMonitor.mockResolvedValue({ running: false, pollSec: 2, enabled: false, lastPollAt: null, lastError: null, devices: [] })
  h.getConversationFeed.mockReturnValue({ rows: [], state: { running: false, pollSec: 2, enabled: false, lastPollAt: null, lastError: null, devices: [] } })
  h.probeFfmpeg.mockResolvedValue(null)
  h.getTakeoverLog.mockReturnValue([])
  h.handleAskNow.mockResolvedValue({ at: 1, deviceID: '705427729', deviceName: '小爱音箱Play', query: '甲', answer: '', verdict: 'standby', reason: 'r', acted: '没动', synthetic: true })
  sent.calls = []
})

describe('客户端与服务端的 action 名对齐（改一边忘另一边会红）', () => {
  it('admin-speaker 客户端打出去的每个 action 路由都认', async () => {
    const client = await import('@/lib/api/admin-speaker')
    await client.getSpeaker()
    await client.startSpeakerQr()
    await client.pollSpeakerQr('s', 't')
    await client.refreshSpeakerDevices()
    await client.setSpeakerManaged('705427729', false)
    await client.setSpeakerEnabled(true)
    await client.speakerLogout('s')
    await client.setSpeakerConversation({ enabled: true, pollSec: 2 })
    await client.readConversationFeed()
    await client.setSpeakerTranscode({ enabled: true })
    await client.probeSpeakerFfmpeg()
    await client.setSpeakerTakeover({ enabled: true })
    await client.readTakeoverLog()
    await client.simulateAsk('下一首', '好的')

    expect(sent.calls).toHaveLength(14)
    expect(sent.calls.every(c => c.url === 'admin/speaker')).toBe(true)
    for (const c of sent.calls) {
      if (c.body === undefined) continue
      const res = await POST(req(c.body))
      const body = await res.json()
      expect(body.error?.message ?? '').not.toMatch(/未知操作/)
      expect(res.status).not.toBe(400)
    }
    // action 名逐个字钉住：面板/客户端/路由三处用的是同一套词
    expect(sent.calls.map(c => (c.body as { action?: string })?.action ?? '(GET)'))
      .toEqual([
        '(GET)', 'qrStart', 'qrPoll', 'devices', 'setManaged', 'setEnabled', 'logout',
        'convSet', 'convList', 'tcSet', 'tcProbe', 'askSet', 'askLog', 'askSimulate',
      ])
  })
})

describe('鉴权闸门', () => {
  it('匿名 401、非管理员 403，GET/POST 都一样', async () => {
    for (const mode of ['anonymous', 'user'] as const) {
      authMode = mode
      expect((await GET(getReq())).status).toBe(mode === 'anonymous' ? 401 : 403)
      expect((await POST(req({ action: 'devices' }))).status).toBe(mode === 'anonymous' ? 401 : 403)
    }
    // 闸门在业务之前：一次都不该去碰小米
    expect(h.syncDevices).not.toHaveBeenCalled()
  })
})

describe('GET 状态视图', () => {
  it('只回脱敏视图，凭据不在其中', async () => {
    const res = await GET(getReq())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.tokenTail).toBe('****9Q==')
    expect(body.success).toBe(true)
  })

  it('读库炸了给 500 与可读文案，不白屏', async () => {
    h.getSpeakerView.mockRejectedValue(new Error('db down'))
    const res = await GET(getReq())
    expect(res.status).toBe(500)
    expect((await res.json()).error.message).toContain('读取小爱网关状态失败')
  })
})

describe('POST 分支', () => {
  it('qrStart 原样把二维码与会话口令给前端', async () => {
    const qr = { sessionId: 'a'.repeat(24), loginToken: 'b'.repeat(32), qrPngBase64: 'iVBORw0=', expiresInMs: 300000 }
    h.startQrLogin.mockResolvedValue(qr)
    const body = await (await POST(req({ action: 'qrStart' }))).json()
    expect(body.data).toEqual(qr)
  })

  it('qrPoll 缺 sessionId 或 loginToken：400，不去问平台', async () => {
    const res = await POST(req({ action: 'qrPoll', sessionId: 'x' }))
    expect(res.status).toBe(400)
    expect(h.pollQrLogin).not.toHaveBeenCalled()
  })

  it('qrPoll 等待中：原样回 waiting，不落凭据', async () => {
    h.pollQrLogin.mockResolvedValue({ state: 'waiting' })
    const body = await (await POST(req({ action: 'qrPoll', sessionId: 's', loginToken: 't' }))).json()
    expect(body.data).toEqual({ state: 'waiting' })
    expect(h.saveCredentials).not.toHaveBeenCalled()
  })

  it('qrPoll 成功：先落凭据再回视图，**响应里没有 serviceToken / passToken**', async () => {
    const credentials = {
      serviceToken: 'SECRET_SERVICE_TOKEN', passToken: 'SECRET_PASS_TOKEN', userId: '88234121',
      cUserId: 'CU_9', deviceId: 'D', expiresAt: VIEW.expiresAt, accountTail: '4121',
    }
    h.pollQrLogin.mockResolvedValue({ state: 'signedIn', credentials })
    const res = await POST(req({ action: 'qrPoll', sessionId: 's', loginToken: 't' }))
    const text = await res.text()
    expect(h.saveCredentials).toHaveBeenCalledWith(credentials)
    expect(JSON.parse(text).data.view).toEqual(VIEW)
    expect(text).not.toContain('SECRET_SERVICE_TOKEN')
    expect(text).not.toContain('SECRET_PASS_TOKEN')
  })

  it('devices 回设备表与视图', async () => {
    h.syncDevices.mockResolvedValue(VIEW.devices)
    const body = await (await POST(req({ action: 'devices' }))).json()
    expect(body.data.devices[0].hardware).toBe('L05B')
    expect(body.data.view.loggedIn).toBe(true)
  })

  it('setManaged 要带 deviceID，纳管标记按布尔取', async () => {
    expect((await POST(req({ action: 'setManaged' }))).status).toBe(400)
    await POST(req({ action: 'setManaged', deviceID: '705427729', managed: false }))
    expect(h.setDeviceManaged).toHaveBeenCalledWith('705427729', false)
    // 不给 managed 就是 false（而不是 undefined 把状态搅糊）
    await POST(req({ action: 'setManaged', deviceID: '705427729' }))
    expect(h.setDeviceManaged).toHaveBeenLastCalledWith('705427729', false)
  })

  it('setEnabled 按布尔落库', async () => {
    await POST(req({ action: 'setEnabled', enabled: true }))
    expect(h.setSpeakerEnabled).toHaveBeenCalledWith(true)
    await POST(req({ action: 'setEnabled' }))
    expect(h.setSpeakerEnabled).toHaveBeenLastCalledWith(false)
  })

  it('logout 顺手作废还在等的二维码会话', async () => {
    await POST(req({ action: 'logout', sessionId: 's' }))
    expect(h.abandonQrLogin).toHaveBeenCalledWith('s')
    expect(h.clearSpeakerLogin).toHaveBeenCalled()
  })

  it('未知 action 给 400 并说清是哪个', async () => {
    const res = await POST(req({ action: 'playSong' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain('playSong')
  })

  it('body 不是 JSON：400，不是 500', async () => {
    const res = await POST(req('not json at all'))
    expect(res.status).toBe(400)
  })
})

describe('错误身份（面板要靠这个决定给不给"重新扫码"）', () => {
  it('小米侧 401 ⇒ 本站不发 401（发了会把管理员从后台踢下线），改 502 + XIAOMI_UNAUTHORIZED', async () => {
    h.syncDevices.mockRejectedValue(new XiaomiAuthError('小爱的票已过期且静默续期没成功，请在面板上重新扫码', 401))
    const res = await POST(req({ action: 'devices' }))
    const body = await res.json()
    expect(res.status).toBe(502)
    expect(body.error.code).toBe('XIAOMI_UNAUTHORIZED')
    expect(body.error.message).toContain('重新扫码')
  })

  it('上游 5xx ⇒ XIAOMI_UPSTREAM_ERROR，不冒充"要重新扫码"', async () => {
    h.syncDevices.mockRejectedValue(new XiaomiAuthError('读取设备列表失败（HTTP 500）', 502))
    const res = await POST(req({ action: 'devices' }))
    expect(res.status).toBe(502)
    expect((await res.json()).error.code).toBe('XIAOMI_UPSTREAM_ERROR')
  })

  it('扫码流程自身的错（口令/参数）按 INVALID_PARAMS 走', async () => {
    h.startQrLogin.mockRejectedValue(new XiaomiLoginError('小米没返回轮询地址（lp）', 409))
    const res = await POST(req({ action: 'qrStart' }))
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('INVALID_PARAMS')
  })

  it('没登录时打 devices：明确一句"还没有登录"，不是 500', async () => {
    h.syncDevices.mockRejectedValue(new XiaomiAuthError('还没有登录小爱账号（面板上扫码登录）', 401))
    const res = await POST(req({ action: 'devices' }))
    const body = await res.json()
    expect(res.status).toBe(502)
    expect(body.error.code).toBe('XIAOMI_UNAUTHORIZED')
    expect(body.error.message).toContain('还没有登录')
  })
})

describe('接管那几个 action 的入参门槛', () => {
  it('模拟口令没写"你说" ⇒ 400，不打判据也不动音箱', async () => {
    const res = await POST(req({ action: 'askSimulate', query: '  ' }))
    expect(res.status).toBe(400)
    expect(h.handleAskNow).not.toHaveBeenCalled()
  })

  it('账号下没设备 ⇒ 合成不出来，明确报错而不是拿 undefined 当设备', async () => {
    h.readSpeakerConfig.mockResolvedValue({ devices: [], ffmpegPath: 'ffmpeg', takeoverEnabled: true })
    const res = await POST(req({ action: 'askSimulate', query: '下一首' }))
    expect(res.status).toBe(409)
    expect(h.handleAskNow).not.toHaveBeenCalled()
  })

  it('askSet 把面板那几行文本转成规则再交给服务层（解析坏了就是空表，服务层会回落默认表）', async () => {
    await POST(req({ action: 'askSet', controlRulesText: `pause=暂停
next=下一首` }))
    const arg = h.setSpeakerTakeover.mock.calls[0][0]
    expect(arg.controlRules).toEqual([
      { op: 'pause', words: ['暂停'] },
      { op: 'next', words: ['下一首'] },
    ])
  })
})

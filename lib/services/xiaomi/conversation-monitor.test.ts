/**
 * 对话轮询监视器（G0.5）测试：钉的全是"时序口径"，因为这些错了面板会看着很对。
 *
 * 最值钱的四条：
 * 1. 基线**只能用平台返回的时间戳**用本地时钟推 ⇒ 时钟偏差会静默丢真对话或重放历史；
 * 2. "这次没取到"（抛错）与"确实没有记录"（返回 []）不能混 —— 混了会把基线推歪；
 * 3. 首轮那批要标成历史（面板看得见，但 G3 的接管不许吃）；
 * 4. 平台会往回改时间戳 ⇒ 只按"更大才收"会漏掉刚说的这句，得留一点回退容忍 + 靠去重键防重播。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

class MockAuthError extends Error {
  status: number
  constructor(m: string, s = 401) { super(m); this.name = 'XiaomiAuthError'; this.status = s }
}

const h = vi.hoisted(() => ({
  submitAsk: vi.fn(),
  config: {
    enabled: true, credentials: {}, devices: [] as Array<Record<string, unknown>>,
    lastSyncAt: null, lastError: null, serverHost: '', playQuality: '320k',
    musicApiDisabledModels: [] as string[],
    conversationEnabled: true, conversationPollSec: 2,
    failedAnswerHints: ['没有找到', '没听清'],
    takeoverEnabled: false,
  },
  readSpeakerConfig: vi.fn(),
  ensureFreshCredentials: vi.fn(async () => ({ serviceToken: 'ST', userId: '1', deviceId: 'D' })),
  fetchConversations: vi.fn(),
  clampPollSec: vi.fn((raw: unknown) => {
    const n = Number(raw)
    if (!Number.isFinite(n)) return 2
    return Math.min(30, Math.max(1, Math.round(n)))
  }),
}))

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/services/xiaomi/token-store', () => ({
  readSpeakerConfig: h.readSpeakerConfig,
  ensureFreshCredentials: h.ensureFreshCredentials,
  clampPollSec: h.clampPollSec,
}))
vi.mock('@/lib/services/xiaomi/mina-client', () => ({
  fetchConversations: h.fetchConversations,
  XiaomiAuthError: MockAuthError,
}))
vi.mock('@/lib/services/xiaomi/voice-takeover', () => ({ submitAsk: h.submitAsk }))

const mod = await import('@/lib/services/xiaomi/conversation-monitor')
const { ensureConversationMonitor, getConversationFeed, stopConversationMonitor, looksLikeFailedAnswer, _resetConversationMonitorForTest } = mod

const DEVICE = { deviceID: 'D1', name: '小爱音箱Play', hardware: 'L05B', model: 'L05B', miotDID: 'm', presence: 'online', managed: true }
const rec = (timestampMs: number, query: string, answer = '') => ({ timestampMs, query, answer })

beforeEach(() => {
  vi.useFakeTimers()
  h.config.conversationEnabled = true
  h.config.conversationPollSec = 2
  h.config.devices = [DEVICE]
  h.readSpeakerConfig.mockImplementation(async () => ({ ...h.config }))
  h.fetchConversations.mockReset()
  h.submitAsk.mockReset()
  h.config.takeoverEnabled = false
  _resetConversationMonitorForTest()
})

afterEach(() => {
  _resetConversationMonitorForTest()
  vi.useRealTimers()
})

describe('looksLikeFailedAnswer：空回答算失败，命中片段算失败', () => {
  it('三种情况各自成立', () => {
    expect(looksLikeFailedAnswer('', ['没有找到'])).toBe(true)
    expect(looksLikeFailedAnswer('   ', ['没有找到'])).toBe(true)
    expect(looksLikeFailedAnswer('抱歉，没有找到你说的歌曲', ['没有找到'])).toBe(true)
    expect(looksLikeFailedAnswer('好的，为你播放稻香', ['没有找到'])).toBe(false)
  })

  it('词表是面板那份，不是写死的', () => {
    expect(looksLikeFailedAnswer('没听清你说什么', ['没有找到'])).toBe(false)
    expect(looksLikeFailedAnswer('没听清你说什么', ['没有找到', '没听清'])).toBe(true)
  })
})

describe('轮询时序', () => {
  it('首轮只建基线：那批记录留着看，但全标成历史', async () => {
    h.fetchConversations.mockResolvedValue([rec(1000, '昨天的话'), rec(2000, '昨天的第二句')])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    const { rows, state } = getConversationFeed()
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.fromBaseline)).toBe(true)
    expect(state.running).toBe(true)
    expect(state.lastError).toBeNull()
  })

  it('第二往后只收更新的时间戳，重复内容不重播', async () => {
    h.fetchConversations.mockResolvedValue([rec(2000, '甲'), rec(3000, '乙')])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    h.fetchConversations.mockResolvedValue([rec(2000, '甲'), rec(3000, '乙')])
    await vi.advanceTimersByTimeAsync(2100)
    const { rows } = getConversationFeed()
    expect(rows.filter(r => !r.fromBaseline)).toHaveLength(0)

    h.fetchConversations.mockResolvedValue([rec(2000, '甲'), rec(4000, '丙')])
    await vi.advanceTimersByTimeAsync(2100)
    const fresh = getConversationFeed().rows.filter(r => !r.fromBaseline)
    expect(fresh.map(r => r.query)).toEqual(['丙'])
  })

  it('平台把时间戳往回改时仍能收到刚说的这句（只按"更大才收"会静默漏）', async () => {
    h.fetchConversations.mockResolvedValue([rec(50_000, '先说的')])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    // 同一句被平台重写成了更早的时间戳（在容忍窗口内）：不能因为"不够大"就丢掉
    h.fetchConversations.mockResolvedValue([rec(50_000, '先说的'), rec(45_000, '被改小了的新的一句')])
    await vi.advanceTimersByTimeAsync(2100)
    const fresh = getConversationFeed().rows.filter(r => !r.fromBaseline)
    expect(fresh.map(r => r.query)).toEqual(['被改小了的新的一句'])
  })

  it('拉取失败（非鉴权）：记原因、基线不动、恢复后那句仍能补上', async () => {
    h.fetchConversations.mockResolvedValue([rec(10_000, '第一句')])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    h.fetchConversations.mockRejectedValueOnce(new Error('连接被重置'))
    await vi.advanceTimersByTimeAsync(2100)
    expect(getConversationFeed().state.lastError).toMatch(/连接被重置/)
    // 失败那一拍没把基线推走 ⇒ 恢复后 10_000 之后那句还在
    h.fetchConversations.mockResolvedValue([rec(12_000, '第二句')])
    await vi.advanceTimersByTimeAsync(2100)
    expect(getConversationFeed().rows.filter(r => !r.fromBaseline).map(r => r.query)).toEqual(['第二句'])
  })

  it('票失效：停下不再自己爬，避免拿一台死票反复打小米', async () => {
    h.fetchConversations.mockResolvedValue([])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    h.fetchConversations.mockRejectedValue(new MockAuthError('小爱的票已失效，需要重新登录'))
    await vi.advanceTimersByTimeAsync(2100)
    expect(getConversationFeed().state.lastError).toMatch(/票已失效/)
    const calls = h.fetchConversations.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.fetchConversations.mock.calls.length).toBe(calls)
  })

  it('上游偶发拒绝（mina-client 也抛 XiaomiAuthError，但 status=502）不算票失效 —— 下一拍照常拉', async () => {
    h.fetchConversations.mockResolvedValue([])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    // 2026-10-08 实测：面板上看到的就是这一条（code=999），当时它把整个轮询打死且再也起不来
    h.fetchConversations.mockRejectedValueOnce(new MockAuthError('读取对话记录被拒绝（code=999 ）', 502))
    await vi.advanceTimersByTimeAsync(2100)
    expect(getConversationFeed().state.lastError).toMatch(/code=999/)
    const calls = h.fetchConversations.mock.calls.length
    await vi.advanceTimersByTimeAsync(2100)
    expect(h.fetchConversations.mock.calls.length).toBe(calls + 1)
  })

  it('硬错停住之后，面板再问一次就必须重新排起来（否则 ensure 里那句"等面板来问"是空的）', async () => {
    h.fetchConversations.mockResolvedValue([])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    h.fetchConversations.mockRejectedValue(new MockAuthError('小爱的票已失效，需要重新登录'))
    await vi.advanceTimersByTimeAsync(2100)
    const calls = h.fetchConversations.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.fetchConversations.mock.calls.length).toBe(calls)
    h.fetchConversations.mockResolvedValue([])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    expect(h.fetchConversations.mock.calls.length).toBe(calls + 1)
  })

  it('开关关着：不排程、一行都不读；面板再问一次也不会偷偷起来', async () => {
    // 先真正常开着跑一拍，再关——否则"关"这个状态没被写过，断言等于白过
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    expect(getConversationFeed().state.enabled).toBe(true)
    const callsWhileOn = h.fetchConversations.mock.calls.length
    expect(callsWhileOn).toBeGreaterThan(0)

    h.config.conversationEnabled = false
    const state = await ensureConversationMonitor()
    expect(state.running).toBe(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.fetchConversations.mock.calls.length).toBe(callsWhileOn)
    // 面板读的是 getConversationFeed() 那份状态本体，不是 ensure 的返回值 ⇒ 两边都得是关
    const feed = getConversationFeed()
    expect(feed.state.running).toBe(false)
    expect(feed.state.enabled).toBe(false)
  })

  it('没有在线纳管设备：说清原因而不是安静空转', async () => {
    h.config.devices = [{ ...DEVICE, presence: 'offline' }]
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    expect(getConversationFeed().state.lastError).toMatch(/没有在线且纳管的设备/)
    expect(h.fetchConversations).not.toHaveBeenCalled()
  })

  it('回显只留最近 60 条（长跑不漏内存，也不让面板卡住）', async () => {
    h.fetchConversations.mockResolvedValue([])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    for (let i = 0; i < 70; i++) {
      h.fetchConversations.mockResolvedValue([rec(100_000 + i * 1000, `第 ${i} 句`)])
      await vi.advanceTimersByTimeAsync(2100)
    }
    const { rows } = getConversationFeed()
    expect(rows.length).toBeLessThanOrEqual(60)
    expect(rows[0].query).toBe('第 69 句')
  })

  it('stop 之后定时器真的停了（不是只看标志位）', async () => {
    h.fetchConversations.mockResolvedValue([])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    stopConversationMonitor()
    const calls = h.fetchConversations.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.fetchConversations.mock.calls.length).toBe(calls)
  })
})

describe('每台设备的轮询账目（0 行时得能分清"没在拉"和"平台真没有"）', () => {
  it('拉成功：票子在涨、去重后的条数在涨、首轮之后基线算建好', async () => {
    h.fetchConversations.mockResolvedValue([rec(1000, '甲'), rec(2000, '乙')])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    expect(getConversationFeed().state.devices).toEqual([
      { deviceID: 'D1', name: '小爱音箱Play', primed: true, lastTs: 2000, polls: 1, seen: 2 },
    ])

    // 同一批再拉一次：polls 涨但不该重复计数
    await vi.advanceTimersByTimeAsync(2100)
    const d = getConversationFeed().state.devices[0]
    expect(d.polls).toBe(2)
    expect(d.seen).toBe(2)
  })

  it('拉失败也计一票，且不虚增条数（否则 0 条会被读成"没在拉"）', async () => {
    h.fetchConversations.mockResolvedValue([rec(1000, '甲')])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    h.fetchConversations.mockRejectedValue(new Error('连接被重置'))
    await vi.advanceTimersByTimeAsync(2100)
    const { state } = getConversationFeed()
    expect(state.devices[0]).toMatchObject({ polls: 2, seen: 1, lastTs: 1000, primed: true })
    expect(state.lastError).toMatch(/连接被重置/)
  })

  it('平台回空记录：polls 在涨、seen 是 0 —— 这正是今天真机看到的形状', async () => {
    h.fetchConversations.mockResolvedValue([])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(2100)
    expect(getConversationFeed().state.devices[0]).toMatchObject({ polls: 2, seen: 0, primed: true })
    expect(getConversationFeed().state.lastError).toBeNull()
  })

  it('没有可轮询的设备时账目清空（留着上次的会让面板以为还在拉）', async () => {
    h.fetchConversations.mockResolvedValue([rec(1000, '甲')])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    h.config.devices = [{ ...DEVICE, presence: 'offline' }]
    await vi.advanceTimersByTimeAsync(2100)
    expect(getConversationFeed().state.devices).toEqual([])
  })
})

describe('接管（G3）的进料口', () => {
  it('开关关着时一条都不递给接管（默认状态不许动别人的播放）', async () => {
    h.fetchConversations.mockResolvedValue([rec(1000, '甲')])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    h.fetchConversations.mockResolvedValue([rec(2000, '乙')])
    await vi.advanceTimersByTimeAsync(2100)
    expect(h.submitAsk).not.toHaveBeenCalled()
  })

  it('开着时只递"刚说的"那批，启动时的历史一条都不许递', async () => {
    h.config.takeoverEnabled = true
    h.fetchConversations.mockResolvedValue([rec(1000, '昨天的话'), rec(2000, '昨天第二句')])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    expect(h.submitAsk).not.toHaveBeenCalled()   // 首轮全是 fromBaseline

    h.fetchConversations.mockResolvedValue([rec(1000, '昨天的话'), rec(2000, '昨天第二句'), rec(9000, '刚说的')])
    await vi.advanceTimersByTimeAsync(2100)
    expect(h.submitAsk).toHaveBeenCalledTimes(1)
    expect(h.submitAsk.mock.calls[0][0]).toMatchObject({ query: '刚说的', fromBaseline: false })
  })

  it('重复拉到同一句不重递（去重键在基线那侧，接管不该被同一句话触发两次）', async () => {
    h.config.takeoverEnabled = true
    h.fetchConversations.mockResolvedValue([])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    h.fetchConversations.mockResolvedValue([rec(5000, '下一首')])
    await vi.advanceTimersByTimeAsync(2100)
    expect(h.submitAsk).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2100)
    expect(h.submitAsk).toHaveBeenCalledTimes(1)
  })

  it('去重键不含回答：同一句被平台原地补全时只更新那一行，不多出一条也不重递', async () => {
    h.config.takeoverEnabled = true
    h.fetchConversations.mockResolvedValue([rec(5000, '播放稻香', '')])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    h.fetchConversations.mockResolvedValue([rec(5000, '播放稻香', '好的，为你播放稻香')])
    await vi.advanceTimersByTimeAsync(2100)
    const rows = getConversationFeed().rows.filter(r => r.timestampMs === 5000)
    expect(rows).toHaveLength(1)
    expect(rows[0].answer).toBe('好的，为你播放稻香')
    // 首轮那批是历史 ⇒ 不许递给接管；这里只验"没多出一条/没重递"
    expect(h.submitAsk).not.toHaveBeenCalled()
  })
})

describe('判定结果回填到那一行（③）与时钟偏移告警（②）', () => {
  it('submitAsk 的第二个参数就是回填回调：调用它，那一行立刻带上「处置」', async () => {
    h.config.takeoverEnabled = true
    h.fetchConversations.mockResolvedValue([])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    h.fetchConversations.mockResolvedValue([rec(5000, '下一首', '好的')])
    await vi.advanceTimersByTimeAsync(2100)

    expect(h.submitAsk).toHaveBeenCalledTimes(1)
    const [sentRow, done] = h.submitAsk.mock.calls[0] as unknown as [Return<typeof getConversationFeed>['rows'][number], (e: never) => void]
    expect(typeof done).toBe('function')
    expect(sentRow.takeover).toBeUndefined()
    done({ at: 1, deviceID: 'D1', deviceName: '小爱音箱Play', query: '下一首', answer: '好的', verdict: 'control', reason: '控制词「下一首」命中', acted: '切下一首', synthetic: false } as never)
    // 面板读的是 feed 里那个对象 ⇒ 不用重新拉接口就能看到
    expect(getConversationFeed().rows.find(r => r.timestampMs === 5000)!.takeover)
      .toMatchObject({ verdict: 'control', acted: '切下一首' })
  })

  it('平台时间戳比本机超前 5 分钟以上才报，且只是报出来（不影响任何判据）', async () => {
    const future = Date.now() + 20 * 60_000
    h.fetchConversations.mockResolvedValue([rec(future, '来自未来的一句')])
    await ensureConversationMonitor()
    await vi.advanceTimersByTimeAsync(50)
    expect(getConversationFeed().state.clockSkewMs).toBeGreaterThan(19 * 60_000)

    // 5 分钟以内（网络往返那点差）不该在面板上喊
    h.fetchConversations.mockResolvedValue([rec(Date.now() + 30_000, '正常的一句')])
    await vi.advanceTimersByTimeAsync(2100)
    expect(getConversationFeed().state.clockSkewMs).toBeNull()
  })
})

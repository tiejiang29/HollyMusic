/**
 * 第②层（点歌判据）的测试。
 *
 * 这一层的价值全在"什么时候不动"上，所以用例基本都是反向的：
 * 1. **回答不参与判据**（2026-10-09 用户拍的：这台没会员，小爱点歌必回试听版，答得越顺越是片段）
 *    —— 唯一的闸门是触发词，所以"不含触发词"那一格必须钉死；
 * 2. **启动时那批历史一条都不许吃**（面板重放昨天的话，音箱半夜自己唱起来）；
 * 3. **旧话不许打断现在的播放**；
 * 4. 控制词只在"这台正被我们投放"时动。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  readSpeakerConfig: vi.fn(),
  castView: vi.fn(),
  controlSpeaker: vi.fn(),
  setSpeakerVolume: vi.fn(),
  skipCast: vi.fn(),
  stopCast: vi.fn(),
  startCast: vi.fn(),
  refreshCast: vi.fn(),
  searchOneSource: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/services/xiaomi/token-store', () => ({ readSpeakerConfig: h.readSpeakerConfig }))
vi.mock('@/lib/services/xiaomi/cast-session', () => ({
  castView: h.castView, refreshCast: h.refreshCast, skipCast: h.skipCast, startCast: h.startCast, stopCast: h.stopCast,
}))
vi.mock('@/lib/services/xiaomi/speaker-play', () => ({
  controlSpeaker: h.controlSpeaker, setSpeakerVolume: h.setSpeakerVolume,
}))
vi.mock('@/lib/services/song-search-service', () => ({ searchOneSource: h.searchOneSource }))

const mod = await import('@/lib/services/xiaomi/voice-takeover')
const { decideTakeover, handleAskNow, getTakeoverLog, submitAsk, _resetVoiceTakeoverForTest, STALE_ASK_SEC } = mod
const { DEFAULT_MUSIC_TRIGGERS } = await import('@/lib/services/xiaomi/voice-control')

const now = Date.now()
const row = (over: Record<string, unknown> = {}) => ({
  deviceID: 'D1', deviceName: '小爱音箱Play', timestampMs: now, receivedAt: now,
  query: '放稻香', answer: '', looksFailed: false, fromBaseline: false, ...over,
}) as never

const config = (over: Record<string, unknown> = {}) => ({
  takeoverEnabled: true, fuzzyMatchCutoff: 0.6,
  takeoverSources: ['tx'], controlRules: [], volumeStep: 10,
  takeoverTriggers: DEFAULT_MUSIC_TRIGGERS, takeoverMinTrackSec: 0,
  failedAnswerHints: ['没有找到', '没听清'], ...over,
}) as never

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset()
  h.readSpeakerConfig.mockResolvedValue(config())
  h.castView.mockResolvedValue(null)
  h.searchOneSource.mockResolvedValue({ list: [] })
  _resetVoiceTakeoverForTest()
})

describe('判据不看小爱答了什么（2026-10-09 用户拍的）', () => {
  // 这台没音乐会员，点歌口令小爱总是接走并回「请欣赏X 试听版…开通音乐会员听全曲」——
  // 回答越顺越是片段（实测设备 duration=30024ms，整曲是 04:59），所以"它答上了"根本不该拦事
  it('同一句点歌：没回答、答砸了、答得很顺 —— 三种回答都照样顶上', async () => {
    h.searchOneSource.mockResolvedValue({ list: [{ name: '稻香', singer: '周杰伦', uid: 'tx-S1', interval: '223' }] })
    for (const answer of ['', '抱歉，没有找到你说的歌曲', '好的，请欣赏稻香 试听版，开通音乐会员听全曲']) {
      const d = await decideTakeover(row({ query: '播放稻香', answer }), config())
      expect(d).toMatchObject({ verdict: 'takeover', uid: 'tx-S1' })
    }
  })

  it('回答里带不带失败话术也不影响（那条词表只剩回显那一格在用）', async () => {
    h.searchOneSource.mockResolvedValue({ list: [] })
    await decideTakeover(row({ query: '播放稻香', answer: '好的' }), config())
    await decideTakeover(row({ query: '播放稻香', answer: '没有找到' }), config())
    expect(h.searchOneSource).toHaveBeenCalledTimes(2)
  })
})

describe('判据矩阵', () => {
  it('控制词命中优先于一切（零网络，第①层不该去打搜索）', async () => {
    const d = await decideTakeover(row({ query: '下一首', answer: '好的' }), config())
    expect(d).toMatchObject({ verdict: 'control', op: 'next' })
    expect(h.searchOneSource).not.toHaveBeenCalled()
  })

  it('启动时那批历史一条都不吃', async () => {
    const d = await decideTakeover(row({ fromBaseline: true, query: '下一首' }), config())
    expect(d.verdict).toBe('rejected')
  })

  it('旧话不许打断现在的播放（轮询卡一下回来的那句）', async () => {
    const old = row({ timestampMs: now - (STALE_ASK_SEC + 30) * 1000, query: '下一首' })
    expect((await decideTakeover(old, config())).verdict).toBe('stale')
    // 边界内还要接（别把"过了 89 秒"也判成旧的）
    const nearly = row({ timestampMs: now - (STALE_ASK_SEC - 10) * 1000, query: '下一首' })
    expect((await decideTakeover(nearly, config())).verdict).toBe('control')
  })

  it('有触发词但搜不到 ⇒ no-hit，不动', async () => {
    const d = await decideTakeover(row({ query: '播放稻香', answer: '抱歉，没有找到' }), config())
    expect(d.verdict).toBe('no-hit')
  })

  // 真机模拟里踩过的一条：曲库里真有一首就叫《今天天气怎么样》，一句天气问答配上它相似度 100%
  // ⇒ 把问答变成了放歌。现在唯一的闸门就是触发词，所以这一格必须钉住：**没有触发词就一次搜索都不发**
  it('问天气（不含触发词）⇒ not-music，一次搜索都不发（曲库里真有这么一首也不能抢）', async () => {
    h.searchOneSource.mockResolvedValue({ list: [{ name: '今天天气怎么样', singer: '某歌手', uid: 'kw-9', interval: '200' }] })
    const d = await decideTakeover(row({ query: '今天天气怎么样', answer: '抱歉，没有找到你说的歌曲' }), config())
    expect(d.verdict).toBe('not-music')
    expect(h.searchOneSource).not.toHaveBeenCalled()
  })

  it('换个说法同一句就变成点歌（触发词是面板那一项，不是硬编的）', async () => {
    h.searchOneSource.mockResolvedValue({ list: [{ name: '今天天气怎么样', singer: '某歌手', uid: 'kw-9', interval: '200' }] })
    const d = await decideTakeover(row({ query: '我想听今天天气怎么样', answer: '没有找到' }), config())
    expect(d.verdict).toBe('takeover')
  })

  it('搜的时候用的是去掉触发词的那半句（整句去搜会把匹配度拖下去）', async () => {
    h.searchOneSource.mockResolvedValue({ list: [] })
    await decideTakeover(row({ query: '播放稻香', answer: '没有找到' }), config())
    expect(h.searchOneSource.mock.calls[0][1]).toBe('稻香')
  })

  it('搜到了但不够像 ⇒ 不投（阈值判据要看得见两个数）', async () => {
    h.searchOneSource.mockResolvedValue({ list: [{ name: '学猫叫', singer: '小潘潘', uid: 'tx-X', interval: '200' }] })
    // 「播放青花瓷」和《学猫叫》既不互相包含、编辑距离也远，必须挡住
    const d = await decideTakeover(row({ query: '播放青花瓷', answer: '没听清你说什么' }), config())
    expect(d.verdict).toBe('no-hit')
    expect(d.reason).toMatch(/低于/)
  })

  it('够像才 takeover，并带上是哪条候选', async () => {
    h.searchOneSource.mockResolvedValue({ list: [{ name: '稻香', singer: '周杰伦', uid: 'tx-S1', interval: '223' }] })
    const d = await decideTakeover(row({ query: '播放稻香', answer: '没有找到' }), config())
    expect(d).toMatchObject({ verdict: 'takeover', uid: 'tx-S1', name: '稻香' })
  })

  it('窗口内的说法照旧认：「稻香这首歌」还是配上《稻香》', async () => {
    h.searchOneSource.mockResolvedValue({ list: [{ name: '稻香', singer: '周杰伦', uid: 'tx-S1', interval: '223' }] })
    const d = await decideTakeover(row({ query: '播放稻香这首歌', answer: '没有找到' }), config())
    expect(d).toMatchObject({ verdict: 'takeover', uid: 'tx-S1' })
  })

  it('整句里嵌着两个真歌名不许当点歌（这是模拟口令实测打出来的）', async () => {
    h.searchOneSource.mockResolvedValue({ list: [{ name: '不存在的', singer: '某歌手', uid: 'tx-Y', interval: '200' }] })
    const d = await decideTakeover(row({ query: '播放 一首绝对不存在的歌名QQZXTY', answer: '没有找到相关的歌曲' }), config())
    expect(d.verdict).toBe('no-hit')
  })

  it('一台源搜索挂了不算"没搜到"：换下一台，同时留下警告', async () => {
    h.readSpeakerConfig.mockResolvedValue(config({ takeoverSources: ['tx', 'kg'] }))
    h.searchOneSource
      .mockRejectedValueOnce(new Error('上游 503'))
      .mockResolvedValueOnce({ list: [{ name: '稻香', singer: '周杰伦', uid: 'kg-S9', interval: '223' }] })
    const d = await decideTakeover(row({ query: '放一首稻香', answer: '没有找到' }), config({ takeoverSources: ['tx', 'kg'] }))
    expect(d.verdict).toBe('takeover')
    expect(d.uid).toBe('kg-S9')
  })

  it('列表里几台就搜几台，而且是并行搜（串行会把首包按台数叠加）', async () => {
    let inflight = 0
    let peak = 0
    h.searchOneSource.mockImplementation(async () => {
      inflight += 1
      peak = Math.max(peak, inflight)
      await new Promise(r => setTimeout(r, 5))
      inflight -= 1
      return { list: [] }
    })
    await decideTakeover(row({ query: '播放稻香', answer: '没听清' }), config({ takeoverSources: ['kw', 'mg', 'wy', 'kg'] }))
    expect(h.searchOneSource.mock.calls.length).toBe(4)
    expect(peak).toBe(4)
  })

  it('平分时候选取列表里靠前的那台：顺序就是管理员的决定', async () => {
    h.searchOneSource.mockImplementation(async (source: string) => ({
      list: [{ name: '稻香', singer: '周杰伦', uid: `${source}-S1`, interval: '223' }],
    }))
    const d = await decideTakeover(row({ query: '播放稻香', answer: '' }), config({ takeoverSources: ['mg', 'kw'] }))
    expect(d.uid).toBe('mg-S1')
  })
})

describe('整曲门槛（候选要像整曲，别让我们自己也端上 30 秒片段）', () => {
  // 2026-10-09 真机：小爱给的是 30024ms 的《你不知道》试听版，而我们搜到的整曲是 03:45。
  // 同名剪辑版/铃声版在我们候选里同样会出现，所以先保证"手里这条是整曲"。
  const twoVersions = {
    list: [
      { name: '稻香', singer: '周杰伦', uid: 'tx-short', interval: '30' },
      { name: '稻香', singer: '周杰伦', uid: 'tx-full', interval: '223' },
    ],
  }

  it('同名两条：短的被判过短跳过，投的是整曲那条', async () => {
    h.searchOneSource.mockResolvedValue(twoVersions)
    const d = await decideTakeover(row({ query: '播放稻香', answer: '没有找到' }), config({ takeoverMinTrackSec: 90 }))
    expect(d).toMatchObject({ verdict: 'takeover', uid: 'tx-full' })
  })

  it('门槛填 0 = 关掉这层 ⇒ 同一份候选退回投短的那条（反证：上面那条真是门槛挡的）', async () => {
    h.searchOneSource.mockResolvedValue(twoVersions)
    const d = await decideTakeover(row({ query: '播放稻香', answer: '没有找到' }), config({ takeoverMinTrackSec: 0 }))
    expect(d.uid).toBe('tx-short')
  })

  it('只剩过短的那条 ⇒ no-hit，且理由里要说清是被门槛挡的（不然管理员会以为曲库里没有）', async () => {
    h.searchOneSource.mockResolvedValue({ list: [{ name: '稻香', singer: '周杰伦', uid: 'tx-short', interval: '30' }] })
    const d = await decideTakeover(row({ query: '播放稻香', answer: '没有找到' }), config({ takeoverMinTrackSec: 90 }))
    expect(d.verdict).toBe('no-hit')
    expect(d.reason).toMatch(/1 条被"像整曲"的门槛挡掉/)
  })

  it('拿不到时长不算过短（元数据本身也会错，宁可放过也不清空候选）', async () => {
    h.searchOneSource.mockResolvedValue({ list: [{ name: '稻香', singer: '周杰伦', uid: 'tx-noDur', interval: '' }] })
    const d = await decideTakeover(row({ query: '播放稻香', answer: '没有找到' }), config({ takeoverMinTrackSec: 90 }))
    expect(d).toMatchObject({ verdict: 'takeover', uid: 'tx-noDur' })
  })
})

describe('执行：动之前要先确认这台归我们管', () => {
  it('控制词命中但没有投放会话 ⇒ 一句"交回小爱"，一条指令都不发', async () => {
    h.castView.mockResolvedValue(null)
    const r = await handleAskNow(row({ query: '下一首', answer: '好的' }))
    expect(r.acted).toMatch(/没有我们的投放会话/)
    expect(h.skipCast).not.toHaveBeenCalled()
    expect(h.controlSpeaker).not.toHaveBeenCalled()
  })

  it('有会话时 7 个操作各自落到对的地方', async () => {
    h.castView.mockResolvedValue({ volume: 40, deviceID: 'D1' })
    const cases: Array<[string, string]> = [
      ['暂停播放', 'pause'], ['继续播放', 'resume'], ['下一首', 'next'], ['上一首', 'prev'], ['停止播放', 'stop'],
    ]
    for (const [query] of cases) {
      await handleAskNow(row({ query, answer: '好的' }))
    }
    expect(h.controlSpeaker).toHaveBeenCalledWith('pause', 'D1')
    // 我们对外叫 resume，小米那条报文里的 action 是 play
    expect(h.controlSpeaker).toHaveBeenCalledWith('play', 'D1')
    expect(h.skipCast.mock.calls.map(c => c[0])).toEqual([1, -1])
    expect(h.stopCast).toHaveBeenCalledWith('D1')
  })

  it('音量起点必须现读：会漂（实测 44→32），不能拿上次那个数', async () => {
    h.castView.mockResolvedValue({ volume: 44 })
    await handleAskNow(row({ query: '小声一点', answer: '好的' }))
    expect(h.setSpeakerVolume).toHaveBeenCalledWith(34, 'D1')
    h.castView.mockResolvedValue({ volume: -1 })
    await handleAskNow(row({ query: '大声一点', answer: '好的' }))
    // 读不到时按中间档起，不许按 0（那会变成"小声点反而最响"）
    expect(h.setSpeakerVolume).toHaveBeenLastCalledWith(60, 'D1')
  })

  it('"音量调到 80"直接给绝对值', async () => {
    h.castView.mockResolvedValue({ volume: 20 })
    await handleAskNow(row({ query: '音量调到 80', answer: '好的' }))
    expect(h.setSpeakerVolume).toHaveBeenCalledWith(80, 'D1')
  })

  it('接管开关关着时，判出来了也不动（面板那格的语义就是"别动"）', async () => {
    h.readSpeakerConfig.mockResolvedValue(config({ takeoverEnabled: false }))
    const r = await handleAskNow(row({ query: '下一首', answer: '好的' }))
    expect(r.verdict).toBe('control')
    expect(r.acted).toMatch(/接管开关关着/)
    expect(h.skipCast).not.toHaveBeenCalled()
  })

  it('接管成功时投的是判出来那条候选，且带着相似度', async () => {
    h.searchOneSource.mockResolvedValue({ list: [{ name: '稻香', singer: '周杰伦', uid: 'tx-S1', interval: '223' }] })
    h.startCast.mockResolvedValue({})
    const r = await handleAskNow(row({ query: '播放稻香', answer: '没有找到' }))
    expect(h.startCast).toHaveBeenCalledWith(expect.objectContaining({
      // durSec 必须带上：接管只投这一首，看门狗要靠这个时长算出"什么时候该收口"
      current: { uid: 'tx-S1', durSec: 223 }, rest: [], deviceID: 'D1',
    }))
    expect(r.acted).toContain('稻香')
  })

  it('执行炸了不许把链子打断：记一句"想动但失败了"，账目照常留', async () => {
    h.castView.mockResolvedValue({ volume: 30 })
    h.skipCast.mockRejectedValue(new Error('音箱没认这条切歌指令'))
    const r = await handleAskNow(row({ query: '下一首', answer: '好的' }))
    expect(r.acted).toMatch(/想动但失败了/)
    expect(getTakeoverLog()[0].query).toBe('下一首')
  })

  it('账目只留最近 40 条，且合成与真话分得开', async () => {
    for (let i = 0; i < 45; i++) {
      await handleAskNow(row({ query: `第 ${i} 句`, answer: '好的，为你播放' }), { synthetic: i % 2 === 0 })
    }
    const log = getTakeoverLog()
    expect(log.length).toBeLessThanOrEqual(40)
    // 最后一条是 i=44（偶数 ⇒ 合成），顺序与来源标记都要对得上
    expect(log[0].synthetic).toBe(true)
    expect(log[0].query).toBe('第 44 句')
  })

  // 排队是有意不 await 的（别把轮询那一拍拖长），所以测试要排干：一次 macrotask 把挂着的
  // microtask（`readSpeakerConfig`/`castView` 这些 mock 的 promise）全冲掉
  const drain = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0)) }

  it('submitAsk 的回调拿到的是同一条判定：回显那一行靠它显示「处置」，不用两张表对齐', async () => {
    const r = row({ query: '下一首', answer: '好的' })
    const done = vi.fn()
    submitAsk(r, done)
    await drain()
    expect(done).toHaveBeenCalledTimes(1)
    expect(done.mock.calls[0][0]).toMatchObject({ verdict: 'control', query: '下一首' })
  })

  it('回调里炸了不许把队打断：后面那条照常处理', async () => {
    submitAsk(row({ query: '下一首', answer: '好的' }), () => { throw new Error('回填炸了') })
    const second = vi.fn()
    submitAsk(row({ query: '暂停播放', answer: '好的' }), second)
    await drain()
    expect(second).toHaveBeenCalledTimes(1)
    expect(getTakeoverLog().map(l => l.query)).toEqual(['暂停播放', '下一首'])
  })
})

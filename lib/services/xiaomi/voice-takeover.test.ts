/**
 * 第②层（读小爱的回答判成败）的测试。
 *
 * 这一层的价值全在"什么时候不动"上，所以用例基本都是反向的：
 * 1. **答上了不许抢**（抢了两边同时出声，是 G2 那轮已经踩过一次的同类事故）；
 * 2. **拿不到证据 ≠ 答砸了** —— 默认立场必须是不动（今天实测对话接口回 0 条，
 *    把"没有证据"当"它失败了"会让接管在毫无依据时乱投歌）；
 * 3. **启动时那批历史一条都不许吃**（面板重放昨天的话，音箱半夜自己唱起来）；
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
const { decideTakeover, handleAskNow, answeredOk, getTakeoverLog, _resetVoiceTakeoverForTest, STALE_ASK_SEC } = mod
const { DEFAULT_MUSIC_TRIGGERS } = await import('@/lib/services/xiaomi/voice-control')

const now = Date.now()
const row = (over: Record<string, unknown> = {}) => ({
  deviceID: 'D1', deviceName: '小爱音箱Play', timestampMs: now, receivedAt: now,
  query: '放稻香', answer: '', looksFailed: false, fromBaseline: false, ...over,
}) as never

const config = (over: Record<string, unknown> = {}) => ({
  takeoverEnabled: true, takeoverWithoutEvidence: false, fuzzyMatchCutoff: 0.6,
  takeoverSources: ['tx'], controlRules: [], volumeStep: 10,
  takeoverTriggers: DEFAULT_MUSIC_TRIGGERS,
  failedAnswerHints: ['没有找到', '没听清'], ...over,
}) as never

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset()
  h.readSpeakerConfig.mockResolvedValue(config())
  h.castView.mockResolvedValue(null)
  h.searchOneSource.mockResolvedValue({ list: [] })
  _resetVoiceTakeoverForTest()
})

describe('判"小爱答上了没"：三态里必须有"没有证据"这一格', () => {
  it('空回答 = 没证据(null)，命中失败话术 = 没答上(false)，其余 = 答上了(true)', () => {
    expect(answeredOk(row({ answer: '' }), ['没有找到'])).toBeNull()
    expect(answeredOk(row({ answer: '   ' }), ['没有找到'])).toBeNull()
    expect(answeredOk(row({ answer: '抱歉，没有找到你说的歌曲' }), ['没有找到'])).toBe(false)
    expect(answeredOk(row({ answer: '好的，为你播放稻香' }), ['没有找到'])).toBe(true)
  })
})

describe('判据矩阵', () => {
  it('它答上了 ⇒ 不抢（reason 里要看得见那句回答）', async () => {
    const d = await decideTakeover(row({ answer: '好的，为你播放稻香' }), config())
    expect(d.verdict).toBe('answered')
    expect(d.reason).toContain('为你播放稻香')
  })

  it('拿不到回答 + 默认立场 ⇒ standby（不许折算成"它答砸了"）', async () => {
    const d = await decideTakeover(row({ answer: '' }), config())
    expect(d.verdict).toBe('standby')
    expect(h.searchOneSource).not.toHaveBeenCalled()
  })

  it('同一句在"没证据也接管"打开时才继续往下找（而且仍要像个点歌的说法）', async () => {
    h.searchOneSource.mockResolvedValue({ list: [{ name: '稻香', singer: '周杰伦', uid: 'tx-S1', interval: '223' }] })
    const d = await decideTakeover(row({ query: '播放稻香', answer: '' }), config({ takeoverWithoutEvidence: true }))
    expect(d.verdict).toBe('takeover')
  })

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

  it('像没答上但搜不到 ⇒ no-hit，不动', async () => {
    const d = await decideTakeover(row({ query: '播放稻香', answer: '抱歉，没有找到' }), config())
    expect(d.verdict).toBe('no-hit')
  })

  // 真机模拟里踩过的一条：曲库里真有一首就叫《今天天气怎么样》，小爱对天气问句答"没有找到"，
  // 相似度立刻 100% ⇒ 把一句天气问答变成了放歌。"它没答上"必须再配上"这话像点歌"才接
  it('问天气 + 它没答上 ⇒ not-music，一次搜索都不发（曲库里真有这么一首也不能抢）', async () => {
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

  it('一台源搜索挂了不算"没搜到"：换下一台，同时留下警告', async () => {
    h.readSpeakerConfig.mockResolvedValue(config({ takeoverSources: ['tx', 'kg'] }))
    h.searchOneSource
      .mockRejectedValueOnce(new Error('上游 503'))
      .mockResolvedValueOnce({ list: [{ name: '稻香', singer: '周杰伦', uid: 'kg-S9', interval: '223' }] })
    const d = await decideTakeover(row({ query: '放一首稻香', answer: '没有找到' }), config({ takeoverSources: ['tx', 'kg'] }))
    expect(d.verdict).toBe('takeover')
    expect(d.uid).toBe('kg-S9')
  })

  it('最多用前三台（口令是短句，翻页找冷门只会把首包拖慢）', async () => {
    await decideTakeover(row({ query: '播放稻香', answer: '没听清' }), config({ takeoverSources: ['tx', 'kg', 'kw', 'mg', 'wy'] }))
    expect(h.searchOneSource.mock.calls.length).toBeLessThanOrEqual(3)
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
      current: { uid: 'tx-S1', durSec: 0 }, rest: [], deviceID: 'D1',
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
})

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

describe('报了歌手又报歌名（「播放孙燕姿我怀念的」那一类）', () => {
  // 老判据只比歌名，靠 +4 字窗口硬撑：三字歌手名 + 「的」+ 两字歌名（「五月天的倔强」）就已经把
  // 窗口用满，歌手名再长一点或带英文就破。下面 ②③ 两条形状改之前都是 no-hit，是这次要救的对象。
  const one = (name: string, singer: string, uid: string) => ({ list: [{ name, singer, uid, interval: '223' }] })

  it('中文歌手名 + 的 + 歌名：剥掉歌手剩下的那半句去配歌名 ⇒ 满分，理由里要写"歌手对上了"', async () => {
    h.searchOneSource.mockResolvedValue(one('我怀念的', '孙燕姿', 'kw-231323'))
    const d = await decideTakeover(row({ query: '播放孙燕姿的我怀念的', answer: '好的，为你播放' }), config())
    expect(d).toMatchObject({ verdict: 'takeover', uid: 'kw-231323', score: 1 })
    expect(d.reason).toContain('歌手对上了「孙燕姿」')
  })

  it('长歌手名（「G.E.M.邓紫棋」这种）：歌名那一半撑不进 +4 字窗口，靠剥歌手命中', async () => {
    h.searchOneSource.mockResolvedValue(one('天空没有极限', 'G.E.M.邓紫棋', 'kw-1'))
    // 反证：歌手名归一后 7 字 + 歌名 6 字 = 13 字，比窗口上限（6+4=10）长，老那条路必然配不上
    const d = await decideTakeover(row({ query: '播放G.E.M.邓紫棋的天空没有极限', answer: '没有找到' }), config())
    expect(d).toMatchObject({ verdict: 'takeover', uid: 'kw-1', score: 1 })
  })

  it('纯英文歌手名也一样：「Taylor Swift的Love Story」不该因为句子长就点不着', async () => {
    h.searchOneSource.mockResolvedValue(one('Love Story', 'Taylor Swift', 'mg-7'))
    const d = await decideTakeover(row({ query: '播放Taylor Swift的Love Story', answer: '没有找到' }), config())
    expect(d).toMatchObject({ verdict: 'takeover', uid: 'mg-7' })
  })

  it('反证：只报人不报歌名（「播放孙燕姿」）不许抢 —— 剥完必须还剩 ≥2 字', async () => {
    h.searchOneSource.mockResolvedValue(one('遇见', '孙燕姿', 'kw-9'))
    const d = await decideTakeover(row({ query: '播放孙燕姿', answer: '好的，为你播放孙燕姿的歌' }), config())
    expect(d.verdict).toBe('no-hit')
    // 也不许瞎补第二搜：这句话没有任何分隔可拆
    expect(h.searchOneSource).toHaveBeenCalledTimes(1)
  })

  it('反证：剥掉歌手只剩一个碎字也不给配（曲库里真有单字歌名时那是抢播）', async () => {
    h.searchOneSource.mockResolvedValue(one('无', '孙燕姿', 'kw-1'))
    const d = await decideTakeover(row({ query: '播放孙燕姿无', answer: '好的' }), config())
    expect(d.verdict).toBe('no-hit')
  })

  it('同分两条（正版与同名翻唱）：点了歌手的那条赢，哪怕它排在后面', async () => {
    h.searchOneSource.mockResolvedValue({
      list: [
        { name: '遇见', singer: '某翻唱', uid: 'kg-1', interval: '223' },
        { name: '遇见', singer: '孙燕姿', uid: 'kw-2', interval: '223' },
      ],
    })
    const d = await decideTakeover(row({ query: '播放孙燕姿的遇见', answer: '没有找到' }), config())
    expect(d.uid).toBe('kw-2')
  })

  it('但歌手不做硬闸门：点了孙燕姿而曲库里只有翻唱版，照样顶上（有声音 > 点对歌手）', async () => {
    h.searchOneSource.mockResolvedValue(one('遇见', '某翻唱', 'kg-1'))
    const d = await decideTakeover(row({ query: '播放孙燕姿的遇见', answer: '没有找到' }), config())
    expect(d).toMatchObject({ verdict: 'takeover', uid: 'kg-1' })
  })

  it('兜底二次搜索：整串那一轮空手，才按分隔把歌名再搜一次（判据仍然拿原句量）', async () => {
    h.searchOneSource.mockImplementation(async (_s: never, keyword: string) => (
      keyword === 'Taylor Swift的Love Story'
        ? { list: [] }
        : { list: [{ name: 'Love Story', singer: 'Taylor Swift', uid: 'mg-7', interval: '245' }] }
    ))
    const d = await decideTakeover(row({ query: '播放Taylor Swift的Love Story', answer: '没有找到' }), config())
    expect(d).toMatchObject({ verdict: 'takeover', uid: 'mg-7' })
    expect(h.searchOneSource.mock.calls.map(c => c[1])).toEqual(['Taylor Swift的Love Story', 'Love Story'])
  })

  it('歌名自己以「的」结尾时不许切：「播放我怀念的」只搜整串那一次', async () => {
    h.searchOneSource.mockResolvedValue(one('我怀念的', '孙燕姿', 'kw-231323'))
    const d = await decideTakeover(row({ query: '播放我怀念的', answer: '好的' }), config())
    expect(d).toMatchObject({ verdict: 'takeover', uid: 'kw-231323' })
    // 切成「我怀念」会把歌名弄坏，所以右半边不足两字的那种切法必须放弃
    expect(h.searchOneSource.mock.calls.map(c => c[1])).toEqual(['我怀念的'])
  })

  it('整串那一轮已经够像 ⇒ 不多打一次搜索（兜底只走失败路径）', async () => {
    h.searchOneSource.mockResolvedValue(one('稻香', '周杰伦', 'kw-1'))
    await decideTakeover(row({ query: '播放周杰伦的稻香', answer: '好的' }), config())
    expect(h.searchOneSource).toHaveBeenCalledTimes(1)
  })
})

describe('生产那批真行：仿唱挂名不许反超正版（2026-10-11 真机选错了）', () => {
  // 这份候选是 2026-10-11 生产上「播放邓紫棋的泡沫」那一发**逐字抄下来的真数据**
  // （kw 搜「邓紫棋的泡沫」前 10 条里进账的那几条，见 my/paomo-probe.out.txt）。
  // 改之前的判据会把 `kw-300085735`「泡沫」／「张新航&邓 紫 棋」顶上来：它的歌手字段拆得出「邓紫棋」
  // ⇒ 命中，而正版「G.E.M.邓紫棋」只认整名所以判不出命中 ⇒ 同分时反倒输给挂名的仿唱。
  const KW_真行 = [
    { name: '泡沫 (3D环绕版)', singer: 'G.E.M.邓紫棋', uid: 'kw-157537198', interval: '251' },
    { name: '泡沫', singer: '张新航&邓 紫 棋', uid: 'kw-300085735', interval: '259' },
    { name: '句号', singer: '张新航&邓紫棋', uid: 'kw-346719460', interval: '231' },
    { name: '泡沫', singer: 'G.E.M.邓紫棋', uid: 'kw-1245657', interval: '258' },
    { name: '泡沫 (G.E.M.重生版)', singer: 'G.E.M.邓紫棋', uid: 'kw-478175182', interval: '258' },
  ]
  const feed = (list: typeof KW_真行) => h.searchOneSource.mockResolvedValue({ list })

  it('仿唱排在前、正版排在后 ⇒ 取正版，理由里不许写"歌手对上了"给仿唱', async () => {
    feed(KW_真行)
    const d = await decideTakeover(row({ query: '播放邓紫棋的泡沫', answer: '好呀，请听泡沫 试听版' }), config())
    expect(d).toMatchObject({ verdict: 'takeover', uid: 'kw-1245657', score: 1 })
    expect(d.reason).toContain('歌手对上了「G.E.M.邓紫棋」')
    expect(d.reason).not.toContain('张新航')
  })

  it('正版排在前 ⇒ 还是它（这一档不该把已经赢的那条换下去）', async () => {
    feed([KW_真行[3], ...KW_真行.slice(0, 3)])
    const d = await decideTakeover(row({ query: '播放邓紫棋的泡沫' }), config())
    expect(d.uid).toBe('kw-1245657')
  })

  it('没带「的」的那句说法也认：剥掉拉丁前缀的「邓紫棋」照样是命中', async () => {
    feed(KW_真行)
    const d = await decideTakeover(row({ query: '播放邓紫棋泡沫' }), config())
    expect(d.uid).toBe('kw-1245657')
  })

  it('合唱名单（挂着好几个人）降到弱一档，但只有它时也照样顶上（不做硬过滤）', async () => {
    feed([
      { name: '泡沫', singer: 'G.E.M.邓紫棋、余赛亚、戴斯琪、肖茗', uid: 'wy-486194120', interval: '239' },
    ])
    const d = await decideTakeover(row({ query: '播放邓紫棋的泡沫' }), config())
    expect(d).toMatchObject({ verdict: 'takeover', uid: 'wy-486194120' })
    expect(d.reason).toContain('名单里还挂着别人')
  })

  it('独名与合唱名单同时在场 ⇒ 取独名那条（正版是录音室版，不是活动合唱版）', async () => {
    feed([
      { name: '泡沫', singer: 'G.E.M.邓紫棋、余赛亚、戴斯琪、肖茗', uid: 'wy-486194120', interval: '239' },
      { name: '泡沫', singer: 'G.E.M.邓紫棋', uid: 'wy-233931', interval: '258' },
    ])
    const d = await decideTakeover(row({ query: '播放邓紫棋的泡沫' }), config())
    expect(d.uid).toBe('wy-233931')
  })

  it('歌名里本身就挂着那个人的名字也不许加分：判据只比曲名，那段"人"是从**艺名字段**里认的', async () => {
    // 这两条是真上游回的（kw/wy 那 10 条里的仿唱标题）：曲名里带「邓紫棋」，但艺名根本不是她。
    // 双向命中只认"句子里那段落在**候选的艺名**里"，所以它们仍然是 0 档，赢不了独名的正版。
    feed([
      { name: '邓紫棋-泡沫', singer: '王宝鑫', uid: 'wy-1993474630', interval: '135' },
      { name: '泡沫(流行版)(cover邓紫棋)', singer: '皮皮的钹', uid: 'mg-1144179860', interval: '239' },
      { name: '泡沫', singer: 'G.E.M.邓紫棋', uid: 'kw-1245657', interval: '258' },
    ])
    const d = await decideTakeover(row({ query: '播放邓紫棋的泡沫' }), config())
    expect(d.uid).toBe('kw-1245657')
  })

  it('连曲名都整句撞上《邓紫棋的泡沫》时，靠"艺名干不干净"分：卡拉OK版降到 0 档', async () => {
    feed([
      { name: '邓紫棋的泡沫', singer: '星光影音乐队', uid: 'kw-900001', interval: '250' },
      { name: '泡沫', singer: 'G.E.M.邓紫棋', uid: 'kw-1245657', interval: '258' },
    ])
    const d = await decideTakeover(row({ query: '播放邓紫棋的泡沫' }), config())
    expect(d.uid).toBe('kw-1245657')
  })

  it('倒过来说「泡沫的邓紫棋」也投得对：歌名那一半照旧拿整句量，mention 只是"人"那一侧的判据', async () => {
    feed([
      { name: '邓紫棋-泡沫', singer: '王宝鑫', uid: 'wy-1993474630', interval: '135' },
      { name: '泡沫', singer: 'G.E.M.邓紫棋', uid: 'kw-1245657', interval: '258' },
    ])
    const d = await decideTakeover(row({ query: '播放泡沫的邓紫棋' }), config())
    expect(d.uid).toBe('kw-1245657')
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

  it('账目只留合成行与异常行：真话正常判定不进账（2026-10-10 瘦身）', async () => {
    // 真话 + 正常处置：verdict/acted 已经回填到对话回显那一行，这张表再抄一遍没有新信息
    await handleAskNow(row({ query: '下一首', answer: '好的' }))
    await handleAskNow(row({ query: '播放稻香', answer: '好的，为你播放' }))
    await handleAskNow(row({ query: '今天天气怎么样', answer: '晴' }))
    expect(getTakeoverLog()).toHaveLength(0)

    // 三类要留的：① 合成行（模拟口令压根不进对话记录）② 想动但失败了 ③ stale / rejected
    await handleAskNow(row({ query: '模拟的那句', answer: '好的' }), { synthetic: true })
    h.castView.mockResolvedValue({ volume: 30 })
    h.skipCast.mockRejectedValueOnce(new Error('切歌没认这条指令'))
    await handleAskNow(row({ query: '上一首', answer: '好的' }))
    await handleAskNow(row({ query: '很久之前那句', answer: '好的', timestampMs: now - (STALE_ASK_SEC + 30) * 1000 }))
    await handleAskNow(row({ query: '启动时的历史', answer: '好的', fromBaseline: true }))

    // 新的在前，且真话那三条确实没混进来
    expect(getTakeoverLog().map(l => l.query)).toEqual([
      '启动时的历史', '很久之前那句', '上一首', '模拟的那句',
    ])
    expect(getTakeoverLog().every(l => l.synthetic || l.verdict === 'stale' || l.verdict === 'rejected'
      || l.acted.startsWith('想动但失败了'))).toBe(true)
  })

  it('账目只留最近 20 条（瘦身之后进来的都是要看的，更长的属于回显那张表）', async () => {
    for (let i = 0; i < 25; i++) {
      await handleAskNow(row({ query: `第 ${i} 句` }), { synthetic: true })
    }
    const log = getTakeoverLog()
    expect(log.length).toBeLessThanOrEqual(20)
    expect(log[0].query).toBe('第 24 句')
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
    // 两条都是"真话 + 正常处置"：照样回填、照样不进账
    expect(second.mock.calls[0][0]).toMatchObject({ verdict: 'control', query: '暂停播放' })
    expect(getTakeoverLog()).toHaveLength(0)
  })
})

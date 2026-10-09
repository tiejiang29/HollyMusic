/**
 * 投放会话（G2）测试：钉的是"看门狗什么时候动手"这类时序判断。
 *
 * 三条实测事实是这些用例的根据（2026-10-08 真机）：
 * 1. 设备会把一窗按顺序自己播完 ⇒ 窗内不需要我们推；
 * 2. 一批放完它**从头循环**，不会停 ⇒ 尾巴必须由我们收（补下一窗或 stop）；
 * 3. **重推会让那一项从 0 起播** ⇒ 补推只能卡边界，中途改队列要等边界生效。
 *
 * 所以这里最值钱的不是"推了几次"，而是这几条：
 * 尾巴是**按剩余秒数定点睡到边界**的（不是拿快轮询去撞那个窗口）/ 位置大段回跳就立即收口，
 * 但**起播那阵子（30 秒以内）的归零不算**（设备拉不到字节会自己重拉）、单曲循环也不算 /
 * 暂停期间进度不许按墙钟跑 / 补推失败不许把歌从时间线上抹掉 /
 * seek 必须带着剩余项一起重排（否则连播丢了）/ 设备回显的 audio_id 就是游标。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  config: {
    enabled: true,
    credentials: {},
    devices: [] as Array<Record<string, unknown>>,
    lastSyncAt: null,
    lastError: null,
    serverHost: '172.16.1.253:3000',
    playQuality: '320k',
    musicApiDisabledModels: [] as string[],
  },
  readSpeakerConfig: vi.fn(),
  ensureFreshCredentials: vi.fn(async () => ({ serviceToken: 'ST', userId: '1', deviceId: 'D1' })),
  playItems: vi.fn(async () => ({ accepted: true, batched: true })),
  playerOperation: vi.fn(async () => true),
  getPlayStatus: vi.fn(),
  createShareAudioToken: vi.fn((uid: string) => `TOK.${uid}`),
  resolveMusicInfoById: vi.fn(),
  status: { status: 1, position: 0, duration: 60_000, volume: 40, title: '', audioId: '' },
}))

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/db', () => ({ resolveMusicInfoById: h.resolveMusicInfoById }))
vi.mock('@/lib/services/auth', () => ({ createShareAudioToken: h.createShareAudioToken }))
vi.mock('@/lib/services/xiaomi/token-store', () => ({
  readSpeakerConfig: h.readSpeakerConfig,
  ensureFreshCredentials: h.ensureFreshCredentials,
}))
vi.mock('@/lib/services/xiaomi/mina-client', () => ({
  playItems: h.playItems,
  playerOperation: h.playerOperation,
  getPlayStatus: h.getPlayStatus,
  PLAY_STATUS_PLAYING: 1,
}))

const cast = await import('@/lib/services/xiaomi/cast-session')
const { SpeakerError } = await import('@/lib/services/xiaomi/speaker-play')

const DEVICE = { deviceID: 'D1', name: '小爱音箱Play', hardware: 'L05B', model: 'L05B', miotDID: 'm', presence: 'online', managed: true }

const track = (uid: string, durSec = 60) => ({ uid, durSec })
const rest = (n: number, prefix = 'r') => Array.from({ length: n }, (_, i) => track(`${prefix}-${i}`, 60))

/** 第 i 次推给设备的那一窗（默认最近一次） */
function pushed(i = h.playItems.mock.calls.length - 1) {
  return h.playItems.mock.calls[i][2] as Array<{ url: string; audioId: string }>
}
function uids(i?: number) {
  return pushed(i).map(x => new URL(x.url).searchParams.get('uid') as string)
}
function seekOf(url: string): string | null {
  return new URL(url).searchParams.get('seek')
}
/** 让设备"处在窗里第 k 格、且这一项还剩 remSec 秒" */
function deviceAt(audioId: string, playedSec: number, extra: Partial<typeof h.status> = {}) {
  h.status = { ...h.status, status: 1, audioId, position: Math.round(playedSec * 1000), duration: 60_000, ...extra }
}

beforeEach(() => {
  vi.useFakeTimers()
  for (const f of [h.playItems, h.playerOperation, h.getPlayStatus, h.createShareAudioToken]) f.mockClear()
  h.playItems.mockImplementation(async () => ({ accepted: true, batched: true }))
  h.playerOperation.mockImplementation(async () => true)
  h.config.enabled = true
  h.config.devices = [DEVICE]
  h.config.serverHost = '172.16.1.253:3000'
  h.config.playQuality = '320k'
  h.readSpeakerConfig.mockImplementation(async () => ({ ...h.config }))
  h.status = { status: 1, position: 0, duration: 60_000, volume: 40, title: '', audioId: '' }
  h.getPlayStatus.mockImplementation(async () => ({ ...h.status }))
  cast._resetCastSessionsForTest()
})

afterEach(() => {
  cast._resetCastSessionsForTest()
  vi.useRealTimers()
})

describe('起投：一窗推「当前 + 后面 9 首」', () => {
  it('窗大小 10、audio_id 互不相同（那是游标），st 仍在地址第一位', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(25) })
    expect(h.playItems).toHaveBeenCalledTimes(1)
    const items = pushed(0)
    expect(items).toHaveLength(10)
    expect(new Set(items.map(x => x.audioId)).size).toBe(10)
    expect(uids(0)[0]).toBe('cur')
    expect(uids(0)[1]).toBe('r-0')
    for (const it of items) {
      expect(it.url.indexOf('?st=')).toBeGreaterThan(-1)
      expect(seekOf(it.url)).toBeNull()
    }
  })

  it('带 seekSec 起投时只有第一项带偏移（后面的整首从头播）', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(3), seekSec: 42 })
    expect(seekOf(pushed(0)[0].url)).toBe('42')
    expect(seekOf(pushed(0)[1].url)).toBeNull()
  })

  it('总开关关着 / 没给当前曲 ⇒ 一条指令都不发', async () => {
    h.config.enabled = false
    await expect(cast.startCast({ current: track('cur'), rest: [] })).rejects.toThrow(/总开关/)
    h.config.enabled = true
    await expect(cast.startCast({ current: track(''), rest: [] })).rejects.toThrow(/哪首歌/)
    expect(h.playItems).not.toHaveBeenCalled()
  })

  it('设备没受理这窗 ⇒ 报 SpeakerError，别留下一个"以为在投"的会话', async () => {
    h.playItems.mockResolvedValue({ accepted: false, batched: false })
    await expect(cast.startCast({ current: track('cur'), rest: rest(3) })).rejects.toBeInstanceOf(SpeakerError)
    expect(await cast.castView()).toBeNull()
  })

  it('换投另一台：先把上一台的会话停掉（一次只许一个投放，免得歌在两个房间同时响）', async () => {
    const other = { ...DEVICE, deviceID: 'D2', name: '小爱红外版' }
    h.config.devices = [DEVICE, other]
    await cast.startCast({ current: track('cur'), rest: rest(2), deviceID: 'D1' })
    await cast.startCast({ current: track('cur2'), rest: rest(2), deviceID: 'D2' })
    expect(h.playerOperation).toHaveBeenCalledWith(expect.anything(), 'D1', 'stop')
    expect(h.playItems).toHaveBeenCalledTimes(2)
  })
})

describe('看门狗：只在边界动手', () => {
  it('窗里最后一项剩 0.4 秒才补下一窗（早了会把正在播的这首从头放）', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(15) })
    // 先确认"还剩 5 秒"时不动手
    deviceAt(pushed(0)[9].audioId, 55)
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.playItems).toHaveBeenCalledTimes(1)
    // 剩 0.4 秒：动手
    deviceAt(pushed(0)[9].audioId, 59.6)
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.playItems).toHaveBeenCalledTimes(2)
    expect(uids(1)).toEqual(['r-9', 'r-10', 'r-11', 'r-12', 'r-13', 'r-14'])
  })

  it('设备回显的 audio_id 就是游标：认到第几格，view 就报第几首', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(15) })
    deviceAt(pushed(0)[3].audioId, 20)
    await vi.advanceTimersByTimeAsync(5000)
    const v = await cast.castView()
    expect(v?.uid).toBe('r-2')
    expect(v?.posSec).toBeCloseTo(20, 0)
    expect(v?.playing).toBe(true)
  })

  it('认不出的 audio_id 不硬猜：游标维持上一拍的判断', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(15) })
    deviceAt(pushed(0)[4].audioId, 10)
    await vi.advanceTimersByTimeAsync(5000)
    expect((await cast.castView())?.uid).toBe('r-3')
    deviceAt('9999999999999', 30)
    await vi.advanceTimersByTimeAsync(5000)
    expect((await cast.castView())?.uid).toBe('r-3')
  })

it('刚推完还没读到状态时按"在播"报，免得客户端把乐观态按回去（假暂停）', async () => {
    // 让起播确认与看门狗都还没跑：只投，不推进时间
    h.getPlayStatus.mockClear()
    await cast.startCast({ current: track('cur'), rest: rest(3) })
    const v = await cast.castView()
    expect(v?.playing).toBe(true)
    expect(v?.status).toBe(1)
    // 宽限期一过还是读不到，就如实说"读不到"，不装成在播
    h.getPlayStatus.mockRejectedValue(new Error('网络不通'))
    await vi.advanceTimersByTimeAsync(20_000)
    const v2 = await cast.castView()
    expect(v2 === null || v2.playing === false || v2.status === -1).toBe(true)
  })

  it('整条队列放完：收口 stop 并清会话（不许留给设备去从头循环）', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(9) })
    // 第一窗就是 cur + r0..r8（共 9 首，rest 用尽），到边界就没有下一窗了
    deviceAt(pushed(0)[9].audioId, 59.7)
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.playerOperation).toHaveBeenCalledWith(expect.anything(), 'D1', 'stop')
    expect(await cast.castView()).toBeNull()
  })

  it('暂停期间进度不许按墙钟跑（不然进度条会跑到声音前面）', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(15) })
    deviceAt(pushed(0)[0].audioId, 30, { status: 2 })
    await vi.advanceTimersByTimeAsync(5000)
    expect((await cast.castView())?.posSec).toBeCloseTo(30, 0)
    await vi.advanceTimersByTimeAsync(5000)
    expect((await cast.castView())?.posSec).toBeCloseTo(30, 0)
    expect(h.playItems).toHaveBeenCalledTimes(1)
  })

  it('刚推完读到"停了"不算停（设备起播有延迟）；过了宽限期才补推', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(15) })
    deviceAt(pushed(0)[0].audioId, 0, { status: 0 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.playItems).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(9000)
    expect(h.playItems.mock.calls.length).toBeGreaterThan(1)
  })

  it('补推被设备拒了不许把歌从时间线上抹掉（cursor 不动，下一拍重试）', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(15) })
    h.playItems.mockResolvedValue({ accepted: false, batched: false })
    deviceAt(pushed(0)[9].audioId, 59.8)
    await vi.advanceTimersByTimeAsync(5000)
    const v = await cast.castView()
    expect(v?.pendingTracks).toBe(15 - 9)   // r9..r14 还都算"没推出去"
    expect(v?.lastError).toMatch(/没认这条推歌/)
  })

  it('连续三次推不上就收手，不再拿同一台去撞小米', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(15) })
    h.playItems.mockResolvedValue({ accepted: false, batched: false })
    deviceAt(pushed(0)[9].audioId, 59.8)
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(5000)
    expect(await cast.castView()).toBeNull()
    // 会话清了之后不会再有轮询打进来
    const calls = h.getPlayStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.getPlayStatus.mock.calls.length).toBe(calls)
  })

  it('看门狗读到票失效只试一拍就不自己爬起来狂打小米，并把原因留在会话上', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(15) })
    h.getPlayStatus.mockRejectedValue(new Error('小爱的票已失效（player_get_play_status，code=70016），需要重新登录'))
    await vi.advanceTimersByTimeAsync(5000)
    // 1.2 秒的起播确认与 5 秒的看门狗各读一次，两次都撞票失效 —— 之后就都不自己重排了
    const stopped = h.getPlayStatus.mock.calls.length
    expect(stopped).toBe(2)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.getPlayStatus.mock.calls.length).toBe(stopped)
    // 客户端还在问的时候才给它续上（不是定时器自己叠加）
    const v = await cast.castView()
    expect(v?.lastError).toMatch(/票已失效/)
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.getPlayStatus.mock.calls.length).toBe(stopped + 1)
  })
})

describe('拖动进度条：带偏移重推，且剩余项一起排', () => {
  it('seek 之后窗没被砍短（只重推当前项就等于把连播丢了）', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(15) })
    await cast.seekCast(120)
    const items = pushed(1)
    expect(uids(1)[0]).toBe('cur')
    expect(items).toHaveLength(10)
    expect(seekOf(items[0].url)).toBe('120')
    for (const it of items.slice(1)) expect(seekOf(it.url)).toBeNull()
    const v = await cast.castView()
    expect(v?.posSec).toBeCloseTo(120, 0)
    expect(v?.durSec).toBe(60)
  })

  it('seek 之后接着窗里后面的歌：从第 4 格跳，后面还是 r-4 起排', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(15) })
    deviceAt(pushed(0)[3].audioId, 10)
    await vi.advanceTimersByTimeAsync(5000)
    await cast.seekCast(200)
    expect(uids(1)).toEqual(['r-2', 'r-3', 'r-4', 'r-5', 'r-6', 'r-7', 'r-8', 'r-9', 'r-10', 'r-11'])
  })

  it('seek 不算"播过"：跳完再按上一首，回的还是真正播过的那首', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(15) })
    deviceAt(pushed(0)[2].audioId, 10)
    await vi.advanceTimersByTimeAsync(5000)
    await cast.seekCast(300)
    expect((await cast.castView())?.uid).toBe('r-1')
    await cast.skipCast(-1)
    // 自动播过 cur、r-0 才到 r-1，所以"上一首"是 r-0（seek 本身不该被记成播过）
    expect(uids(2)[0]).toBe('r-0')
  })
})

describe('切歌与投放期间改队列', () => {
  it('下一首：窗里还有就立刻起它，并把播过的记进历史', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(15) })
    deviceAt(pushed(0)[3].audioId, 20)
    await vi.advanceTimersByTimeAsync(5000)
    await cast.skipCast(1)
    expect(uids(1)[0]).toBe('r-3')
    await cast.skipCast(-1)
    expect(uids(2)[0]).toBe('r-2')
  })

  it('窗里见底时下一首走 rest；rest 也见底就当场收口（停音箱 + 如实说放完了）', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(12) })
    deviceAt(pushed(0)[1].audioId, 20)
    await vi.advanceTimersByTimeAsync(5000)
    await cast.skipCast(1)
    expect(uids(1)[0]).toBe('r-1')   // 窗里的下一首
    await cast.stopCast()

    await cast.startCast({ current: track('cur'), rest: rest(1) })
    deviceAt(pushed(2)[1].audioId, 20)
    await vi.advanceTimersByTimeAsync(5000)
    await expect(cast.skipCast(1)).rejects.toThrow(/放完/)
    expect(h.playerOperation).toHaveBeenLastCalledWith(expect.anything(), 'D1', 'stop')
    expect(await cast.castView()).toBeNull()
    await expect(cast.skipCast(1)).rejects.toThrow(/没有投放会话/)
  })

  it('第一首都还没播过时按上一首 = 回到当前这首的开头（各家播放器一致做法）', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(5) })
    deviceAt(pushed(0)[0].audioId, 40)
    await vi.advanceTimersByTimeAsync(5000)
    await cast.skipCast(-1)
    expect(uids(1)[0]).toBe('cur')
    expect(seekOf(pushed(1)[0].url)).toBeNull()
    expect((await cast.castView())?.posSec).toBeCloseTo(0, 0)
  })

  it('投放中改队列不当场重推（重推会把正在播的这首从头放），等当前这首放完才生效', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(15) })
    cast.updateCastRest(rest(4, 'n'))
    expect(h.playItems).toHaveBeenCalledTimes(1)
    deviceAt(pushed(0)[0].audioId, 30)
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.playItems).toHaveBeenCalledTimes(1)   // 还剩 30 秒，不动手
    deviceAt(pushed(0)[0].audioId, 59.8)
    await vi.advanceTimersByTimeAsync(5000)
    expect(uids(1)).toEqual(['n-0', 'n-1', 'n-2', 'n-3'])
  })

  it('变更生效时，旧窗里没播到的那些由新队列取代（前端传来的顺序就是"接下来该播什么"的权威）', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(15) })
    cast.updateCastRest(rest(15, 'n'))
    deviceAt(pushed(0)[0].audioId, 59.9)
    await vi.advanceTimersByTimeAsync(5000)
    expect(uids(1)[0]).toBe('n-0')
    expect(uids(1)).not.toContain('r-0')
    expect((await cast.castView())?.pendingTracks).toBe(15 - 10)
  })

  it('没有会话时任何操作都直说，不去猜该播什么', async () => {
    await expect(cast.skipCast(1)).rejects.toThrow(/没有投放会话/)
    await expect(cast.seekCast(10)).rejects.toThrow(/没有投放会话/)
    expect(() => cast.updateCastRest([{ uid: 'x', durSec: 1 }])).toThrow(/没有投放会话/)
    await cast.stopCast()
  })
})

describe('退出投放', () => {
  it('stop 会把设备停掉并清会话，之后轮询不再打小米', async () => {
    await cast.startCast({ current: track('cur'), rest: rest(15) })
    await cast.stopCast()
    expect(h.playerOperation).toHaveBeenCalledWith(expect.anything(), 'D1', 'stop')
    expect(await cast.castView()).toBeNull()
    const calls = h.getPlayStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.getPlayStatus.mock.calls.length).toBe(calls)
  })
})

describe('尾巴排程：睡到边界上，不是拿快轮询去撞', () => {
  it('一首 300 秒的歌：到点就停，不靠运气撞那 0.5 秒的窗口', async () => {
    let startMs = 0
    let stoppedAt = 0
    h.playerOperation.mockImplementation(async () => { stoppedAt = Date.now(); return true })
    h.getPlayStatus.mockImplementation(async () => {
      if (!startMs) startMs = Date.now()
      // 设备按墙钟走位，并且**放完自己从头循环**（位置取模回绕）—— 真机就是这两个行为
      return { ...h.status, status: 1, audioId: pushed(0)[0].audioId, position: (Date.now() - startMs) % 300_000, duration: 300_000 }
    })
    await cast.startCast({ current: track('整曲', 300), rest: [] })
    await vi.advanceTimersByTimeAsync(310_000)
    // 必须在它转回头之前停下：定点睡到边界前 0.3 秒 ⇒ 这一条把"排程方式"也钉住了
    // （换成 5 秒一次的轮询就必然撞不中，只能等位置回跳那条兜底 —— 那时候已经多响了一截）
    expect(stoppedAt).toBeGreaterThan(0)
    expect(stoppedAt - startMs).toBeLessThanOrEqual(300_500)
    expect(await cast.castView()).toBeNull()
  })

  it('睡过了边界（读到位置掉回开头）：立刻收口，不陪它再响一圈', async () => {
    await cast.startCast({ current: track('整曲', 300), rest: [] })
    deviceAt(pushed(0)[0].audioId, 293)   // 还剩 7 秒 ⇒ 看门狗这一拍定点睡到边界前
    await vi.advanceTimersByTimeAsync(6000)
    deviceAt(pushed(0)[0].audioId, 3)     // 事件循环卡了一下，醒来时它已经从头循环
    await vi.advanceTimersByTimeAsync(6000)
    expect(h.playerOperation).toHaveBeenCalledWith(expect.anything(), 'D1', 'stop')
    expect(await cast.castView()).toBeNull()
  })

  it('起播那阵子的位置归零不算"从头循环"：设备拉不到字节会自己重拉，那种时候该等它继续', async () => {
    await cast.startCast({ current: track('整曲', 300), rest: [] })
    deviceAt(pushed(0)[0].audioId, 5)     // 只读到第 5 秒（还没过 30 秒那道闸）
    await vi.advanceTimersByTimeAsync(5000)
    deviceAt(pushed(0)[0].audioId, 1)     // 5.1 秒挂断后自己重拉，位置回到开头
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.playerOperation).not.toHaveBeenCalledWith(expect.anything(), 'D1', 'stop')
    expect(await cast.castView()).not.toBeNull()
  })

  it('元数据时长撒谎（比真实文件长）时也靠位置回跳收口：定点根本不会发生', async () => {
    // 现成例子 kw:440613 实际=224s 期望=304s —— 按 304 秒算剩余永远等不到边界，只能认"它放完转回了开头"
    await cast.startCast({ current: track('整曲', 300), rest: [] })
    deviceAt(pushed(0)[0].audioId, 220)
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.playerOperation).not.toHaveBeenCalledWith(expect.anything(), 'D1', 'stop')
    deviceAt(pushed(0)[0].audioId, 4)     // 真实长度 224 秒，它已经转回开头
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.playerOperation).toHaveBeenCalledWith(expect.anything(), 'D1', 'stop')
    expect(await cast.castView()).toBeNull()
  })

  it('单曲循环里读到位置回跳也不许停：那种"从头再来"正是要的效果', async () => {
    await cast.startCast({ current: track('整曲', 300), rest: [], loopOne: true })
    deviceAt(pushed(0)[0].audioId, 293)
    await vi.advanceTimersByTimeAsync(6000)
    deviceAt(pushed(0)[0].audioId, 3)
    await vi.advanceTimersByTimeAsync(6000)
    expect(h.playerOperation).not.toHaveBeenCalledWith(expect.anything(), 'D1', 'stop')
    expect(await cast.castView()).not.toBeNull()
  })
})

describe('单曲循环：只推一首并让设备自己转', () => {
  it('窗尾不动手、也不 stop（它"从头再来"正是要的效果）', async () => {
    await cast.startCast({ current: track('cur', 8), rest: [], loopOne: true })
    expect(uids(0)).toEqual(['cur'])
    deviceAt(pushed(0)[0].audioId, 7.9)
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(5000)
    expect(h.playItems).toHaveBeenCalledTimes(1)
    expect(h.playerOperation).not.toHaveBeenCalledWith(expect.anything(), 'D1', 'stop')
    expect(await cast.castView()).not.toBeNull()
  })

  it('单曲循环中改了队列仍然会生效（改完就从新队列接着走，不再循环这首）', async () => {
    await cast.startCast({ current: track('cur', 60), rest: [], loopOne: true })
    cast.updateCastRest(rest(3, 'n'))
    deviceAt(pushed(0)[0].audioId, 59.8)
    await vi.advanceTimersByTimeAsync(5000)
    expect(uids(1)).toEqual(['n-0', 'n-1', 'n-2'])
    // 新队列放完就该收口，不能又回头循环
    deviceAt(pushed(1)[2].audioId, 59.9)
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.playerOperation).toHaveBeenLastCalledWith(expect.anything(), 'D1', 'stop')
    expect(await cast.castView()).toBeNull()
  })
})

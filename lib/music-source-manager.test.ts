/**
 * 取址瀑布预算（第 0 刀）回归测试
 *
 * 钉住实测出来的那个致命缺陷：旧预算是"单次 15s / 总 45s"，而外层 audio-serve 的解析
 * 超时只有 20s（lib/audio-serve.ts:199，AUDIO_CACHE_READINESS_TIMEOUT_MS）。结果是
 * priority 1 的源一挂起，它能在多个音质档上各烧满 15s 把整条瀑布吃满，外层 20s 先到 →
 * 客户端拿到 502，后面的可用源一次都没轮到（HANDOFF 2026-09-19 摸底：2/2 全失败、20030ms）。
 *
 * 现在多了"单源累计预算"这一级：一个源在这首歌上花完 perSourceMs 就被放弃，瀑布一定
 * 在外层炸掉之前给出结论。这里用注入的假实例（不碰配置文件与 runner 子进程）验四件事。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
// 跨平台换源会打 DB 与搜索，这里全部屏蔽：本测试只关心同平台瀑布的预算行为
vi.mock('./services/source-toggle', () => ({
  findBestAlternative: vi.fn(async () => null),
}))
vi.mock('./logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { MusicSourceManager, readUrlBudgets, readSpeakerUrlBudgets, SourceTimeoutError } = await import('./music-source-manager')
const { sourceHealth } = await import('./server/source-health')
const { logger } = await import('./logger')
import type { SimulatorInstance } from './music-source-manager'

beforeEach(() => {
  sourceHealth.reset()
})

const QUALITIES = ['128k', '320k', 'flac', 'flac24bit']

/** 造一个已初始化的假音源：只有 getMusicUrl 行为可定制 */
function fakeSource(
  name: string,
  getMusicUrl: (attempt: number) => Promise<string>,
  platform = 'kw'
): SimulatorInstance {
  let calls = 0
  const instance: SimulatorInstance = {
    simulator: {
      loadScript: async () => ({}),
      getMusicUrl: async () => getMusicUrl(++calls),
      getLyric: async () => null,
      getPic: async () => null,
    },
    config: { name, priority: 1, enabled: true },
    initialized: true,
    sourceInfo: {
      name,
      version: '1.0.0',
      sources: {
        [platform]: { name: platform, type: 'music', actions: ['musicUrl'], qualitys: [...QUALITIES] },
      },
    },
  }
  return instance
}

const musicInfo = {
  source: 'kw',
  songmid: 'sm-1',
  name: '测试歌',
  singer: '测试歌手',
  interval: '03:00',
  types: QUALITIES.map(t => ({ type: t, size: '10MB' })),
  _types: Object.fromEntries(QUALITIES.map(t => [t, { size: '10MB' }])),
  typeUrl: {},
} as never

function managerWith(instances: SimulatorInstance[], budgets: object) {
  const m = new MusicSourceManager()
  m._setBudgetsForTest(budgets)
  m._setInstancesForTest(instances)
  return m
}

describe('取址瀑布的单源累计预算', () => {
  it('头源挂起 → 只对它调用一次就放弃，第二个源照常出货（旧行为是整首歌失败）', async () => {
    let hangCalls = 0
    const m = managerWith(
      [
        fakeSource('挂起的头源', () => {
          hangCalls++
          return new Promise<string>(() => {}) // 永不 resolve，模拟脚本卡死
        }),
        fakeSource('后面的好源', async () => 'https://ok.example/good.flac'),
      ],
      { urlMs: 1000, perSourceMs: 300, totalMs: 5000 }
    )

    const t = Date.now()
    const { url, provider } = await m.getMusicUrlWithProvider(musicInfo, 'flac')

    expect(url).toBe('https://ok.example/good.flac')
    expect(provider).toBe('后面的好源')
    // 关键断言：卡死的源被夹在单源预算内，只占用一次调用（第一档超时后就换源）
    expect(hangCalls).toBe(1)
    // 远小于外层 20s：瀑布自己先出结论
    expect(Date.now() - t).toBeLessThan(1500)

    // 埋点确实落账了，且坏/好各自归位
    const bad = sourceHealth.view('挂起的头源', 'kw')
    expect(bad?.bad).toBe(1)
    expect(bad?.badKinds).toEqual({ timeout: 1 })
    // 单次调用确实被夹到剩余预算附近（允许超时回调与计时器粒度的少量超出，
    // 关键是它没有按 urlMs=1000 等满，更没有把整条瀑布的预算吃光）
    expect(bad?.latencyP50Ms).toBeLessThan(500)
    const good = sourceHealth.view('后面的好源', 'kw')
    expect(good?.resolveOk).toBe(1)
    expect(good?.bad).toBe(0)
  })

  it('超时按身份认，不按耗时反推（CI #57 挂的就是这条口径：耗时比预算小 1ms 就记成 error）', async () => {
    // callTimeoutMs 是在 attemptAt 之前算的，中间还夹着两道 continue 检查，
    // 所以"定时器触发时的已耗时"天然比预算小 0~N 毫秒。旧判据拿 tookMs >= callTimeoutMs
    // 反推超时：本地 δ=0 恰好相等、机器一慢 δ=1ms 就把真超时记成脚本内部报错。
    const m = managerWith(
      [
        fakeSource('抛超时错的源', () => Promise.reject(new SourceTimeoutError('获取音乐URL超时（3s）'))),
        fakeSource('备用好源', async () => 'https://ok.example/backstop.flac'),
      ],
      // 预算给满 3s，而这个假源几乎立刻抛错 ⇒ tookMs 远小于 callTimeoutMs，
      // 正是 CI 上翻车的那个形态；按身份判才站得住
      { urlMs: 3000, perSourceMs: 3000, totalMs: 20_000 }
    )

    const { url, provider } = await m.getMusicUrlWithProvider(musicInfo, 'flac')
    expect(url).toBe('https://ok.example/backstop.flac')
    expect(provider).toBe('备用好源')

    const bad = sourceHealth.view('抛超时错的源', 'kw')
    expect(bad?.bad).toBe(1)
    expect(bad?.badKinds).toEqual({ timeout: 1 })
  })

  it('脚本自己抛的非超时错误仍然记 error（身份判据不能退化成"一律算超时"）', async () => {
    const m = managerWith(
      [
        fakeSource('真报错的源', () => Promise.reject(new TypeError('cannot read property of undefined'))),
        fakeSource('备用好源', async () => 'https://ok.example/after-error.flac'),
      ],
      { urlMs: 3000, perSourceMs: 3000, totalMs: 20_000 }
    )

    await expect(m.getMusicUrlWithProvider(musicInfo, 'flac')).resolves.toMatchObject({
      provider: '备用好源',
    })
    expect(sourceHealth.view('真报错的源', 'kw')?.badKinds).toEqual({ error: 1 })
  })

  it('能力/平台不符而跳过尝试的源，一条样本都不记（否则版权面窄的好源会被误判成坏源）', async () => {
    const m = managerWith(
      [
        {
          ...fakeSource('不支持本平台的好源', async () => 'https://x/a.flac', 'tx'),
        },
        fakeSource('出货源', async () => 'https://ok/b.flac'),
      ],
      { urlMs: 1000, perSourceMs: 800, totalMs: 5000 }
    )

    await m.getMusicUrlWithProvider(musicInfo, 'flac')

    // 第一个源连 kw 平台都没声明，被 continue 掉：不应出现在账本里
    expect(sourceHealth.view('不支持本平台的好源', 'kw')).toBeNull()
    expect(sourceHealth.view('出货源', 'kw')?.resolveOk).toBe(1)
  })

  it('普通失败（返回空/抛错）不受单源预算影响，同一源仍会继续试下一档音质', async () => {
    let calls = 0
    const m = managerWith(
      [
        fakeSource('偶尔抽风的源', async (n) => {
          calls++
          if (n < 3) throw new Error('脚本内部报错')
          return 'https://ok.example/third.flac'
        }),
      ],
      { urlMs: 1000, perSourceMs: 2000, totalMs: 5000 }
    )

    const { provider } = await m.getMusicUrlWithProvider(musicInfo, 'flac')

    expect(provider).toBe('偶尔抽风的源')
    expect(calls).toBe(3) // 前两次失败后，同一源的第三档仍被允许尝试
  })

  it('所有源都挂起 → 抛错但耗时受总预算约束，且每个源都被轮到过一次', async () => {
    let a = 0, b = 0, c = 0
    const counters = [() => a++, () => b++, () => c++]
    const instances = counters.map((fn, i) =>
      fakeSource(`坏源${i}`, () => { fn(); return new Promise<string>(() => {}) })
    )
    const m = managerWith(instances, { urlMs: 1000, perSourceMs: 250, totalMs: 1200 })

    const t = Date.now()
    await expect(m.getMusicUrlWithProvider(musicInfo, 'flac')).rejects.toThrow(/所有音源均失败/)

    expect([a, b, c].every(n => n >= 1)).toBe(true) // 没有源被预算饿死
    expect(Date.now() - t).toBeLessThan(1200 + 400) // 总预算兜得住，不等外层 20s
  })

  it('三级预算必须自洽：单源 < 总预算 < 外层解析超时（否则外层先炸，后面的源永远轮不到）', () => {
    const b = readUrlBudgets()
    expect(b.perSourceMs).toBeLessThan(b.totalMs)
    // audio-serve.ts:199 的 AUDIO_CACHE_READINESS_TIMEOUT_MS 默认 20s
    expect(b.totalMs).toBeLessThan(20_000)
  })
})

/**
 * 3c：瀑布开始消费健康账本。参数依据见 source-health.test.ts 顶部的摸底实测说明。
 * 要点是"排序不动、临时跳过、同平台保底留一个"，不是自动改 priority。
 */
/**
 * 「这首歌真没有」不能当成「这个源坏了」。真实播放路径同样会踩：冷门歌让脚本抛
 * `播放地址解析失败` 之类的错，若记坏，用户连点两首就能把一个只是没版权的好源冷却掉。
 */
describe('无版权类抛错不计坏', () => {
  it('脚本抛「播放地址解析失败」→ 只累计 noMatch，不产生坏样本、不进冷却', async () => {
    const m = managerWith(
      [
        fakeSource('没这首歌的源', async () => { throw new Error('播放地址解析失败') }),
        fakeSource('出货源', async () => 'https://ok/hit.flac'),
      ],
      { urlMs: 1000, perSourceMs: 800, totalMs: 5000 }
    )
    const r = await m.getMusicUrlWithProvider(musicInfo, 'flac')

    expect(r.provider).toBe('出货源')
    const v = sourceHealth.view('没这首歌的源', 'kw')
    expect(v?.bad).toBe(0)
    expect(v?.noMatch).toBeGreaterThan(0)
    expect(sourceHealth.coolStatus('没这首歌的源', 'kw').skip).toBe(false)
  })

  it('两次「服务端返回非 JSON 数据」仍要能把源冷却（真不可用不能被判成没版权）', async () => {
    const instances = [
      fakeSource('抽风的源', async () => { throw new Error('服务端返回非 JSON 数据') }),
      fakeSource('出货源', async () => 'https://ok/hit.flac'),
    ]
    const m = managerWith(instances, { urlMs: 1000, perSourceMs: 800, totalMs: 5000 })

    await m.getMusicUrlWithProvider(musicInfo, 'flac')
    await m.getMusicUrlWithProvider({ ...musicInfo, songmid: 'sm-2' } as never, 'flac')

    expect(sourceHealth.view('抽风的源', 'kw')?.bad).toBe(2)
    expect(sourceHealth.coolStatus('抽风的源', 'kw').skip).toBe(true)
  })
})

describe('3c：按账本跳过冷却中的源', () => {
  /** 连记两次坏，把一个 `源×平台` 推进冷却（快速失败档 = 60s） */
  function tripCooldown(name: string, platform = 'kw') {
    sourceHealth.recordResolve(name, platform, 'error', 20, '脚本内部报错')
    sourceHealth.recordResolve(name, platform, 'error', 20, '脚本内部报错')
    expect(sourceHealth.coolStatus(name, platform).skip).toBe(true)
  }

  it('头源冷却中 → 一次都不调用，第二个源直接上场（旧行为是每首歌都白等一轮预算）', async () => {
    tripCooldown('冷却中的头源')
    let hangCalls = 0
    const m = managerWith(
      [
        fakeSource('冷却中的头源', () => {
          hangCalls++
          return new Promise<string>(() => {})
        }),
        fakeSource('后面的好源', async () => 'https://ok/recovered.flac'),
      ],
      { urlMs: 1000, perSourceMs: 300, totalMs: 5000 }
    )

    const r = await m.getMusicUrlWithProvider(musicInfo, 'flac')
    expect(hangCalls).toBe(0)
    expect(r.provider).toBe('后面的好源')
  })

  it('跳过的源不参与本轮记账：冷却期间的坏样本不该把翻倍次数继续往上叠', async () => {
    tripCooldown('冷却中的头源')
    const before = sourceHealth.view('冷却中的头源', 'kw')!
    const m = managerWith(
      [
        fakeSource('冷却中的头源', () => new Promise<string>(() => {})),
        fakeSource('出货源', async () => 'https://ok/x.flac'),
      ],
      { urlMs: 1000, perSourceMs: 300, totalMs: 5000 }
    )
    await m.getMusicUrlWithProvider(musicInfo, 'flac')
    const after = sourceHealth.view('冷却中的头源', 'kw')!
    expect(after.samples).toBe(before.samples)
    expect(after.consecutiveBad).toBe(before.consecutiveBad)
  })

  it('该平台只剩一个候选源时，即使冷却中也要上场（mg 只有两个源，全跳等于无源可用）', async () => {
    tripCooldown('唯一的冷却源')
    let calls = 0
    const m = managerWith(
      [fakeSource('唯一的冷却源', async () => { calls++; return 'https://ok/only.flac' })],
      { urlMs: 1000, perSourceMs: 800, totalMs: 5000 }
    )

    const r = await m.getMusicUrlWithProvider(musicInfo, 'flac')
    expect(calls).toBe(1)
    expect(r.url).toBe('https://ok/only.flac')
    // 保底上场且成功 → 冷却立即解除，不会把唯一源永久锁死
    expect(sourceHealth.coolStatus('唯一的冷却源', 'kw').skip).toBe(false)
  })

  it('保底只保一个：前两个源冷却时第三个仍上场，第四个不被无谓消耗', async () => {
    tripCooldown('坏源0')
    tripCooldown('坏源1')
    let n2 = 0, n3 = 0
    const m = managerWith(
      [
        fakeSource('坏源0', () => new Promise<string>(() => {})),
        fakeSource('坏源1', () => new Promise<string>(() => {})),
        fakeSource('第三个源', async () => { n2++; return 'https://ok/third.flac' }),
        fakeSource('第四个源', async () => { n3++; return 'https://ok/fourth.flac' }),
      ],
      { urlMs: 1000, perSourceMs: 300, totalMs: 5000 }
    )
    const r = await m.getMusicUrlWithProvider(musicInfo, 'flac')
    expect(n2).toBe(1)
    expect(n3).toBe(0) // 前面的源出货后瀑布照常短路，跳过不会让顺序倒退
    expect(r.provider).toBe('第三个源')
  })

  it('冷却到期后放一次半开：成功即恢复，之后的请求照常优先用它', async () => {
    vi.useFakeTimers({ now: Date.now() })
    try {
      tripCooldown('待复活源')
      vi.advanceTimersByTime(60_001)
      let calls = 0
      const m = managerWith(
        [fakeSource('待复活源', async () => { calls++; return 'https://ok/reborn.flac' })],
        { urlMs: 1000, perSourceMs: 800, totalMs: 5000 }
      )
      const r = await m.getMusicUrlWithProvider(musicInfo, 'flac')
      expect(calls).toBe(1)
      expect(r.url).toBe('https://ok/reborn.flac')
      expect(sourceHealth.view('待复活源', 'kw')?.coolingUntil).toBe(0)
      expect(sourceHealth.view('待复活源', 'kw')?.backoffs).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('周测取址不受 pt 拦（pt 只管派活，不能拿来筛题目）', () => {
  /** 脚本声明了酷我和腾讯，但管理员在 pt 里只放了酷我 */
  function txExcluded() {
    const instance = fakeSource('摘了腾讯的源', async () => 'https://up.example/tx.flac', 'kw')
    instance.config.pt = ['kw']
    instance.sourceInfo!.sources.tx = { name: 'tx', type: 'music', actions: ['musicUrl'], qualitys: [...QUALITIES] }
    return instance
  }
  const manager = () => managerWith([txExcluded()], { urlMs: 5000, perSourceMs: 5000, totalMs: 5000 })
  const tx = { ...musicInfo, source: 'tx' } as never

  it('probeSourceUrl 照样调脚本：被摘掉的平台也要有新数据，才知道该不该放回来', async () => {
    const resolved = await manager().probeSourceUrl('摘了腾讯的源', tx, '320k', 5000)
    expect(resolved.ok).toBe(true)
    expect(resolved.url).toBe('https://up.example/tx.flac')
  })

  it('同一个源在真实瀑布里依旧接不到腾讯的活：改的只是看得见什么', async () => {
    await expect(manager().getMusicUrlWithProvider(tx, '320k')).rejects.toThrow()
    // pt 拦在调脚本之前：这格既没出网也没记账
    expect(sourceHealth.view('摘了腾讯的源', 'tx')).toBeNull()
  })

  it('脚本压根没声明的平台仍判 unsupported —— 那是能力事实，不是决定', async () => {
    const kg = await manager().probeSourceUrl('摘了腾讯的源', { ...musicInfo, source: 'kg' } as never, '320k', 5000)
    expect(kg).toMatchObject({ ok: false, outcome: 'unsupported', latencyMs: 0 })
    expect(kg.reason).toContain('未声明')
  })
})

/**
 * 按调用路径覆盖取址预算（音箱那一条）。
 *
 * 动机是两条路的耐心差一个量级：手机/网页能等 18s，音箱那条设备**约 5.1 秒**拿不到字节
 * 就挂断、0.1 秒后重拉同一个地址。默认的 8s 单源预算对音箱完全无效——挂起的头源每次
 * 都把设备等到先走，后面的源一次轮不到，用户看到"投过去没声音"。
 *
 * 另一件必须钉住的事：收紧预算的那条路**不许把"到预算"记进健康账本**。账本按 `源×平台`
 * 共享、两连坏就冷却，而"2 秒没出货"对音箱是失败、对手机只是慢；照记就是让投放功能
 * 反过来替本机播放冷却音源。
 */
describe('按调用路径覆盖取址预算', () => {
  /** 音箱那条路的真实默认值（env 未设置时） */
  const GLOBAL = { urlMs: 15_000, perSourceMs: 8_000, totalMs: 18_000 }

  function hungThenGood() {
    let hangCalls = 0
    const instances = [
      fakeSource('挂起的头源', () => {
        hangCalls++
        return new Promise<string>(() => {})
      }),
      fakeSource('后面的好源', async () => 'https://ok/speaker.flac'),
    ]
    return { instances, hangCalls: () => hangCalls }
  }

  it('覆盖生效：挂起的头源只占一个收紧后的单源档，第二个源照常出货', async () => {
    const { instances, hangCalls } = hungThenGood()
    const m = managerWith(instances, GLOBAL)
    const t = Date.now()

    const r = await m.getMusicUrlWithProvider(musicInfo, 'flac', {
      budgets: { perSourceMs: 300, totalMs: 600 },
    })

    expect(r.provider).toBe('后面的好源')
    expect(hangCalls()).toBe(1)
    // 全局单源预算是 8000ms：真要按它等，这里至少 8s
    expect(Date.now() - t).toBeLessThan(1000)
  })

  it('收紧的那条路不写共享账本：同一次挂起，带覆盖不记坏、不带覆盖照旧记坏', async () => {
    // 对照组先用一份独立账本状态跑"不带覆盖"（默认行为，改动前就是这样）
    const a = hungThenGood()
    const mA = managerWith(a.instances, { ...GLOBAL, perSourceMs: 300, totalMs: 5000 })
    await mA.getMusicUrlWithProvider(musicInfo, 'flac')
    const withoutOverride = sourceHealth.view('挂起的头源', 'kw')
    expect(withoutOverride?.bad).toBe(1)
    expect(withoutOverride?.badKinds).toEqual({ timeout: 1 })

    sourceHealth.reset()

    // 实验组：同样的预算数字，只多一个"到预算不计坏"
    const b = hungThenGood()
    const mB = managerWith(b.instances, { ...GLOBAL, perSourceMs: 300, totalMs: 5000 })
    const r = await mB.getMusicUrlWithProvider(musicInfo, 'flac', {
      budgets: { perSourceMs: 300, totalMs: 5000, countBudgetTimeoutAsBad: false },
    })

    expect(r.provider).toBe('后面的好源')
    expect(sourceHealth.view('挂起的头源', 'kw')).toBeNull() // 一次都没入账
    expect(sourceHealth.coolStatus('挂起的头源', 'kw').skip).toBe(false)
    // 出货那一格照样入账：闸门只管"到预算"，不是把整条路的埋点关掉
    expect(sourceHealth.view('后面的好源', 'kw')?.resolveOk).toBe(1)
  })

  it('覆盖不许把预算配歪：单源 ≥ 总预算时夹紧并告警（否则一条瀑布只够试一个源）', async () => {
    const { instances, hangCalls } = hungThenGood()
    const m = managerWith(instances, GLOBAL)
    const t = Date.now()

    // 1000 ≥ 800 会被夹成总预算的一半（400）。不夹的话单次会按 800 等满，总预算当场见底、
    // 第二个源一次都轮不到——所以"第二个源出了货"本身就是夹紧的正证。
    const r = await m.getMusicUrlWithProvider(musicInfo, 'flac', {
      budgets: { perSourceMs: 1000, totalMs: 800, countBudgetTimeoutAsBad: false },
    })

    expect(r.provider).toBe('后面的好源')
    expect(hangCalls()).toBe(1)
    expect(Date.now() - t).toBeLessThan(750)
    expect(vi.mocked(logger.warn).mock.calls.some(c => String(c[0]).includes('覆盖后单源预算'))).toBe(true)
  })

  it('音箱预设自洽：单源 < 总预算 < 设备的 5.1 秒耐心，且默认不计坏', () => {
    const b = readSpeakerUrlBudgets()
    expect(b.perSourceMs).toBeLessThan(b.totalMs!)
    expect(b.totalMs!).toBeLessThan(5_100)
    expect(b.countBudgetTimeoutAsBad).toBe(false)
  })

  it('音箱预设的两个数都能 env 覆盖（与 SOURCE_URL_* 同一口径）', () => {
    const saved = { ...process.env }
    try {
      process.env.SPEAKER_SOURCE_URL_PER_SOURCE_TIMEOUT_MS = '1200'
      process.env.SPEAKER_SOURCE_URL_TOTAL_TIMEOUT_MS = '3000'
      expect(readSpeakerUrlBudgets()).toMatchObject({ perSourceMs: 1200, totalMs: 3000 })
      // 非法值退回默认，不静默变成 0（0 预算等于整条瀑布不试就失败）
      process.env.SPEAKER_SOURCE_URL_PER_SOURCE_TIMEOUT_MS = 'abc'
      expect(readSpeakerUrlBudgets().perSourceMs).toBe(2_000)
    } finally {
      process.env = saved
    }
  })

  it('手机那条路的默认预算没被动过：覆盖只在调用内生效，不写回实例', async () => {
    // 用 urlMs 做探针（它不会被夹紧逻辑改动）：实例上是 8000 的单源预算、15000 的单次上限，
    // 这一次调用把单次上限压到 200ms。若它漏进了实例，第二次就只会等 200ms。
    const { instances, hangCalls } = hungThenGood()
    const m = managerWith(instances, { ...GLOBAL, perSourceMs: 3000, totalMs: 5000 })

    const first = await m.getMusicUrlWithProvider(musicInfo, 'flac', {
      budgets: { urlMs: 200, perSourceMs: 300, totalMs: 5000, countBudgetTimeoutAsBad: false },
    })
    expect(first.provider).toBe('后面的好源')
    expect(hangCalls()).toBe(1)

    const t = Date.now()
    const second = await m.getMusicUrlWithProvider({ ...musicInfo, songmid: 'sm-9' } as never, 'flac')
    const took = Date.now() - t
    expect(second.provider).toBe('后面的好源')
    // 不带覆盖时按实例上的 perSourceMs=3000 等满那一次；漏进来的话这里只有 200ms
    expect(took).toBeGreaterThanOrEqual(2900)
  })

  it('单源预算配得比一次尝试的下限还小，也不能让整条瀑布一次都不出手', async () => {
    const { instances, hangCalls } = hungThenGood()
    const m = managerWith(instances, GLOBAL)

    // 100ms < MIN_USEFUL_ATTEMPT_MS：照原样会让每个源在第一次调用前就被判"没时间了"，
    // 静默变成"所有音源均失败"（配错一个环境变量就能让这条路全哑）。
    const r = await m.getMusicUrlWithProvider(musicInfo, 'flac', {
      budgets: { perSourceMs: 100, totalMs: 5000 },
    })

    expect(r.provider).toBe('后面的好源')
    expect(hangCalls()).toBe(1)
    expect(vi.mocked(logger.warn).mock.calls.some(c => String(c[0]).includes('已抬到下限'))).toBe(true)
  })
})

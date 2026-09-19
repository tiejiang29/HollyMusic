/**
 * 源健康账本单测
 *
 * 重点钉三条实测换来的护栏：① 能力/版权不符不计坏；② 本机网络故障期间不记坏；
 * ③ 样本不足不下结论。这三条任何一条失效，3c 的熔断就会把好源误杀。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { sourceHealth, isLikelyLocalNetworkFault } = await import('./source-health')

const T0 = new Date('2026-09-19T12:00:00Z').getTime()

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  sourceHealth.reset()
})
afterEach(() => {
  vi.useRealTimers()
})

/** 连记 n 次同种结局 */
function resolveTimes(source: string, platform: string, outcome: 'ok' | 'timeout' | 'error' | 'ssrf' | 'no-address', n: number, ms = 500) {
  for (let i = 0; i < n; i++) sourceHealth.recordResolve(source, platform, outcome, ms)
}

describe('记账维度', () => {
  it('同一个源的坏只影响它自己那个平台', () => {
    resolveTimes('源A', 'kw', 'timeout', 6)
    resolveTimes('源A', 'tx', 'ok', 6)

    expect(sourceHealth.view('源A', 'kw')?.band).toBe('cooling')
    expect(sourceHealth.view('源A', 'tx')?.band).toBe('healthy')
  })

  it('窗口只保留最近 50 个样本，早期的坏被滑出后不再压制该源', () => {
    resolveTimes('源B', 'kw', 'timeout', 10)
    expect(sourceHealth.view('源B', 'kw')?.bad).toBe(10)

    resolveTimes('源B', 'kw', 'ok', 45, 300)
    const v = sourceHealth.view('源B', 'kw')
    expect(v?.samples).toBe(50)
    // 10 个坏样本被挤掉了 5 个
    expect(v?.bad).toBe(5)
    expect(v?.consecutiveBad).toBe(0) // 末尾是好的
    expect(v?.band).toBe('degraded')  // 半小时内仍有坏，但不再是 cooling
  })
})

describe('护栏一：没找到不等于坏了', () => {
  it('返回空地址只累计 noMatch，不进窗口也不拉低分档', () => {
    resolveTimes('源C', 'mg', 'no-address', 20)
    resolveTimes('源C', 'mg', 'ok', 5)

    const v = sourceHealth.view('源C', 'mg')
    expect(v?.noMatch).toBe(20)
    expect(v?.bad).toBe(0)
    expect(v?.samples).toBe(5)
    expect(v?.band).toBe('healthy')
  })

  it('超时/报错/SSRF 才算坏，且原因会留下给人看', () => {
    sourceHealth.recordResolve('源D', 'kw', 'error', 40, '音源运行器不可用（已熔断）')
    vi.advanceTimersByTime(10)
    sourceHealth.recordResolve('源D', 'kw', 'ssrf', 30, '返回私网/非 http(s) 地址')
    vi.advanceTimersByTime(10)
    sourceHealth.recordResolve('源D', 'kw', 'timeout', 8000, '超过单源预算 8000ms')

    const v = sourceHealth.view('源D', 'kw')
    expect(v?.bad).toBe(3)
    expect(v?.badKinds).toEqual({ error: 1, ssrf: 1, timeout: 1 })
    // 最近一次坏的原因要能看出来（时间戳相同则不确定，所以记录间隔了时钟）
    expect(v?.lastBadReason).toContain('单源预算')
  })
})

describe('护栏二：本机网络故障不冤枉音源', () => {
  it('识别 DNS/连接层错误（含 fetch 的 cause 包装）', () => {
    expect(isLikelyLocalNetworkFault(Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }),
    }))).toBe(true)
    expect(isLikelyLocalNetworkFault(new Error('getaddrinfo EAI_AGAIN foo'))).toBe(true)
    // 我们自己 abort 的 stall 不算本机故障
    expect(isLikelyLocalNetworkFault(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))).toBe(false)
    expect(isLikelyLocalNetworkFault(new Error('上游返回非音频内容'))).toBe(false)
  })

  it('豁免窗内坏样本被丢弃，好样本照记；窗过后再记坏', () => {
    sourceHealth.markNetworkOutage(30_000)
    resolveTimes('源E', 'tx', 'timeout', 9, 8000)
    expect(sourceHealth.view('源E', 'tx')).toBeNull() // 一条都没记进去

    resolveTimes('源E', 'tx', 'ok', 6)
    expect(sourceHealth.view('源E', 'tx')?.band).toBe('healthy')

    vi.advanceTimersByTime(31_000)
    resolveTimes('源E', 'tx', 'timeout', 4, 8000)
    expect(sourceHealth.view('源E', 'tx')?.consecutiveBad).toBe(4)
  })
})

describe('护栏三：样本不足不下结论，以及字节段', () => {
  it('单次坏不足以定档：少于 5 个样本时给 no-data（不是 healthy，也不是 degraded）', () => {
    resolveTimes('源F', 'kw', 'timeout', 1)
    expect(sourceHealth.view('源F', 'kw')?.band).toBe('no-data')
  })

  it('字节段 fake 是最高置信坏证据；unverified 不进窗口', () => {
    resolveTimes('源G', 'wy', 'ok', 4)
    sourceHealth.recordByte('源G', 'wy', 'fake', '响应是文本/HTML/JSON，不是音频')
    sourceHealth.recordByte('源G', 'wy', 'unverified', '容器无法识别')
    sourceHealth.recordByte('源G', 'wy', 'audio', '识别到媒体容器 flac')

    const v = sourceHealth.view('源G', 'wy')
    expect(v?.bad).toBe(1)
    expect(v?.badKinds['byte:fake']).toBe(1)
    expect(v?.byteOk).toBe(1)
    expect(v?.byteUnverified).toBe(1)
    expect(v?.samples).toBe(6) // 4 ok + fake + audio；unverified 不占样本
  })

  it('provider 为空的字节结局无处归因，直接忽略而不编造键', () => {
    sourceHealth.recordByte('', 'kw', 'fake')
    sourceHealth.recordResolve('', 'kw', 'timeout', 10)
    expect(sourceHealth.snapshot()).toEqual([])
  })
})

describe('快照与延迟', () => {
  it('snapshot 按严重度排：cooling 在 degraded 前，healthy 殿后', () => {
    resolveTimes('坏源', 'kw', 'timeout', 6, 8000)
    resolveTimes('半坏源', 'kw', 'timeout', 1)
    resolveTimes('半坏源', 'kw', 'ok', 6)
    resolveTimes('好源', 'kw', 'ok', 6, 120)

    expect(sourceHealth.snapshot().map(v => v.source)).toEqual(['坏源', '半坏源', '好源'])
  })

  it('延迟取窗口分位数，坏样本没有耗时也不报错', () => {
    resolveTimes('源H', 'kw', 'ok', 9, 100)
    sourceHealth.recordResolve('源H', 'kw', 'timeout', null)
    sourceHealth.recordResolve('源H', 'kw', 'ok', 900)

    const v = sourceHealth.view('源H', 'kw')
    expect(v?.latencyP50Ms).toBe(100)
    expect(v?.latencyP90Ms).toBeGreaterThanOrEqual(100)
  })
})

/**
 * 3c：账本从"只展示"变成"会动作"。这里的断言就是瀑布的跳过依据，
 * 参数（2 次 / 60s / 5min / 翻倍上限 30min）来自 62 格全矩阵摸底实测。
 */
describe('3c 冷却状态机', () => {
  it('跨歌连续 2 次快速失败即冷却 60s，不等攒满 5 个样本', () => {
    sourceHealth.recordResolve('源S', 'kw', 'error', 30, '脚本内部报错')
    expect(sourceHealth.coolStatus('源S', 'kw').skip).toBe(false) // 一次坏不动作

    sourceHealth.recordResolve('源S', 'kw', 'error', 40, '脚本内部报错')
    const v = sourceHealth.view('源S', 'kw')
    expect(v?.band).toBe('cooling')
    expect(v?.retryAfterMs).toBe(60_000)
    expect(sourceHealth.coolStatus('源S', 'kw')).toEqual({ skip: true, retryAfterMs: 60_000, cooling: true })
  })

  it('挂起类坏（取址超时）按 5min 冷却：它烧掉的是整份单源预算', () => {
    resolveTimes('源T', 'kw', 'timeout', 2, 8000)
    expect(sourceHealth.view('源T', 'kw')?.retryAfterMs).toBe(300_000)
  })

  it('字节段 stall 中断与取址超时同档（都是"上游不给数据"）', () => {
    sourceHealth.recordByte('源U', 'kw', 'truncated', '下载中断：This operation was aborted')
    sourceHealth.recordByte('源U', 'kw', 'truncated', '下载中断：This operation was aborted')
    expect(sourceHealth.view('源U', 'kw')?.retryAfterMs).toBe(300_000)
  })

  it('一串连续坏里掺了挂起就按长的算，不因末位是快速失败而缩短', () => {
    sourceHealth.recordResolve('源V', 'kw', 'timeout', 8000, '超过单源预算')
    sourceHealth.recordResolve('源V', 'kw', 'error', 20, '脚本内部报错')
    expect(sourceHealth.view('源V', 'kw')?.retryAfterMs).toBe(300_000)
  })

  it('半开：到期后只放一个请求出去，成功后立刻恢复可跳过状态且翻倍清零', () => {
    resolveTimes('源W', 'kw', 'ok', 4, 150)
    resolveTimes('源W', 'kw', 'error', 2, 30)
    expect(sourceHealth.coolStatus('源W', 'kw').skip).toBe(true)
    vi.advanceTimersByTime(60_000)

    expect(sourceHealth.claimProbe('源W', 'kw')).toBe(true)
    expect(sourceHealth.coolStatus('源W', 'kw').skip).toBe(true) // 探测在途，其它请求继续跳
    expect(sourceHealth.claimProbe('源W', 'kw')).toBe(false)      // 槽位不重复发放

    sourceHealth.recordResolve('源W', 'kw', 'ok', 120)
    const v = sourceHealth.view('源W', 'kw')
    expect(v?.coolingUntil).toBe(0)
    expect(v?.backoffs).toBe(0)
    expect(v?.retryAfterMs).toBe(0)
    // band 仍是 degraded 而不是 healthy：30min 内确实坏过，展示口径要诚实；
    // 但动作层面（3c 是否跳过）已经恢复放行。
    expect(v?.band).toBe('degraded')
    expect(sourceHealth.coolStatus('源W', 'kw').skip).toBe(false)
  })

  it('半开失败按 2^n 翻倍，上限 30min', () => {
    resolveTimes('源X', 'kw', 'error', 2, 30)
    const expectCooldown = (ms: number) => expect(sourceHealth.view('源X', 'kw')?.retryAfterMs).toBe(ms)
    expectCooldown(60_000)

    const failAgain = () => {
      vi.advanceTimersByTime(sourceHealth.view('源X', 'kw')!.retryAfterMs)
      expect(sourceHealth.claimProbe('源X', 'kw')).toBe(true)
      sourceHealth.recordResolve('源X', 'kw', 'error', 30, '脚本内部报错')
    }
    failAgain(); expectCooldown(120_000)
    failAgain(); expectCooldown(240_000)
    failAgain(); expectCooldown(480_000)
    failAgain(); expectCooldown(960_000)
    failAgain(); expectCooldown(1_800_000) // 封顶，不再无限膨胀
    failAgain(); expectCooldown(1_800_000)
  })

  it('探测请求中途死了：租约到期自动释放，且过期租约不会被当作半开失败去翻倍', () => {
    resolveTimes('源Y', 'kw', 'error', 2, 30)
    vi.advanceTimersByTime(60_000)
    expect(sourceHealth.claimProbe('源Y', 'kw')).toBe(true)

    // 半开请求在记账前异常退出（总预算到点/进程被掐）——槽位不能永久占着
    vi.advanceTimersByTime(60_001)
    expect(sourceHealth.coolStatus('源Y', 'kw').skip).toBe(false)

    // 不占槽直接记坏（例如保底护栏逼着上场的那次）：过期租约不算半开失败，
    // 所以冷却仍是基础时长，不叠加翻倍
    sourceHealth.recordResolve('源Y', 'kw', 'error', 30, '脚本内部报错')
    expect(sourceHealth.view('源Y', 'kw')?.retryAfterMs).toBe(60_000)
    expect(sourceHealth.view('源Y', 'kw')?.backoffs).toBe(0)
  })

  it('"源里没这首歌"不消耗半开槽位：版权没命中也要把槽位还回去', () => {
    resolveTimes('源Z', 'mg', 'error', 2, 30)
    vi.advanceTimersByTime(60_000)
    expect(sourceHealth.claimProbe('源Z', 'mg')).toBe(true)
    sourceHealth.recordResolve('源Z', 'mg', 'no-address', 50)

    expect(sourceHealth.coolStatus('源Z', 'mg').skip).toBe(false) // 立刻可再探测，不等租约过期
    expect(sourceHealth.claimProbe('源Z', 'mg')).toBe(true)
  })

  it('字节段 unverified 同样释放槽位（既不算好也不算坏）', () => {
    resolveTimes('源AA', 'tx', 'error', 2, 30)
    vi.advanceTimersByTime(60_000)
    expect(sourceHealth.claimProbe('源AA', 'tx')).toBe(true)
    sourceHealth.recordByte('源AA', 'tx', 'unverified', '容器无法识别')
    expect(sourceHealth.coolStatus('源AA', 'tx').skip).toBe(false)
  })

  it('网络中断豁免期内记不进坏，也就不会把全体源一起推进冷却', () => {
    sourceHealth.markNetworkOutage(30_000)
    resolveTimes('源AB', 'kw', 'timeout', 6, 8000)
    expect(sourceHealth.view('源AB', 'kw')).toBeNull()
    expect(sourceHealth.coolStatus('源AB', 'kw').skip).toBe(false)
  })
})

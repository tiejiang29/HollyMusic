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

import { describe, it, expect, vi } from 'vitest'

// 跨平台换源会打 DB 与搜索，这里全部屏蔽：本测试只关心同平台瀑布的预算行为
vi.mock('./services/source-toggle', () => ({
  findBestAlternative: vi.fn(async () => null),
}))
vi.mock('./logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { MusicSourceManager, readUrlBudgets } = await import('./music-source-manager')
import type { SimulatorInstance } from './music-source-manager'

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

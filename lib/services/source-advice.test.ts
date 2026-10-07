/**
 * 「按周测结果给建议」的判据测试。
 *
 * 钉的是四件事，每件都对应一次会写进生产配置的改动：
 * 1. **连续两批同向**才提 —— 单批抖动（一次超时、一首冷门歌）不该摘掉一个平台；
 * 2. `no-address`（源里没这首歌）与 `unsupported`（脚本没这平台）**不算坏证据**，与账本同口径；
 * 3. `pt` 为空是"隐式全平台"，不能拿一条建议去把它变成显式清单；
 * 4. priority 重排**只在有实测数据的源之间进行**，没数据的源一个位置都不动
 *    （马太效应是这套东西最初被否决的理由，这条就是它的反面保证）。
 * 另有一条流程性的：固化只认 id，值由服务端重算（客户端拿着旧页面也写不进旧值）。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  prisma: {
    sourceProbeRun: { findMany: vi.fn() },
    sourceProbeResult: { findMany: vi.fn() },
  },
  config: { sources: [] as Array<Record<string, unknown>> },
  configText: '{"sources":[]}',
  updates: vi.fn(async () => 0),
  settings: new Map<string, unknown>(),
}))

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/db', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/services/source-manager-service', () => ({
  readConfig: async () => ({ sources: mocks.config.sources }),
  readConfigText: async () => mocks.configText,
  writeConfigText: vi.fn(async () => {}),
  updateSourcesBatch: mocks.updates,
}))
vi.mock('@/lib/services/app-setting', () => ({
  readSetting: async (key: string) => (mocks.settings.has(key) ? mocks.settings.get(key) : null),
  writeSetting: async (key: string, value: unknown) => { mocks.settings.set(key, value) },
}))

const { computeAdvice, applyAdvice, buildAdvice, UNDO_SETTING_KEY } = await import('@/lib/services/source-advice')
const { probeCellKey } = await import('@/lib/services/source-probe')

type CellSeed = { ok?: number; bad?: number; samples?: number; latencies?: number[]; badReason?: string | null }

const cell = (seed: CellSeed) => ({
  samples: seed.samples ?? (seed.ok ?? 0) + (seed.bad ?? 0),
  okCount: seed.ok ?? 0,
  badCount: seed.bad ?? 0,
  latencies: seed.latencies ?? [],
  badReason: seed.badReason ?? null,
})

/** batches[0] 是最新一批；cells 用 { '源名': { 平台: 格 } } 写，读起来像人话 */
const batch = (rows: Record<string, Record<string, CellSeed>>, runAt = new Date(Date.UTC(2026, 9, 1))) => ({
  runAt,
  cells: new Map(Object.entries(rows).flatMap(([source, platforms]) =>
    Object.entries(platforms).map(([platform, seed]) => [probeCellKey(source, platform), cell(seed)] as const))),
})

const source = (name: string, priority: number, pt: string[]) => ({ path: `custom-sources/${name}.js`, name, priority, pt })

describe('computeAdvice', () => {
  it('门槛不对称：单批也能提「放回」，但「摘除」与「顺位」要等第二批', () => {
    const rows = [source('甲', 1, ['kw']), source('乙', 2, ['kw'])]
    const out = computeAdvice(rows, [batch({ 甲: { tx: { ok: 2 } }, 乙: { kw: { bad: 2 } } })])
    expect(out.map(a => a.kind)).toEqual(['add-pt'])
    expect(out[0].evidence).toContain('只有这一批周测可比')
    expect(computeAdvice(rows, [])).toEqual([])
  })

  it('上一批被 pt 挡着没测到、这一批出货 ⇒ 照样提放回（真数据上就是这么卡住的）', () => {
    const rows = [source('玉宁熙', 1, ['kw', 'wy'])]
    const out = computeAdvice(rows, [
      batch({ 玉宁熙: { kg: { ok: 2, latencies: [180, 220] } } }, new Date(Date.UTC(2026, 9, 8))),
      batch({ 玉宁熙: { kg: { samples: 2, badCount: 0 } } }, new Date(Date.UTC(2026, 9, 1))),
    ])
    expect(out.map(a => `${a.kind}:${a.platform}`)).toEqual(['add-pt:kg'])
    expect(out[0].evidence).toContain('最近一批出货')
    expect(out[0].evidence).toContain('上一批 0/2 出货')
  })

  it('被 pt 摘着但连续两批都出货 ⇒ 建议放回，pt 按平台清单顺序补', () => {
    const rows = [source('甲', 1, ['kw', 'tx'])]
    const out = computeAdvice(rows, [
      batch({ 甲: { kg: { ok: 2, latencies: [300, 400] } } }, new Date(Date.UTC(2026, 9, 8))),
      batch({ 甲: { kg: { ok: 2, latencies: [500] } } }, new Date(Date.UTC(2026, 9, 1))),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'add-pt', source: '甲', platform: 'kg' })
    expect(out[0].patch.pt).toEqual(['kw', 'tx', 'kg'])
    expect(out[0].evidence).toContain('4/4 出货')
  })

  it('只有一批判坏、另一批其实是被摘着没测 ⇒ 不提摘掉', () => {
    const rows = [source('甲', 1, ['kw', 'tx'])]
    expect(computeAdvice(rows, [
      batch({ 甲: { tx: { bad: 2, badReason: 'fake 地址' } } }, new Date(Date.UTC(2026, 9, 8))),
      batch({}, new Date(Date.UTC(2026, 9, 1))),
    ])).toEqual([])
  })

  it('两批都没出货但原因是「没这首歌」/「不适用」⇒ 不算坏证据，不摘平台', () => {
    const rows = [source('甲', 1, ['kw', 'tx'])]
    const out = computeAdvice(rows, [
      // ok/bad 都为 0：全是 no-address 与 unsupported 那类
      batch({ 甲: { tx: { samples: 2 } } }, new Date(Date.UTC(2026, 9, 8))),
      batch({ 甲: { tx: { samples: 2 } } }, new Date(Date.UTC(2026, 9, 1))),
    ])
    expect(out).toEqual([])
  })

  it('两批都真判坏 ⇒ 建议摘掉这个平台，依据带上坏原因', () => {
    const rows = [source('甲', 1, ['kw', 'tx'])]
    const out = computeAdvice(rows, [
      batch({ 甲: { tx: { bad: 2, badReason: 'Fake Content-Type' } } }, new Date(Date.UTC(2026, 9, 8))),
      batch({ 甲: { tx: { bad: 2 } } }, new Date(Date.UTC(2026, 9, 1))),
    ])
    expect(out.map(a => a.kind)).toEqual(['drop-pt'])
    expect(out[0].patch.pt).toEqual(['kw'])
    expect(out[0].evidence).toContain('Fake Content-Type')
  })

  it('pt 为空是"隐式全平台"：不给它提摘除，免得把隐式变成显式清单', () => {
    const rows = [source('甲', 1, [])]
    const out = computeAdvice(rows, [
      batch({ 甲: { tx: { bad: 2 } } }, new Date(Date.UTC(2026, 9, 8))),
      batch({ 甲: { tx: { bad: 2 } }, kw: { ok: 2 } }, new Date(Date.UTC(2026, 9, 1))),
    ])
    expect(out.filter(a => a.kind === 'drop-pt')).toEqual([])
  })

  it('顺位是全局的：一次只出一套建议，按「出货批数 → 覆盖平台数 → 延迟」排', () => {
    // 甲两个平台两批全出货、乙只覆盖酷我且第二批少一首 ⇒ 甲该提到前面
    const rows = [source('甲', 2, ['kw', 'tx']), source('乙', 1, ['kw'])]
    const b1 = batch({ 甲: { kw: { ok: 2, latencies: [200] }, tx: { ok: 2, latencies: [260] } }, 乙: { kw: { ok: 2, latencies: [90] } } }, new Date(Date.UTC(2026, 9, 8)))
    const b2 = batch({ 甲: { kw: { ok: 2, latencies: [210] }, tx: { ok: 2, latencies: [250] } }, 乙: { kw: { ok: 1, latencies: [80] } } }, new Date(Date.UTC(2026, 9, 1)))
    const out = computeAdvice(rows, [b1, b2]).filter(a => a.kind === 'priority')
    expect(out.map(a => `${a.source}→${a.patch.priority}`)).toEqual(['甲→1', '乙→2'])
    // priority 是全局顺位：不带平台，且同一个源不会有两套互相矛盾的说法
    expect(out.every(a => a.platform === null)).toBe(true)
    expect(new Set(out.map(a => a.path)).size).toBe(out.length)
  })

  it('快但只能覆盖一个平台的源，不该压过慢但两个平台都能干的源', () => {
    // 当前顺序恰好是反的：快而窄排在前面，可它只能干一个平台
    const rows = [source('快而窄', 1, ['kw']), source('慢而宽', 2, ['kw', 'tx'])]
    const b1 = batch({ 快而窄: { kw: { ok: 2, latencies: [50] } }, 慢而宽: { kw: { ok: 2, latencies: [800] }, tx: { ok: 2, latencies: [900] } } }, new Date(Date.UTC(2026, 9, 8)))
    const out = computeAdvice(rows, [b1, b1]).filter(a => a.kind === 'priority')
    expect(out.map(a => `${a.source}→${a.patch.priority}`)).toEqual(['慢而宽→1', '快而窄→2'])
  })

  it('没有实测数据的源一个位置都不动（"没测过"不该被排到队尾锁死）', () => {
    const rows = [source('甲', 3, ['kw']), source('乙', 1, ['kw']), source('没测过的丙', 2, ['kw'])]
    const out = computeAdvice(rows, [
      batch({ 甲: { kw: { ok: 2, latencies: [150] } }, 乙: { kw: { ok: 2, latencies: [900] } } }, new Date(Date.UTC(2026, 9, 8))),
      batch({ 甲: { kw: { ok: 2, latencies: [160] } }, 乙: { kw: { ok: 2, latencies: [910] } } }, new Date(Date.UTC(2026, 9, 1))),
    ])
    expect(out.map(a => a.source)).toEqual(['甲', '乙'])
    expect(out.find(a => a.source === '甲')?.patch.priority).toBe(1)
    expect(out.find(a => a.source === '乙')?.patch.priority).toBe(3)
    expect(out.some(a => a.source === '没测过的丙')).toBe(false)
  })

  it('有实测的源不足 2 个就不动顺位；priority 有重复（顺序本身说不清）时整套跳过', () => {
    const solo = computeAdvice([source('甲', 3, ['kw'])], [
      batch({ 甲: { kw: { ok: 2 } } }, new Date(Date.UTC(2026, 9, 8))),
      batch({ 甲: { kw: { ok: 2 } } }, new Date(Date.UTC(2026, 9, 1))),
    ])
    expect(solo.filter(a => a.kind === 'priority')).toEqual([])
    const dup = computeAdvice([source('甲', 1, ['kw']), source('乙', 1, ['kw'])], [
      batch({ 甲: { kw: { ok: 2 } }, 乙: { kw: { ok: 1 } } }, new Date(Date.UTC(2026, 9, 8))),
      batch({ 甲: { kw: { ok: 2 } }, 乙: { kw: { ok: 1 } } }, new Date(Date.UTC(2026, 9, 1))),
    ])
    expect(dup.filter(a => a.kind === 'priority')).toEqual([])
  })

  it('顺序本来就对 ⇒ 一条顺位建议都不提', () => {
    const rows = [source('甲', 1, ['kw']), source('乙', 2, ['kw'])]
    const out = computeAdvice(rows, [
      batch({ 甲: { kw: { ok: 2, latencies: [100] } }, 乙: { kw: { ok: 2, latencies: [900] } } }, new Date(Date.UTC(2026, 9, 8))),
      batch({ 甲: { kw: { ok: 2, latencies: [100] } }, 乙: { kw: { ok: 2, latencies: [900] } } }, new Date(Date.UTC(2026, 9, 1))),
    ])
    expect(out).toEqual([])
  })
})

describe('固化：只认 id', () => {
  beforeEach(() => {
    mocks.updates.mockClear()
    mocks.settings.clear()
    mocks.configText = '{"sources":[]}'
  })

  it('客户端传上来的值一概不信：按 id 从"这一刻重算的建议"里取补丁', async () => {
    mocks.config.sources = [
      { path: 'custom-sources/甲.js', name: '甲', priority: 1, enabled: true, pt: ['kw', 'tx'] },
    ]
    mocks.prisma.sourceProbeRun.findMany.mockResolvedValue([
      { startedAt: new Date(Date.UTC(2026, 9, 8)) }, { startedAt: new Date(Date.UTC(2026, 9, 1)) },
    ] as never)
    const rowsFor = (runAt: Date, platform: string, outcome: string) =>
      ({ runAt, source: '甲', platform, outcome, latencyMs: 120, reason: null })
    mocks.prisma.sourceProbeResult.findMany.mockResolvedValue([
      rowsFor(new Date(Date.UTC(2026, 9, 8)), 'kg', 'ok'),
      rowsFor(new Date(Date.UTC(2026, 9, 1)), 'kg', 'ok'),
    ] as never)

    const view = await buildAdvice()
    expect(view.suggestions.map(a => a.id)).toEqual(['add-pt:custom-sources/甲.js:kg'])

    await applyAdvice(['add-pt:custom-sources/甲.js:kg'])
    expect(mocks.updates).toHaveBeenCalledWith([{ path: 'custom-sources/甲.js', pt: ['kw', 'tx', 'kg'] }])
    // 快照先落库，撤销才有东西可还原
    expect(mocks.settings.get(UNDO_SETTING_KEY)).toMatchObject({ text: '{"sources":[]}' })
  })

  it('id 不在当前建议里（页面挂着旧建议）⇒ 一条都不写', async () => {
    mocks.config.sources = [{ path: 'custom-sources/甲.js', name: '甲', priority: 1, enabled: true, pt: ['kw'] }]
    mocks.prisma.sourceProbeRun.findMany.mockResolvedValue([] as never)
    expect(await applyAdvice(['drop-pt:custom-sources/甲.js:tx'])).toEqual({ applied: 0, changed: 0 })
    expect(mocks.updates).not.toHaveBeenCalled()
    expect(mocks.settings.size).toBe(0)
  })
})

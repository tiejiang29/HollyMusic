/**
 * 「导入」这一档的判据测试（C 期：发现 → 判级 → 导入闭环）。
 *
 * 钉的是 UI 与服务端**口径一致**：服务端 `importCandidate` 要求"判级里至少一个平台真出货"，
 * 并且撞库里已有源时要按种类分别处理（同名要 force、同内容直接不给装），面板也按同一套话决定
 * 按钮是直接导入、要二次确认、还是干脆不出现。两边算得不一样时，
 * 管理员看到的是自相矛盾——按钮说能装，接口回 409。
 */

import { describe, expect, it } from 'vitest'
import type { DiscoveryCandidate, ProbeCellView } from '@/lib/api/admin-source-discovery'

const { okPlatformCount, needsForceConfirm, canForceProbe, similarNameBadge } = await import('@/components/admin/SourceDiscoveryPanel')

const cell = (outcome: string): ProbeCellView => ({ outcome, latencyMs: 120, container: null, reason: null })

describe('okPlatformCount', () => {
  it('只有真出货算数：超时/假地址/没给地址都不算（它们说的是"这格不行"）', () => {
    expect(okPlatformCount({ tx: cell('ok') })).toBe(1)
    expect(okPlatformCount({ tx: cell('ok'), wy: cell('timeout'), kg: cell('fake') })).toBe(1)
    expect(okPlatformCount({ wy: cell('no-address'), mg: cell('head-error') })).toBe(0)
  })

  it('从没判过（cells 缺失）= 0，不是"没证据就先放行"', () => {
    expect(okPlatformCount(undefined)).toBe(0)
    expect(okPlatformCount({})).toBe(0)
  })

  it('加载失败那一格用的占位键 _ 也不算出货（它记的是"脚本没起来"）', () => {
    expect(okPlatformCount({ _: cell('load-failed'), tx: cell('ok') })).toBe(1)
    expect(okPlatformCount({ _: cell('load-failed') })).toBe(0)
  })
})

describe('needsForceConfirm（要不要二次确认才导）', () => {
  const probeWith = (cells: Record<string, ProbeCellView>) => ({ cells, shaVerified: true, note: null })
  const dup = (kind: 'content' | 'name') => ({ kind, path: 'custom-sources/a.js', name: '某源 v1' })

  it('判级有出货、也没撞车 ⇒ 一次点击直接导', () => {
    expect(needsForceConfirm({ probe: probeWith({ tx: cell('ok') }), duplicateOf: null })).toBe(false)
  })

  it('判级没出货 ⇒ 要二次确认（这是原有那一档）', () => {
    expect(needsForceConfirm({ probe: probeWith({ tx: cell('error') }), duplicateOf: null })).toBe(true)
    expect(needsForceConfirm({ probe: null, duplicateOf: null })).toBe(true)
  })

  it('库里已有同名源 ⇒ 即使绿灯也要二次确认 —— 代价是两条源共用账本那一格', () => {
    expect(needsForceConfirm({ probe: probeWith({ tx: cell('ok') }), duplicateOf: dup('name') })).toBe(true)
  })

  it('内容完全相同 ⇒ 不在这一档（按钮根本不渲染，服务端也不给 force 越），这里保持"不需要确认"以免误判成可点', () => {
    expect(needsForceConfirm({ probe: probeWith({ tx: cell('ok') }), duplicateOf: dup('content') })).toBe(false)
  })
})

describe('canForceProbe（「仍然判级」的按钮口径）', () => {
  const row = (over: Partial<Pick<DiscoveryCandidate, 'verdict' | 'scriptName' | 'sizeBytes'>> = {}) =>
    ({ verdict: 'not-source', scriptName: '聚合API', sizeBytes: 60 * 1024, ...over })

  it('像载荷的 not-source 才点亮：@name 非空 + 正文 20KB~1MB（闭区间）', () => {
    expect(canForceProbe(row())).toBe(true)
    expect(canForceProbe(row({ sizeBytes: 20 * 1024 }))).toBe(true)
    expect(canForceProbe(row({ sizeBytes: 1024 * 1024 }))).toBe(true)
  })

  it('碎屑和大块都不给点 —— 跑它们只是白打第三方取址接口', () => {
    expect(canForceProbe(row({ sizeBytes: 20 * 1024 - 1 }))).toBe(false)
    expect(canForceProbe(row({ sizeBytes: 1024 * 1024 + 1 }))).toBe(false)
    expect(canForceProbe(row({ sizeBytes: 0 }))).toBe(false)
  })

  it('没有 @name 不算载荷；这一档只管 not-source，pending/suspect 走原来的口', () => {
    expect(canForceProbe(row({ scriptName: '   ' }))).toBe(false)
    expect(canForceProbe(row({ verdict: 'pending' }))).toBe(false)
    expect(canForceProbe(row({ verdict: 'suspect' }))).toBe(false)
  })
})

describe('similarNameBadge（名字近似那句软提示）', () => {
  const similar = { path: 'custom-sources/lx-玉宁熙V1.2.2.js', name: 'lx-玉宁熙V1.2.2' }
  const cell = (outcome: string): ProbeCellView => ({ outcome, latencyMs: 120, container: null, reason: null })
  const probeWith = (cells: Record<string, ProbeCellView>) => ({ cells, shaVerified: true, note: null })
  const dup = (kind: 'content' | 'name') => ({ kind, path: 'custom-sources/a.js', name: '某源 v1' })

  it('没有硬撞车时才报近似；库里那条没名字就用路径顶上', () => {
    expect(similarNameBadge({ duplicateOf: null, similarTo: similar }))
      .toBe('库里有条名字近似的源 → lx-玉宁熙V1.2.2（可能是同一个源的另一个版本）')
    expect(similarNameBadge({ duplicateOf: null, similarTo: { path: 'custom-sources/无名.js', name: '' } }))
      .toBe('库里有条名字近似的源 → custom-sources/无名.js（可能是同一个源的另一个版本）')
  })

  it('已经有硬撞车就不补这句（同一格两句话会被读成两件事）；没提示对象也不渲染', () => {
    expect(similarNameBadge({ duplicateOf: dup('name'), similarTo: similar })).toBeNull()
    expect(similarNameBadge({ duplicateOf: dup('content'), similarTo: similar })).toBeNull()
    expect(similarNameBadge({ duplicateOf: null, similarTo: null })).toBeNull()
  })

  it('软提示不动判据：近似那条照常按红绿灯决定要不要二次确认，装不装由管理员定', () => {
    expect(needsForceConfirm({ probe: probeWith({ tx: cell('ok') }), duplicateOf: null })).toBe(false)
    expect(needsForceConfirm({ probe: probeWith({ tx: cell('timeout') }), duplicateOf: null })).toBe(true)
  })
})

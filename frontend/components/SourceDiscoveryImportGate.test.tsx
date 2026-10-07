/**
 * 「导入」这一档的判据测试（C 期：发现 → 判级 → 导入闭环）。
 *
 * 钉的是 UI 与服务端**口径一致**：服务端 `importCandidate` 要求"判级里至少一个平台真出货"，
 * 撞库里已有源时按种类分别处理（同内容直接不给装；同名由他选「替换导入」或「并排装」），
 * 面板按同一套话决定按钮长什么样、弹哪段确认。两边算得不一样时，
 * 管理员看到的是自相矛盾——按钮说能装，接口回 409。
 */

import { describe, expect, it } from 'vitest'
import type { DiscoveryCandidate, ProbeCellView } from '@/lib/api/admin-source-discovery'

const { okPlatformCount, needsProbeForce, importConfirmText, canForceProbe, similarNameBadge } = await import('@/components/admin/SourceDiscoveryPanel')

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

describe('needsProbeForce（判级那一档要不要二次确认）', () => {
  const probeWith = (cells: Record<string, ProbeCellView>) => ({ cells, shaVerified: true, note: null })

  it('判级有出货 ⇒ 不需要坚持；没出货或从没判过 ⇒ 需要', () => {
    expect(needsProbeForce({ probe: probeWith({ tx: cell('ok') }) })).toBe(false)
    expect(needsProbeForce({ probe: probeWith({ tx: cell('error') }) })).toBe(true)
    expect(needsProbeForce({ probe: null })).toBe(true)
  })

  it('撞不撞车不归它管 —— 撞同名现在走「替换导入 / 并排装」两个按钮，各有各的确认框', () => {
    expect(needsProbeForce({ probe: probeWith({ tx: cell('ok') }) })).toBe(false)
  })
})

describe('importConfirmText（撞同名那次导入前要说清的话）', () => {
  const probeWith = (cells: Record<string, ProbeCellView>) => ({ cells, shaVerified: true, note: null })
  const twin = (over: Partial<{ incomingVersion: string; currentVersion: string; lowerVersion: boolean }> = {}) => ({
    kind: 'name' as const, path: 'custom-sources/墨澜聚合音源 2.2.0.js', name: '墨澜聚合音源 2.2.0',
    incomingVersion: '2.3.4', currentVersion: '2.2.0', lowerVersion: false, ...over,
  })

  it('没撞车就没得确认（返回空串，调用处据此不弹框）', () => {
    expect(importConfirmText({ duplicateOf: null, probe: probeWith({ tx: cell('ok') }) }, 'plain')).toBe('')
    // 内容完全相同那一档按钮根本不渲染，这里也恒空，免得被读成"弹个空框就能装"
    expect(importConfirmText({ duplicateOf: { kind: 'content', path: 'a.js', name: 'A', incomingVersion: '', currentVersion: '', lowerVersion: false }, probe: probeWith({ tx: cell('ok') }) }, 'replace')).toBe('')
  })

  it('替换：说清换掉哪条、沿用顺位与平台白名单、旧脚本文件会删 —— 这三件都是不可逆的', () => {
    const text = importConfirmText({ duplicateOf: twin(), probe: probeWith({ tx: cell('ok') }) }, 'replace')
    expect(text).toContain('墨澜聚合音源 2.2.0')
    expect(text).toContain('沿用它的顺位、平台白名单与启停状态')
    expect(text).toContain('旧脚本文件一并删掉')
    expect(text).toContain('2.3.4')
    expect(text).not.toContain('倒退')
  })

  it('版本更低时多一句：这是倒退不是更新（只在服务端判出 lower 时出现）', () => {
    const text = importConfirmText(
      { duplicateOf: twin({ incomingVersion: '2.1.0', currentVersion: '2.2.0', lowerVersion: true }), probe: probeWith({ tx: cell('ok') }) },
      'replace')
    expect(text).toContain('这比库里那条低，是倒退不是更新')
  })

  it('并排装的代价是另一句话：共用健康账本那一格，不涉及删除', () => {
    const text = importConfirmText({ duplicateOf: twin(), probe: probeWith({ tx: cell('ok') }) }, 'parallel')
    expect(text).toContain('并排装两条')
    expect(text).toContain('共用那一格')
    expect(text).not.toContain('旧脚本文件一并删掉')
  })

  it('判级里没出货 ⇒ 两种 mode 都补一句"这次算对着红灯坚持装"，别让他点完才发现', () => {
    expect(importConfirmText({ duplicateOf: twin(), probe: probeWith({ tx: cell('timeout') }) }, 'replace'))
      .toContain('对着红灯坚持装')
    expect(importConfirmText({ duplicateOf: twin(), probe: probeWith({ tx: cell('timeout') }) }, 'parallel'))
      .toContain('对着红灯坚持装')
  })

  it('版本号缺失时写"未标"而不是留空 —— 空串会被读成"这条没版本信息"以外的意思', () => {
    const text = importConfirmText(
      { duplicateOf: twin({ incomingVersion: '', currentVersion: '', lowerVersion: false }), probe: probeWith({ tx: cell('ok') }) },
      'replace')
    expect(text).toContain('版本 未标')
    expect(text).toContain('这次装入的版本 未标')
  })
})

describe('canForceProbe（「仍然判级」的按钮口径）', () => {
  const row = (over: Partial<Pick<DiscoveryCandidate, 'verdict'>> = {}) => ({ verdict: 'obfuscated', ...over })

  it('只有「混淆载荷」那一档给点：档位是服务端分的，面板不再重算 @name 与体积', () => {
    expect(canForceProbe(row())).toBe(true)
    expect(canForceProbe(row({ verdict: 'suspect' }))).toBe(false)
    expect(canForceProbe(row({ verdict: 'not-source' }))).toBe(false)
    expect(canForceProbe(row({ verdict: 'pending' }))).toBe(false)
  })
})

describe('similarNameBadge（名字近似那句软提示）', () => {
  const similar = { path: 'custom-sources/lx-玉宁熙V1.2.2.js', name: 'lx-玉宁熙V1.2.2' }
  const cell = (outcome: string): ProbeCellView => ({ outcome, latencyMs: 120, container: null, reason: null })
  const probeWith = (cells: Record<string, ProbeCellView>) => ({ cells, shaVerified: true, note: null })
  const dup = (kind: 'content' | 'name') => ({ kind, path: 'custom-sources/a.js', name: '某源 v1', incomingVersion: '', currentVersion: '', lowerVersion: false })

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

  it('软提示不动判据：近似那条照常按红绿灯决定要不要坚持一次，装不装由管理员定', () => {
    expect(needsProbeForce({ probe: probeWith({ tx: cell('ok') }) })).toBe(false)
    expect(needsProbeForce({ probe: probeWith({ tx: cell('timeout') }) })).toBe(true)
  })
})

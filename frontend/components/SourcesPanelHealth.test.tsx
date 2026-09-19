/**
 * 音源面板「健康」列的渲染测试
 *
 * 用 react-dom/server 直接渲染单元格（不必为此引入测试库依赖，也不用 mock 整个面板的
 * 异步加载），钉住三件管理员会误读的事：
 * 1. 没有实测数据时显示「无实测」，而不是显示成坏
 * 2. 四个分档各自的中文标签与配色类
 * 3. 悬浮 title 里有窗口样本数、出货/坏/无地址计数与 p50/p90 延迟
 */

import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const { HealthCell } = await import('@/components/admin/SourcesPanel')
import type { SourceHealthView } from '@/lib/server/source-health'

function view(over: Partial<SourceHealthView>): SourceHealthView {
  return {
    source: '测试源',
    platform: 'kw',
    samples: 12,
    bad: 0,
    resolveOk: 10,
    badKinds: {},
    noMatch: 2,
    byteOk: 9,
    byteUnverified: 0,
    consecutiveBad: 0,
    latencyP50Ms: 321,
    latencyP90Ms: 474,
    lastBadReason: null,
    lastBadAt: null,
    lastOkAt: 1,
    coolingUntil: 0,
    retryAfterMs: 0,
    probing: false,
    backoffs: 0,
    band: 'healthy',
    ...over,
  }
}

const render = (health?: SourceHealthView[], pt?: string[]) =>
  renderToStaticMarkup(createElement(HealthCell, { health, pt }))

describe('HealthCell', () => {
  it('无实测数据 → 显示「无实测」，不给任何坏暗示', () => {
    const empty = render(undefined)
    expect(empty).toContain('无实测')
    expect(empty).not.toContain('冷却')
    expect(render([])).toContain('无实测')
  })

  it('四个分档各有中文标签与配色，且平台名走同一套标签', () => {
    const cases: Array<[SourceHealthView['band'], string, string]> = [
      ['healthy', '正常', 'text-green-600'],
      ['degraded', '波动', 'text-amber-600'],
      ['cooling', '冷却中', 'text-red-600'],
      ['no-data', '样本少', 'text-muted-foreground'],
    ]
    for (const [band, label, cls] of cases) {
      const html = render([view({ band })])
      expect(html).toContain(`酷我 ${label}`)
      expect(html).toContain(cls)
    }
  })

  it('悬浮 title 给出判定依据：窗口计数、分位数延迟、最近一次坏的原因', () => {
    const html = render([
      view({
        band: 'degraded',
        bad: 3,
        badKinds: { timeout: 2, 'byte:fake': 1 },
        lastBadReason: '识别到假地址：响应是文本/HTML/JSON',
        latencyP50Ms: 800,
        latencyP90Ms: 4200,
      }),
    ])
    expect(html).toContain('窗口 12 次')
    expect(html).toContain('出货 10')
    expect(html).toContain('坏 3')
    expect(html).toContain('无地址 2')
    expect(html).toContain('p50 800ms')
    expect(html).toContain('p90 4200ms')
    expect(html).toContain('最近一次坏：识别到假地址')
  })

  it('一个源多平台分别成签（kw 好、mg 坏不会互相盖掉）', () => {
    const html = render([
      view({ platform: 'kw', band: 'healthy' }),
      view({ platform: 'mg', band: 'cooling', bad: 4 }),
    ])
    expect(html).toContain('酷我 正常')
    expect(html).toContain('咪咕 冷却中')
  })

  // 3c 起「健康」列会说话，管理员要能从标签里读出现在到底在发生什么
  it('冷却中给出剩余秒数，并把"跳过"这件事说清楚', () => {
    const html = render([
      view({
        band: 'cooling',
        bad: 2,
        consecutiveBad: 2,
        coolingUntil: 1,
        retryAfterMs: 48_000,
        lastBadReason: '脚本内部报错',
      }),
    ])
    expect(html).toContain('酷我 冷却中 48s')
    expect(html).toContain('3c 已跳过该源')
    expect(html).toContain('48s 后放一次探测')
  })

  it('半开试探中与冷却倒计时是两种状态，不能混标', () => {
    const html = render([view({ band: 'cooling', coolingUntil: 1, retryAfterMs: 0, probing: true })])
    expect(html).toContain('酷我 冷却中·试探')
    expect(html).toContain('正在半开试探')
  })

  it('pt 不含的平台标「不测」，与「无实测」分开——前者不是坏', () => {
    const html = render([view({ platform: 'kw', band: 'healthy' })], ['kw', 'tx'])
    expect(html).toContain('酷我 正常')
    expect(html).toContain('腾讯 无实测') // pt 内但没样本
    expect(html).toContain('酷狗 不测')   // pt 外
    expect(html).toContain('咪咕 不测')
    expect(html).toContain('pt 未包含该平台')
  })

  it('完全没数据时仍然说明哪些平台压根不参与取址', () => {
    const html = render([], ['wy'])
    expect(html).toContain('无实测')
    expect(html).toContain('pt 不含：腾讯、酷我、酷狗、咪咕')
  })
})

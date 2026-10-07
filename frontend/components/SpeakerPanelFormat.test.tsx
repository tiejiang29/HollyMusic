/**
 * 小爱音箱面板（G0）的两个显示口径测试。
 *
 * 面板本身要等管理员真扫一次码才算验收，这里钉的是**不用扫码也能钉住**的那两件事：
 * 1. 票剩余时间的说法：不足 1 小时只报分，别写成"0 小时 12 分"这种没人说的话；
 * 2. 时间是 null / 不是合法时间时给 `—`，不许把 `Invalid Date` 印到面板上。
 *    （到期时间是续期判据的可视部分，它胡说了管理员就会以为"还有票"。）
 */

import { describe, expect, it } from 'vitest'

const { humanRemaining, clockText } = await import('@/components/admin/SpeakerPanel')

const MIN = 60 * 1000
const HOUR = 60 * MIN

describe('humanRemaining', () => {
  it('整小时只报时；跨过一小时才带上分', () => {
    expect(humanRemaining(2 * HOUR)).toBe('2 小时 0 分')
    expect(humanRemaining(2 * HOUR + 5 * MIN)).toBe('2 小时 5 分')
  })

  it('不足 1 小时只报分，不写"0 小时"', () => {
    expect(humanRemaining(59 * MIN + 59 * 1000)).toBe('59 分')
    expect(humanRemaining(30 * 1000)).toBe('0 分')
  })

  it('已过期的负数按 0 处理（面板另有"已过期"分支，这里不该出现"-3 分"）', () => {
    expect(humanRemaining(-3 * MIN)).toBe('0 分')
  })
})

describe('clockText', () => {
  it('合法 ISO 时间按本地时区显示', () => {
    const iso = '2026-10-08T07:12:01.000Z'
    expect(clockText(iso)).toBe(new Date(iso).toLocaleString())
  })

  it('没这个时间给 —，坏时间也给 —（不许把 Invalid Date 印到面板上）', () => {
    expect(clockText(null)).toBe('—')
    expect(clockText('')).toBe('—')
    expect(clockText('0000-00-00 00:00:00')).toBe('—')
  })
})

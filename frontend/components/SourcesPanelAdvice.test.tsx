/**
 * 音源管理面板里「周测建议」那两个纯函数。
 * 只钉两件事：标签表是一份（别在确认框与卡片里各写一套中文），
 * 以及一行文本的拼法 —— 固化摘要弹框靠它，写错了管理员看不清自己要改什么。
 */
import { describe, expect, it } from 'vitest'
import type { SourceAdvice } from '@/lib/api/admin-sources'

const { adviceKindLabel, adviceRowText } = await import('@/components/admin/SourcesPanel')

describe('adviceKindLabel', () => {
  it('三种建议各有短标签，认不出的类型原样回（不崩）', () => {
    expect(adviceKindLabel('add-pt')).toBe('放回平台')
    expect(adviceKindLabel('drop-pt')).toBe('摘掉平台')
    expect(adviceKindLabel('priority')).toBe('调整顺位')
    expect(adviceKindLabel('unknown' as SourceAdvice['kind'])).toBe('unknown')
  })
})

describe('adviceRowText', () => {
  it('源名 · 动作｜依据 一行摆全', () => {
    expect(adviceRowText({ source: '甲', action: '把 酷狗 加回支持平台', evidence: '4/4 出货，中位 320ms' }))
      .toBe('甲 · 把 酷狗 加回支持平台｜4/4 出货，中位 320ms')
  })
})

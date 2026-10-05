/**
 * 「导入」这一档的判据测试（C 期：发现 → 判级 → 导入闭环）。
 *
 * 钉的是 UI 与服务端**口径一致**：服务端 `importCandidate` 要求"判级里至少一个平台真出货"，
 * 面板也按同一句话决定按钮是直接导入还是要二次确认。两边算得不一样时，
 * 管理员看到的是自相矛盾——按钮说能装，接口回 409。
 */

import { describe, expect, it } from 'vitest'
import type { ProbeCellView } from '@/lib/api/admin-source-discovery'

const { okPlatformCount } = await import('@/components/admin/SourceDiscoveryPanel')

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

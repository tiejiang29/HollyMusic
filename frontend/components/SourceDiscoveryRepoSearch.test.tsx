/**
 * 「搜索 GitHub 仓库 → 勾选入清单」这一步的判据测试。
 *
 * 钉两件事：
 * 1) 面板算出来的清单必须和服务端存进去的是同一份（`saveDiscoverySettings` 也会 normalize+去重，
 *    两边不一致时管理员在文本框里看到的是假象）；
 * 2) 「最近推送」的年份口径 —— 我们上一次清理就是按"满一年没动"剔了 11 个仓，
 *    引进新仓时同一个尺子得亮在同一处，不然每加一个仓就悄悄给每轮多一次树调用。
 */

import { describe, expect, it } from 'vitest'

const { mergeRepos, repoAgeBadge } = await import('@/components/admin/SourceDiscoveryPanel')

const NOW = Date.parse('2026-10-05T12:00:00.000Z')

describe('mergeRepos', () => {
  it('保持原顺序、新的追加在后面、重复的不进第二次', () => {
    expect(mergeRepos(['a/b', 'c/d'], ['e/f', 'a/b'])).toEqual(['a/b', 'c/d', 'e/f'])
  })

  it('两边都空、含空白写法时不会造出个空字符串仓', () => {
    expect(mergeRepos([], ['  ', 'x/y'])).toEqual(['x/y'])
    expect(mergeRepos([], [])).toEqual([])
  })

  it('清单里已有的仓被勾上也不会把它挪到末尾（顺序就是扫描顺序，别悄悄改）', () => {
    expect(mergeRepos(['a/b', 'c/d', 'e/f'], ['c/d'])).toEqual(['a/b', 'c/d', 'e/f'])
  })
})

describe('repoAgeBadge', () => {
  it('一周内说"几天前动过"，一年内说几个月前', () => {
    expect(repoAgeBadge('2026-10-04T12:00:00.000Z', NOW)).toBe('1 天前动过')
    expect(repoAgeBadge('2026-09-05T12:00:00.000Z', NOW)).toBe('1 个月前')
  })

  it('满一年亮"停更 N 年+"（这是我们剔仓用的那把尺子）', () => {
    expect(repoAgeBadge('2025-10-05T12:00:00.000Z', NOW)).toBe('停更 1 年+')
    expect(repoAgeBadge('2023-01-01T00:00:00.000Z', NOW)).toBe('停更 3 年+')
  })

  it('没有推送时间或时间不可解析 ⇒ 空串，不编一个"停更 0 年"出来', () => {
    expect(repoAgeBadge('', NOW)).toBe('')
    expect(repoAgeBadge('不是时间', NOW)).toBe('')
    expect(repoAgeBadge('2027-01-01T00:00:00.000Z', NOW)).toBe('')
  })
})

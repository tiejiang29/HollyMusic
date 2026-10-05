/**
 * 「搜索 GitHub 仓库 → 勾选入清单」与「体检停更仓 → 勾选剔出清单」的判据测试。
 *
 * 钉三件事：
 * 1) 面板算出来的清单必须和服务端存进去的是同一份（`saveDiscoverySettings` 也会 normalize+去重，
 *    两边不一致时管理员在文本框里看到的是假象）；剔仓同理，而且**剔空要拦住** —— 清单一旦空了，
 *    「清理已移除仓的候选」就会把整张候选表当成失效仓删掉；
 * 2) 「最近推送」的年份口径 —— 我们上一次清理就是按"满一年没动"剔了 11 个仓，
 *    引进新仓时同一个尺子得亮在同一处，不然每加一个仓就悄悄给每轮多一次树调用；
 * 3) 体检行的结论要跟着**那次用的阈值**走，不能拿固定的 365 天去解释一个 200 天的判定。
 */

import { describe, expect, it } from 'vitest'

const { mergeRepos, repoAgeBadge, reposAfterRemoval, freshnessBadges } = await import('@/components/admin/SourceDiscoveryPanel')

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

describe('reposAfterRemoval', () => {
  it('只剔勾选的那些，顺序与其余的仓都不动', () => {
    expect(reposAfterRemoval(['a/b', 'c/d', 'e/f'], ['c/d'])).toEqual(['a/b', 'e/f'])
  })

  it('勾了清单里没有的名字不会凭空多删（面板与服务端各自都以清单为准）', () => {
    expect(reposAfterRemoval(['a/b'], ['a/b', 'ghost/x'])).toEqual([])
    expect(reposAfterRemoval(['a/b', 'c/d'], ['ghost/x'])).toEqual(['a/b', 'c/d'])
  })

  it('全剔就剩空数组 —— 面板要据此拦住（清空清单会让"清理候选"把整张表当失效仓删掉）', () => {
    expect(reposAfterRemoval(['a/b'], ['a/b'])).toEqual([])
  })
})

describe('freshnessBadges', () => {
  it('硬事实在前：消失/归档，再叠加超阈值', () => {
    expect(freshnessBadges({ daysSince: 1000, archived: false, missing: true, movedTo: '' }, 365)).toEqual(['已消失(404)', '停更 2 年+'])
    expect(freshnessBadges({ daysSince: 400, archived: true, missing: false, movedTo: '' }, 365)).toEqual(['已归档', '停更 1 年+'])
  })

  it('阈值用的是体检那一次的数：调到 200 天时 250 天没动的仓必须亮出来，不能显示"正常在更"', () => {
    expect(freshnessBadges({ daysSince: 250, archived: false, missing: false, movedTo: '' }, 200)).toEqual(['超阈值 250 天（阈值 200）'])
    expect(freshnessBadges({ daysSince: 250, archived: false, missing: false, movedTo: '' }, 365)).toEqual([])
  })

  it('读不到推送时间说的是"读不到"，不是"这仓很新"', () => {
    expect(freshnessBadges({ daysSince: null, archived: false, missing: false, movedTo: '' }, 365)).toEqual(['读不到推送时间'])
  })

  it('刚动过的仓没有任何标签（面板据此显示"正常在更"）；改名与超阈值可以同时出现', () => {
    expect(freshnessBadges({ daysSince: 3, archived: false, missing: false, movedTo: '' }, 365)).toEqual([])
    expect(freshnessBadges({ daysSince: 500, archived: false, missing: false, movedTo: 'new/name' }, 365)).toEqual(['停更 1 年+', '改名 → new/name'])
  })
})

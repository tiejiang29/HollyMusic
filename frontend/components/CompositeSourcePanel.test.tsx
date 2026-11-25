import { describe, expect, it } from 'vitest'
import {
  compositeMemberKey,
  compositeSourcePlatforms,
  toggleCompositeMember,
} from '@/components/admin/CompositeSourcePanel'
import type { AdminSource } from '@/lib/api/admin-sources'

function source(overrides: Partial<AdminSource> = {}): AdminSource {
  return {
    path: 'custom-sources/a.js',
    name: '源A',
    enabled: true,
    priority: 1,
    scriptExists: true,
    ...overrides,
  }
}

describe('复合源面板成员勾选', () => {
  it('同一音源不同平台是独立成员，重复勾选不会叠加', () => {
    const tx = { sourceName: '源A', platform: 'tx' as const }
    const wy = { sourceName: '源A', platform: 'wy' as const }
    let members = [tx]
    members = toggleCompositeMember(members, '源A', 'tx')
    expect(members).toEqual([])
    members = toggleCompositeMember(members, '源A', 'tx')
    members = toggleCompositeMember(members, '源A', 'wy')
    expect(members).toEqual([tx, wy])
    expect(new Set(members.map(compositeMemberKey)).size).toBe(2)
  })

  it('平台勾选只列脚本声明且未被 pt 摘掉的平台', () => {
    expect(compositeSourcePlatforms(source({
      supportedPlatforms: ['tx', 'wy', 'kg'],
      pt: ['tx', 'kg'],
    }))).toEqual(['tx', 'kg'])
  })

  it('脚本还没初始化时按 pt；两者都没有才显示五个平台', () => {
    expect(compositeSourcePlatforms(source({ pt: ['wy'] }))).toEqual(['wy'])
    expect(compositeSourcePlatforms(source())).toEqual(['tx', 'wy', 'kw', 'kg', 'mg'])
  })
})

import { describe, expect, it } from 'vitest'
import { apiCatalogUpdates, disableDuplicateExtras, filterApiInterfaces } from '@/components/admin/ApiCatalogPanel'
import type { ApiCatalogInterface } from '@/lib/api/admin-api-catalog'

function item(id: string, overrides: Partial<ApiCatalogInterface> = {}): ApiCatalogInterface {
  return {
    id,
    platform: 'tx',
    endpoint: 'https://api.example.com/song',
    method: 'GET',
    requestShapeHash: 'shape',
    dedupeKey: 'dedupe',
    keyHash: null,
    sources: ['杰翔音乐源'],
    enabled: true,
    callCount: 2,
    networkCount: 1,
    responseCount: 1,
    httpOkCount: 1,
    addressCount: 1,
    lastStatusCode: 200,
    lastContentType: 'application/json',
    lastBodyType: 'object',
    lastCode: '0',
    lastMsg: '访问成功',
    lastUrlExists: true,
    firstSeenAt: '2026-11-26T00:00:00.000Z',
    lastSeenAt: '2026-11-26T00:00:00.000Z',
    ...overrides,
  }
}

describe('接口目录面板筛选与批量选择', () => {
  const items = [
    item('a'.repeat(24)),
    item('b'.repeat(24), { platform: 'wy', sources: ['HelloWorld'], endpoint: 'https://wy.example.com/x', lastCode: '503', lastMsg: '系统运行错误' }),
    item('c'.repeat(24), { sources: ['杰翔音乐源', 'StellarWave'], keyHash: 'keyhash' }),
  ]

  it('平台与来源筛选同时生效', () => {
    expect(filterApiInterfaces(items, { platform: 'tx', source: 'StellarWave', query: '' }).map(row => row.id)).toEqual(['c'.repeat(24)])
    expect(filterApiInterfaces(items, { platform: 'wy', source: '杰翔音乐源', query: '' })).toEqual([])
  })

  it('搜索覆盖地址、业务消息与来源，不区分大小写', () => {
    expect(filterApiInterfaces(items, { platform: 'all', source: 'all', query: 'API.EXAMPLE' })).toHaveLength(2)
    expect(filterApiInterfaces(items, { platform: 'all', source: 'all', query: '系统' }).map(row => row.id)).toEqual(['b'.repeat(24)])
    expect(filterApiInterfaces(items, { platform: 'all', source: 'all', query: 'HELLOWORLD' })).toHaveLength(1)
  })

  it('重复组一键保留首条，只改组内身份', () => {
    const draft = disableDuplicateExtras({
      duplicateGroups: [{ dedupeKey: 'd', interfaceIds: ['a', 'b', 'c'], sources: ['源A', '源B'] }],
    }, { a: false, outside: false })
    expect(draft).toEqual({ a: true, b: false, c: false, outside: false })
  })

  it('只提交真正变化的开关，恢复原值不产生待保存项', () => {
    expect(apiCatalogUpdates(items, {})).toEqual([])
    expect(apiCatalogUpdates(items, { [items[0].id]: true })).toEqual([])
    expect(apiCatalogUpdates(items, { [items[0].id]: false, [items[1].id]: false })).toEqual([
      { id: items[0].id, enabled: false },
      { id: items[1].id, enabled: false },
    ])
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rows, prismaMock } = vi.hoisted(() => {
  const rows = new Map<string, Record<string, unknown>>()
  const prismaMock = {
    $transaction: vi.fn(async (operations: Promise<{ count: number }>[]) => Promise.all(operations)),
    apiInterfaceProbe: {
      findMany: vi.fn(async () => []),
    },
    apiInterface: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) || null),
      upsert: vi.fn(async ({ where, create, update }: {
        where: { id: string }
        create: Record<string, unknown>
        update: Record<string, unknown>
      }) => {
        const previous = rows.get(where.id) || {}
        const next = (rows.has(where.id) ? { ...previous, ...update } : { ...create }) as Record<string, unknown>
        for (const [key, value] of Object.entries(update)) {
          if (value && typeof value === 'object' && 'increment' in value) {
            next[key] = Number(previous[key] || 0) + Number((value as { increment: number }).increment)
          }
        }
        rows.set(where.id, next)
        return next
      }),
      findMany: vi.fn(async (args?: { where?: { enabled?: boolean } }) => {
        const values = [...rows.values()]
        return values
          .filter(row => args?.where?.enabled === undefined || row.enabled === args.where.enabled)
          .sort((a, b) => Number(b.lastSeenAt) - Number(a.lastSeenAt))
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: { enabled: boolean } }) => {
        let count = 0
        for (const id of where.id.in) {
          const row = rows.get(id)
          if (!row) continue
          row.enabled = data.enabled
          count++
        }
        return { count }
      }),
    },
  }
  return { rows, prismaMock }
})

vi.mock('../db', () => ({ prisma: prismaMock }))

import type { RuntimeApiLane } from './api-catalog'

const { getApiCatalog, getApiRequestPolicy, invalidateApiInterfacePolicy, recordRuntimeTrace, setApiInterfaceSelection } = await import('./api-catalog')

function lane(overrides: Partial<RuntimeApiLane> = {}): RuntimeApiLane {
  return {
    laneId: 'a'.repeat(24),
    interfaceId: '1'.repeat(24),
    dedupeKey: 'd'.repeat(24),
    endpoint: 'https://api.example.com/song',
    method: 'GET',
    requestShapeHash: 's'.repeat(24),
    keyHash: null,
    platform: 'tx',
    sourceName: '脚本内部名',
    callCount: 2,
    networkCount: 1,
    responseCount: 1,
    statusCode: 200,
    contentType: 'application/json',
    bodyType: 'object',
    code: '503',
    msg: '系统运行错误',
    urlExists: false,
    ...overrides,
  }
}

beforeEach(() => {
  rows.clear()
  vi.clearAllMocks()
  invalidateApiInterfacePolicy()
})

describe('运行时接口目录', () => {
  it('忽略不完整身份，完整 trace 使用配置源名覆盖脚本内部名', async () => {
    await recordRuntimeTrace({ lanes: [lane({ interfaceId: '' }), lane()] }, '杰翔音乐源')
    expect(prismaMock.apiInterface.upsert).toHaveBeenCalledTimes(1)
    expect(rows.get('1'.repeat(24))).toMatchObject({
      sourcesJson: JSON.stringify(['杰翔音乐源']),
      callCount: 2,
      networkCount: 1,
      httpOkCount: 1,
      lastCode: '503',
      lastUrlExists: false,
    })
  })

  it('同接口重复观察累加计数并合并来源，不覆盖启用状态', async () => {
    await recordRuntimeTrace({ lanes: [lane()] }, '源A')
    rows.get('1'.repeat(24))!.enabled = false
    await recordRuntimeTrace({ lanes: [lane({ callCount: 1, networkCount: 0, responseCount: 0 })] }, '源B')
    expect(rows.get('1'.repeat(24))).toMatchObject({
      sourcesJson: JSON.stringify(['源A', '源B']),
      enabled: false,
      callCount: 3,
      networkCount: 1,
      responseCount: 1,
      lastCode: '503',
    })
  })

  it('只有 HTTP 200 且给出地址才累加 addressCount', async () => {
    await recordRuntimeTrace({ lanes: [lane({ statusCode: 200, urlExists: true })] }, '源A')
    await recordRuntimeTrace({ lanes: [lane({ statusCode: 503, urlExists: true })] }, '源A')
    expect(rows.get('1'.repeat(24))).toMatchObject({ addressCount: 1, httpOkCount: 1, lastStatusCode: 503 })
  })

  it('按 dedupeKey 找出跨源同接口，平台不同仍保留独立身份', async () => {
    await recordRuntimeTrace({ lanes: [lane()] }, '源A')
    await recordRuntimeTrace({ lanes: [lane({ interfaceId: '2'.repeat(24), sourceName: '源B' })] }, '源B')
    await recordRuntimeTrace({ lanes: [lane({ interfaceId: '3'.repeat(24), platform: 'wy' })] }, '源C')
    const catalog = await getApiCatalog()
    expect(catalog.interfaces).toHaveLength(3)
    expect(catalog.duplicateGroups).toEqual([{
      dedupeKey: 'd'.repeat(24),
      interfaceIds: ['1'.repeat(24), '2'.repeat(24)],
      sources: ['源A', '源B'],
    }])
  })

  it('白名单缓存读取停用身份，保存后立即失效', async () => {
    await recordRuntimeTrace({ lanes: [lane()] }, '源A')
    expect(await getApiRequestPolicy()).toEqual({ disabledInterfaceIds: [] })
    await setApiInterfaceSelection([{ id: '1'.repeat(24), enabled: false }])
    expect(await getApiRequestPolicy()).toEqual({ disabledInterfaceIds: ['1'.repeat(24)] })
    await setApiInterfaceSelection([{ id: '1'.repeat(24), enabled: true }])
    expect(await getApiRequestPolicy()).toEqual({ disabledInterfaceIds: [] })
  })

  it('批量选择走单事务，重复 ID 以最后一次为准', async () => {
    await recordRuntimeTrace({ lanes: [lane()] }, '源A')
    expect(await setApiInterfaceSelection([
      { id: '1'.repeat(24), enabled: false },
      { id: '1'.repeat(24), enabled: true },
    ])).toBe(1)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(rows.get('1'.repeat(24))!.enabled).toBe(true)
  })
})

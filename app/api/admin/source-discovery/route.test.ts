/**
 * app/api/admin/source-discovery/route.ts 测试
 *
 * 两条要紧的断言：**非管理员一律 401/403**，以及 **token 永不回显**（GET/PUT 只给脱敏尾巴）。
 *
 * 只隔掉真正会出网/碰库的三样：鉴权、数据库、起跑一轮发现。配置读写走**真实**的
 * saveDiscoverySettings —— 否则"空串不改动"这类规则就变成在测 mock 自己。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

let authMode: 'admin' | 'user' | 'anonymous' = 'admin'

class MockAuthError extends Error {
  constructor(message = '未登录') { super(message); this.name = 'AuthError' }
}
class MockForbiddenError extends Error {
  constructor(message = '需要管理员') { super(message); this.name = 'ForbiddenError' }
}

vi.mock('@/lib/services/user-context', () => ({
  requireAdmin: vi.fn(async () => {
    if (authMode === 'anonymous') throw new MockAuthError('未登录')
    if (authMode === 'user') throw new MockForbiddenError('需要管理员权限')
    return { username: 'admin' }
  }),
  AuthError: MockAuthError,
  ForbiddenError: MockForbiddenError,
}))

const { db, runCrawl } = vi.hoisted(() => ({
  db: { setting: new Map<string, string>(), candidates: [] as Array<Record<string, unknown>> },
  runCrawl: vi.fn(async () => ({})),
}))

interface KeyWhere { where: { key: string } }
interface SettingUpsert extends KeyWhere { create: { value: string }; update?: { value?: string } }

vi.mock('@/lib/db', () => ({
  prisma: {
    appSetting: {
      findUnique: vi.fn(async ({ where }: KeyWhere) => (db.setting.has(where.key) ? { value: db.setting.get(where.key) } : null)),
      upsert: vi.fn(async ({ where, create, update }: SettingUpsert) => {
        db.setting.set(where.key, update?.value ?? create.value)
        return {}
      }),
    },
    sourceCandidate: {
      findMany: vi.fn(async () => db.candidates),
      groupBy: vi.fn(async () => []),
      update: vi.fn(async () => null),
    },
  },
}))

// 部分 mock：只换掉"真会打 GitHub"的那一个，其余保持实现原样
vi.mock('@/lib/services/source-discovery', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, runDiscoveryCrawl: runCrawl }
})

const { GET, POST, PUT } = await import('./route')
const { DISCOVERY_SETTING_KEY, saveDiscoverySettings } = await import('@/lib/services/source-discovery')

function request(method: string, body?: unknown): NextRequest {
  return new NextRequest(new URL('http://localhost/api/admin/source-discovery'), {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeEach(async () => {
  authMode = 'admin'
  db.setting.clear()
  db.candidates = []
  await saveDiscoverySettings({ enabled: true, repos: ['a/b'], githubToken: 'ghp_supersecret1234' })
})

describe('鉴权', () => {
  it('未登录 401、非管理员 403，三个方法都一样', async () => {
    for (const mode of ['anonymous', 'user'] as const) {
      authMode = mode
      const expected = mode === 'anonymous' ? 401 : 403
      expect((await GET(request('GET'))).status).toBe(expected)
      expect((await POST(request('POST', { action: 'crawl' }))).status).toBe(expected)
      expect((await PUT(request('PUT', { enabled: false }))).status).toBe(expected)
    }
    expect(runCrawl).not.toHaveBeenCalled()
  })
})

describe('token 不出网', () => {
  it('GET 的配置视图里没有原值，只有 hasToken 与脱敏尾巴', async () => {
    const payload = await (await GET(request('GET'))).json()

    expect(JSON.stringify(payload)).not.toContain('ghp_supersecret1234')
    expect(payload.data.settings.hasToken).toBe(true)
    expect(payload.data.settings.tokenTail).toBe('****1234')
    expect(payload.data.settings.githubToken).toBeUndefined()
    // 库里确实存了原值（否则脱敏就没意义），但它只待在服务侧
    expect(JSON.parse(db.setting.get(DISCOVERY_SETTING_KEY) || '{}').githubToken).toBe('ghp_supersecret1234')
  })

  it('PUT 保存后同样不回显，清空要走显式 clearToken', async () => {
    const save = await (await PUT(request('PUT', { githubToken: 'ghp_another9999' }))).json()
    expect(JSON.stringify(save)).not.toContain('ghp_another9999')
    expect(save.data.settings.tokenTail).toBe('****9999')

    const cleared = await (await PUT(request('PUT', { clearToken: true }))).json()
    expect(cleared.data.settings.hasToken).toBe(false)
    expect(cleared.data.settings.tokenTail).toBe('')
  })

  it('空字符串不算"改动"，免得面板回显时把它抹掉', async () => {
    const response = await (await PUT(request('PUT', { githubToken: '   ' }))).json()
    expect(response.data.settings.tokenTail).toBe('****1234')
  })

  it('仓库写法不合法的不入库，但要报回被拒的是哪几条', async () => {
    const result = await (await PUT(request('PUT', { repos: ['a/b', 'https://evil.test/x', 'foo/bar/baz'] }))).json()
    expect(result.data.settings.repos).toEqual(['a/b'])
    expect(result.data.rejected).toEqual(['https://evil.test/x', 'foo/bar/baz'])
  })
})

describe('动作校验', () => {
  it('未知动作 400，而不是默默什么都不做', async () => {
    const response = await POST(request('POST', { action: 'import' }))
    expect(response.status).toBe(400)
    expect((await response.json()).error.message).toContain('不支持的动作')
  })

  it('P0-a 里没有 import 这条路（导入是下一期，接口先不给）', async () => {
    for (const action of ['import', 'add-source', 'enable']) {
      expect((await POST(request('POST', { action }))).status).toBe(400)
    }
  })

  it('dismiss 缺 id 或 id 非法都 400', async () => {
    expect((await POST(request('POST', { action: 'dismiss' }))).status).toBe(400)
    expect((await POST(request('POST', { action: 'dismiss', id: 0 }))).status).toBe(400)
    expect((await POST(request('POST', { action: 'dismiss', id: 'abc' }))).status).toBe(400)
  })

  it('已经有一轮在跑时不再起重复任务', async () => {
    const response = await POST(request('POST', { action: 'crawl' }))
    expect(response.status).toBe(202)
    expect((await response.json()).data.started).toBe(true)
    expect(runCrawl).toHaveBeenCalledTimes(1)
  })
})

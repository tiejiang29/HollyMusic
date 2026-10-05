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

const { db, runCrawl, importCandidateMock, drainMock, stopMock, probeBatchMock, pruneMock, searchMock, freshnessMock } = vi.hoisted(() => ({
  db: { setting: new Map<string, string>(), candidates: [] as Array<Record<string, unknown>> },
  runCrawl: vi.fn(async () => ({})),
  importCandidateMock: vi.fn(),
  drainMock: vi.fn(async () => ({ rounds: 1, downloaded: 0, suspect: 0, notSource: 0, stale: 0, pendingLeft: 0, stopped: false, note: null })),
  stopMock: vi.fn(() => ({ stopping: true })),
  probeBatchMock: vi.fn(() => ({ started: true })),
  pruneMock: vi.fn(async () => ({ removed: 3, keptImported: [] })),
  searchMock: vi.fn(async () => ({
    total: 2, page: 1, pageSize: 30, sort: 'updated', incomplete: false,
    quota: { remaining: 27, limit: 30, resetAt: 0 },
    items: [{ repo: 'new/guy', description: '洛雪音源', stars: 3, lastPushAt: '2026-10-01T00:00:00Z', language: 'JavaScript', fork: false, archived: false, alreadyListed: false }],
  })),
  freshnessMock: vi.fn(async () => ({
    checked: 2, maxAgeDays: 365, quota: { remaining: 4990, limit: 5000, resetAt: 0 }, failed: [],
    items: [
      { repo: 'old/guy', lastPushAt: '2024-01-01T00:00:00Z', daysSince: 1000, stars: 0, archived: false, missing: false, movedTo: '', candidates: 6, stale: true },
      { repo: 'a/b', lastPushAt: '2026-10-01T00:00:00Z', daysSince: 4, stars: 9, archived: false, missing: false, movedTo: '', candidates: 3, stale: false },
    ],
  })),
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

// 部分 mock：只换掉"真会打 GitHub / 真会写生产配置"的那几个，其余保持实现原样
vi.mock('@/lib/services/source-discovery', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    runDiscoveryCrawl: runCrawl,
    searchGitHubRepos: searchMock,
    auditRepoFreshness: freshnessMock,
    runDiscoveryDrain: drainMock,
    requestDiscoveryStop: stopMock,
    importCandidate: importCandidateMock,
    startCandidateProbeBatch: probeBatchMock,
    pruneOrphanCandidates: pruneMock,
  }
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
  importCandidateMock.mockReset()
  // 这两个带默认实现（route 会 void 它们的返回值），只清调用记录、别把实现清没
  drainMock.mockClear()
  stopMock.mockClear()
  probeBatchMock.mockClear()
  pruneMock.mockClear()
  searchMock.mockClear()
  freshnessMock.mockClear()
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
    const response = await POST(request('POST', { action: 'delete-repo' }))
    expect(response.status).toBe(400)
    expect((await response.json()).error.message).toContain('不支持的动作')
  })

  it('别的动作名一律没有后门（enable/add-source 这类）', async () => {
    for (const action of ['add-source', 'enable', 'update']) {
      expect((await POST(request('POST', { action }))).status).toBe(400)
    }
  })

  it('import 只认 id：正文/URL 传了没人看，force 原样交给服务层', async () => {
    importCandidateMock.mockResolvedValue({ path: 'custom-sources/x.js', name: 'X 音源' })

    const response = await POST(request('POST', { action: 'import', id: 7, url: 'https://evil.test/a.js', content: 'boom' }))
    expect(response.status).toBe(200)
    expect((await response.json()).data.imported).toEqual({ id: 7, path: 'custom-sources/x.js', name: 'X 音源' })
    expect(importCandidateMock).toHaveBeenCalledWith(7, { force: false })

    await POST(request('POST', { action: 'import', id: 7, force: true }))
    expect(importCandidateMock).toHaveBeenLastCalledWith(7, { force: true })
  })

  it('import 缺 id 或 id 非法都 400，服务层一次都不碰', async () => {
    for (const body of [{ action: 'import' }, { action: 'import', id: 0 }, { action: 'import', id: 'abc' }]) {
      expect((await POST(request('POST', body))).status).toBe(400)
    }
    expect(importCandidateMock).not.toHaveBeenCalled()
  })

  it('服务层的拒绝按原状态码透出（409 判级没出货 / 已导入，不能压成 400）', async () => {
    const { SourceDiscoveryError } = await import('@/lib/services/source-discovery')
    importCandidateMock.mockRejectedValue(new SourceDiscoveryError('判级里没有一个平台真出货', 409))
    const response = await POST(request('POST', { action: 'import', id: 7 }))
    expect(response.status).toBe(409)
    expect((await response.json()).error.message).toContain('没有一个平台真出货')
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

  it('crawl 的 repos 只当"缩小子集"交给服务层；不给就是扫全清单', async () => {
    await POST(request('POST', { action: 'crawl', repos: ['x/y', 'a/b'] }))
    expect(runCrawl).toHaveBeenLastCalledWith({ onlyRepos: ['x/y', 'a/b'] })

    await POST(request('POST', { action: 'crawl' }))
    expect(runCrawl).toHaveBeenLastCalledWith({ onlyRepos: undefined })
  })

  it('search 把关键词、翻页、排序原样交给服务层，结果透出', async () => {
    const response = await POST(request('POST', { action: 'search', query: 'lxmusic source', page: 2, sort: 'stars' }))
    expect(response.status).toBe(200)
    expect(searchMock).toHaveBeenCalledWith('lxmusic source', 2, 'stars', undefined)
    const payload = await response.json()
    expect(payload.data.items[0].repo).toBe('new/guy')
    expect(payload.data.quota).toEqual({ remaining: 27, limit: 30, resetAt: 0 })
  })

  it('非管理员连搜都不给（搜索也是要出网的动作）', async () => {
    authMode = 'user'
    expect((await POST(request('POST', { action: 'search', query: 'lxmusic source' }))).status).toBe(403)
    expect(searchMock).not.toHaveBeenCalled()
  })

  it('搜索失败按服务层的状态码透出：429 被压成 400 就看不出"这是等一会儿的事"', async () => {
    const { SourceDiscoveryError } = await import('@/lib/services/source-discovery')
    searchMock.mockRejectedValueOnce(new SourceDiscoveryError('GitHub 搜索配额用尽', 429))
    const response = await POST(request('POST', { action: 'search', query: 'lxmusic source' }))
    expect(response.status).toBe(429)
    expect((await response.json()).error.message).toContain('配额用尽')
  })

  it('freshness（停更仓体检）把阈值交给服务层，报告原样透出', async () => {
    const response = await POST(request('POST', { action: 'freshness', maxAgeDays: 200 }))
    expect(response.status).toBe(200)
    expect(freshnessMock).toHaveBeenCalledWith(200)
    const payload = await response.json()
    expect(payload.data.items.map((i: { repo: string }) => i.repo)).toEqual(['old/guy', 'a/b'])
    expect(payload.data.items[0].candidates).toBe(6)
  })

  it('体检的配额不足也按 429 透出（它是 N 次仓库接口调用，不是免费的）', async () => {
    const { SourceDiscoveryError } = await import('@/lib/services/source-discovery')
    freshnessMock.mockRejectedValueOnce(new SourceDiscoveryError('GitHub API 余量 2，体检 3 个仓需要 3 次调用', 429))
    const response = await POST(request('POST', { action: 'freshness' }))
    expect(response.status).toBe(429)
  })

  it('非管理员不能触发体检（那是一轮真打 GitHub 的读操作）', async () => {
    authMode = 'user'
    expect((await POST(request('POST', { action: 'freshness' }))).status).toBe(403)
    expect(freshnessMock).not.toHaveBeenCalled()
  })

  it('drain（连轮清完）也是 202，不让人挂着请求等几十分钟', async () => {
    const response = await POST(request('POST', { action: 'drain' }))
    expect(response.status).toBe(202)
    expect((await response.json()).data.started).toBe(true)
    expect(drainMock).toHaveBeenCalledTimes(1)
  })

  it('probe-batch（批量判级）也是 202，一批在跑时回 started:false', async () => {
    const response = await POST(request('POST', { action: 'probe-batch' }))
    expect(response.status).toBe(202)
    expect(probeBatchMock).toHaveBeenCalledTimes(1)

    probeBatchMock.mockReturnValueOnce({ started: false, reason: '已有一批判级在跑' })
    const busy = await POST(request('POST', { action: 'probe-batch' }))
    expect(busy.status).toBe(200)
    expect((await busy.json()).data.started).toBe(false)
  })

  it('prune 把删掉的行数原样报回（管理员要知道清了多少，别只回一句成功）', async () => {
    const response = await POST(request('POST', { action: 'prune' }))
    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual({ removed: 3, keptImported: [] })
    expect(pruneMock).toHaveBeenCalledTimes(1)
  })

  it('stop 原样回服务层的判定（没在跑就是 stopping:false）', async () => {
    stopMock.mockReturnValueOnce({ stopping: false })
    const response = await POST(request('POST', { action: 'stop' }))
    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual({ stopping: false })
  })
})

describe('只取最新 release 这个开关', () => {
  it('默认开，且 GET 的配置视图里带得出来（面板那个勾选框要有依据）', async () => {
    const payload = await (await GET(request('GET'))).json()
    expect(payload.data.settings.preferLatestRelease).toBe(true)
  })

  it('PUT 关掉之后不回落到默认值：改一次就生效，别下次读又变回开', async () => {
    const off = await (await PUT(request('PUT', { preferLatestRelease: false }))).json()
    expect(off.data.settings.preferLatestRelease).toBe(false)

    const again = await (await GET(request('GET'))).json()
    expect(again.data.settings.preferLatestRelease).toBe(false)
  })

  it('非布尔的值不当成"关掉"：传字符串不改原值', async () => {
    await PUT(request('PUT', { preferLatestRelease: 'false' }))
    const after = await (await GET(request('GET'))).json()
    expect(after.data.settings.preferLatestRelease).toBe(true)
  })
})

describe('每轮抓正文上限', () => {
  it('可以调到 2000（清几千条存量时用），再大就夹住', async () => {
    const up = await (await PUT(request('PUT', { maxDownloadsPerRound: 2000 }))).json()
    expect(up.data.settings.maxDownloadsPerRound).toBe(2000)

    const over = await (await PUT(request('PUT', { maxDownloadsPerRound: 99999 }))).json()
    expect(over.data.settings.maxDownloadsPerRound).toBe(2000)
  })
})

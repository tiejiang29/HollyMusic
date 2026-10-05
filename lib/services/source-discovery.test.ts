/**
 * 音源发现（P0-a）的服务层测试。
 *
 * 两处刻意的做法：
 * - 把 safePublicFetch 桥到 global fetch 上（DNS 解析在测试里没有意义），但**请求形状**照验；
 * - 假脚本正文全部是本文件自己写的特征骨架，不引入任何真实音源脚本内容。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { prismaMock } = vi.hoisted(() => ({ prismaMock: { appSetting: {}, sourceCandidate: {} } as Record<string, Record<string, unknown>> }))

vi.mock('@/lib/db', () => ({ prisma: prismaMock }))
vi.mock('@/lib/server/url-guard', () => ({
  safePublicFetch: (url: string, init?: RequestInit) => fetch(url, init),
}))
vi.mock('@/lib/services/source-manager-service', () => ({
  parseScriptMeta: (content: string) => ({
    name: /@name\s+([^\r\n]+)/.exec(content)?.[1]?.trim(),
    version: /@version\s+([^\r\n]+)/.exec(content)?.[1]?.trim(),
  }),
}))

const {
  normalizeRepo, isPlausibleScriptPath, scoreCandidate, toNameKey, betterKeeper,
  runDiscoveryCrawl, saveDiscoverySettings, DEFAULT_DISCOVERY_SETTINGS,
} = await import('./source-discovery')

interface FetchCallPair { mock: { calls: Array<[string, RequestInit?]> } }
/** 读假 fetch 的调用记录：写清楚形状，比在每个断言里 cast any 好 */
const callsOf = (fn: unknown): Array<[string, RequestInit?]> => (fn as FetchCallPair).mock.calls

// ————— 内存假库 —————
interface Row { id: number; repo: string; path: string; [key: string]: unknown }
let rows: Row[] = []
let nextId = 1
const settingRows = new Map<string, string>()

interface KeyWhere { where: { key: string } }
interface SettingUpsert extends KeyWhere { create: { value: string }; update?: { value?: string } }
interface PathWhere { where: { repo_path: { repo: string; path: string } } }
interface CreateArgs { data: Record<string, unknown> }
interface UpdateArgs { where: { id?: number; repo_path?: { repo: string; path: string } }; data: Record<string, unknown> }

beforeEach(() => {
  rows = []
  nextId = 1
  settingRows.clear()
  prismaMock.appSetting.findUnique = vi.fn(async ({ where }: KeyWhere) =>
    settingRows.has(where.key) ? { value: settingRows.get(where.key) } : null)
  prismaMock.appSetting.upsert = vi.fn(async ({ where, create, update }: SettingUpsert) => {
    settingRows.set(where.key, update?.value ?? create.value)
    return {}
  })
  prismaMock.sourceCandidate.findUnique = vi.fn(async ({ where }: PathWhere) =>
    rows.find(r => r.repo === where.repo_path.repo && r.path === where.repo_path.path) ?? null)
  prismaMock.sourceCandidate.create = vi.fn(async ({ data }: CreateArgs) => {
    // 补齐 schema 里带 @default 的列：真库由 Prisma 填，假库要自己填，否则测不出真实形状
    const row = {
      blobSha: '', scriptName: '', nameKey: '', contentHash: '', upstreamAt: '', sizeBytes: 0, score: 0,
      verdict: 'pending', state: 'new', reason: null, checkedAt: null,
      id: nextId++, ...data,
    } as Row
    rows.push(row)
    return row
  })
  prismaMock.sourceCandidate.update = vi.fn(async ({ where, data }: UpdateArgs) => {
    const row = where.id !== undefined
      ? rows.find(r => r.id === where.id)
      : rows.find(r => where.repo_path && r.repo === where.repo_path.repo && r.path === where.repo_path.path)
    if (row) Object.assign(row, data)
    return row
  })
  prismaMock.sourceCandidate.findMany = vi.fn(async () => rows)
  prismaMock.sourceCandidate.groupBy = vi.fn(async () => [])
})

/** 我们自己的特征骨架：够过阈值，又不是任何真实脚本 */
const FAKE_SOURCE_SCRIPT = [
  '/**',
  ' * @name 合成测试音源 v1.2.0',
  ' * @version 1.2.0',
  ' */',
  "const lx = globalThis.lx",
  "const EVENT_NAMES = { inited: 'inited', request: 'request' }",
  "lx.on(EVENT_NAMES.request, async (querySource, info) => ({ type: 'url', url: 'https://example.test/1.mp3' }))",
  "lx.send(EVENT_NAMES.inited, { status: true, source: { kw: 1, tx: 1 } })",
].join('\n')

function jsonResponse(payload: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json', ...headers } })
}

async function enable(repos: string[], token = '') {
  await saveDiscoverySettings({ enabled: true, repos, githubToken: token })
}

// ————— 纯函数 —————
describe('normalizeRepo', () => {
  it('接受 owner/repo，顺带容忍完整网页地址与 .git 尾巴', () => {
    expect(normalizeRepo('foo/bar')).toBe('foo/bar')
    expect(normalizeRepo(' https://github.com/foo/bar ')).toBe('foo/bar')
    expect(normalizeRepo('git@github.com:foo/bar.git')).toBeNull() // ssh 形态不是我们要的
    expect(normalizeRepo('https://github.com/foo/bar.git')).toBe('foo/bar')
  })

  it('拒掉路径穿越、别的域名与空值（这是本模块唯一的自由文本入口）', () => {
    for (const bad of ['foo/bar/baz', '../etc/passwd', 'https://evil.test/foo/bar', '', 'foo', 'foo//bar']) {
      expect(normalizeRepo(bad), bad).toBeNull()
    }
  })
})

describe('isPlausibleScriptPath', () => {
  it('只要 .js，排掉构建产物与依赖目录', () => {
    expect(isPlausibleScriptPath('src/lx-source.js')).toBe(true)
    expect(isPlausibleScriptPath('长青音源.js')).toBe(true)
    expect(isPlausibleScriptPath('readme.md')).toBe(false)
    expect(isPlausibleScriptPath('node_modules/x/y.js')).toBe(false)
    expect(isPlausibleScriptPath('dist/bundle.js')).toBe(false)
    expect(isPlausibleScriptPath('webpack.config.js')).toBe(false)
  })
})

describe('scoreCandidate', () => {
  it('文件名像但没有脚本特征 ⇒ 不过阈值（光靠名字会把附带 js 收进来）', () => {
    const { score } = scoreCandidate('lx-music-source.js', 'console.log("hello")')
    expect(score).toBeLessThan(5)
  })

  it('真特征成组出现才过阈值，且理由可归因', () => {
    const { score, hits } = scoreCandidate('lx-music-source.js', FAKE_SOURCE_SCRIPT)
    expect(score).toBeGreaterThanOrEqual(5)
    expect(hits).toContain('globalThis.lx')
    expect(hits).toContain('EVENT_NAMES')
  })
})

describe('toNameKey', () => {
  it('换名重发（版本号与括号注记变化）要落到同一个键上', () => {
    expect(toNameKey('长青SVIP音源 v1.2.0')).toBe(toNameKey('长青SVIP音源（二改修复版） 1.3.0'))
    expect(toNameKey('屿溪-终章')).toBe('屿溪终章')
  })
})

describe('betterKeeper', () => {
  // 返回值口径：-1 表示**第一个**参数更该留下，1 表示第二个更该留下
  const base = { lastModified: '2026-10-01T00:00:00.000Z', scriptVersion: '1.0.0', score: 6, id: 1 }

  it('上游更新时间优先', () => {
    expect(betterKeeper({ ...base, lastModified: '2026-10-02T00:00:00.000Z' }, base)).toBe(-1)
    expect(betterKeeper(base, { ...base, lastModified: '2026-10-02T00:00:00.000Z' })).toBe(1)
  })

  it('更新时间相同看版本号（1.10.0 要大于 1.2.0，不能按字符串比）', () => {
    expect(betterKeeper({ ...base, scriptVersion: '1.2.0' }, { ...base, scriptVersion: '1.10.0' })).toBe(1)
  })

  it('版本也相同才看打分，再相同看 id（保证结果稳定不随查询顺序变）', () => {
    expect(betterKeeper({ ...base, score: 9 }, { ...base, score: 7 })).toBe(-1)
    expect(betterKeeper({ ...base, id: 5 }, { ...base, id: 3 })).toBe(1)
  })
})

// ————— 一轮发现的流程 —————
describe('runDiscoveryCrawl', () => {
  it('未启用就别打 GitHub（默认关是这条功能的护栏）', async () => {
    await saveDiscoverySettings({ enabled: false, repos: ['foo/bar'] })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(runDiscoveryCrawl()).rejects.toThrow(/未启用/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('配额不够时中止并报出差额，而不是硬打到 403', async () => {
    await enable(['a/b', 'c/d', 'e/f'])
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 2, limit: 60, reset: 0 } } })
      throw new Error(`不该再打了: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    await expect(runDiscoveryCrawl()).rejects.toThrow(/余量 2，本轮需要 3/)
  })

  it('树里的 .js 进候选，正文过阈值的判为疑似；非 .js 不收', async () => {
    await enable(['a/b'])
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 5000, limit: 5000, reset: 0 } } })
      if (url.includes('/git/trees/')) {
        return jsonResponse({ tree: [
          { path: 'lx-music-source.js', type: 'blob', sha: 'aaa', size: 500 },
          { path: 'README.md', type: 'blob', sha: 'bbb', size: 500 },
          { path: 'node_modules/dep/index.js', type: 'blob', sha: 'ccc', size: 500 },
          { path: 'huge.js', type: 'blob', sha: 'ddd', size: 3_000_000 },
        ], truncated: false })
      }
      if (url.endsWith('lx-music-source.js')) return new Response(FAKE_SOURCE_SCRIPT, { headers: { 'content-type': 'text/plain' } })
      throw new Error(`不该下载: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)

    const summary = await runDiscoveryCrawl()
    expect(summary.created).toBe(2) // 只有两个 .js 进候选
    expect(summary.suspect).toBe(1)
    expect(summary.notSource).toBe(1) // huge.js 按体积直接判非音源，且没被下载
    expect(rows.find(r => r.path === 'lx-music-source.js')?.verdict).toBe('suspect')
    expect(String(rows.find(r => r.path === 'huge.js')?.reason)).toContain('超过上限')
  })

  it('仓库树被截断要留在结论里，不能当"这个仓就这些"', async () => {
    await enable(['a/b'])
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 100, limit: 100, reset: 0 } } })
      if (url.includes('/git/trees/')) return jsonResponse({ tree: [{ path: 'x.js', type: 'blob', sha: 's1', size: 10 }], truncated: true })
      return new Response('console.log(1)', { headers: { 'content-type': 'text/plain' } })
    }))
    const summary = await runDiscoveryCrawl()
    expect(summary.truncatedRepos).toEqual(['a/b'])
  })

  it('blob sha 没变且已判过的，第二轮不再重下正文（配额与时间的节省点）', async () => {
    await enable(['a/b'])
    const tree = { tree: [{ path: 'lx-music-source.js', type: 'blob', sha: 'same', size: 500 }], truncated: false }
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 100, limit: 100, reset: 0 } } })
      if (url.includes('/git/trees/')) return jsonResponse(tree)
      return new Response(FAKE_SOURCE_SCRIPT, { headers: { 'content-type': 'text/plain' } })
    })
    vi.stubGlobal('fetch', fetch)

    await runDiscoveryCrawl()
    const downloadCalls = (pairs: Array<[string, RequestInit?]>) => pairs.filter(([url]) => url.endsWith('.js') && !url.includes('/git/trees/')).length
    const firstDownloads = downloadCalls(callsOf(fetch))
    fetch.mockClear()
    await runDiscoveryCrawl()
    const secondDownloads = downloadCalls(callsOf(fetch))

    expect(firstDownloads).toBe(1)
    expect(secondDownloads).toBe(0)
  })

  it('同名不同内容的候选只留一个，被顶掉的标 stale 不删行', async () => {
    await enable(['a/b', 'c/d'])
    const oldScript = FAKE_SOURCE_SCRIPT.replace('v1.2.0', 'v1.0.0').replace('1.2.0', '1.0.0')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 100, limit: 100, reset: 0 } } })
      if (url.includes('/git/trees/')) {
        const repo = url.includes('/a/b/') ? 'a/b' : 'c/d'
        return jsonResponse({ tree: [{ path: `${repo}.js`, type: 'blob', sha: repo === 'a/b' ? 'old' : 'new', size: 500 }], truncated: false })
      }
      // 两个仓给同一份 @name、不同版本号与不同上游时间 ⇒ 择优留新的那个
      const fromA = url.includes('/a/b/')
      return new Response(fromA ? oldScript : FAKE_SOURCE_SCRIPT, {
        headers: { 'content-type': 'text/plain', 'last-modified': fromA ? 'Mon, 01 Sep 2026 00:00:00 GMT' : 'Sun, 04 Oct 2026 00:00:00 GMT' },
      })
    }))

    const summary = await runDiscoveryCrawl()
    expect(summary.stale).toBe(1)
    expect(rows.filter(r => r.state === 'stale')).toHaveLength(1)
    expect(rows.find(r => r.state === 'new')?.scriptName).toContain('1.2.0')
    expect(rows.find(r => r.state === 'new')?.upstreamAt).toBe('Sun, 04 Oct 2026 00:00:00 GMT')
  })

  it('抓正文失败时保持 pending，不把临时故障固化成"非音源"', async () => {
    await enable(['a/b'])
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 100, limit: 100, reset: 0 } } })
      if (url.includes('/git/trees/')) return jsonResponse({ tree: [{ path: 'lx-source.js', type: 'blob', sha: 'x', size: 500 }], truncated: false })
      return new Response('nope', { status: 500 })
    }))
    await runDiscoveryCrawl()
    expect(rows[0].verdict).toBe('pending')
  })

  it('请求形状：api.github.com 走 Bearer，raw 地址按 owner/repo 逐段拼', async () => {
    await enable(['a/b'], 'ghp_testtoken')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 100, limit: 100, reset: 0 } } })
      if (url.includes('/git/trees/')) return jsonResponse({ tree: [{ path: 'lx-source.js', type: 'blob', sha: 'x', size: 40 }], truncated: false })
      return new Response(FAKE_SOURCE_SCRIPT, { headers: { 'content-type': 'text/plain' } })
    }))
    await runDiscoveryCrawl()

    const calls = callsOf(globalThis.fetch).map(([url]) => url)
    expect(calls.some(u => u === 'https://api.github.com/repos/a/b/git/trees/HEAD?recursive=1')).toBe(true)
    expect(calls.some(u => u === 'https://raw.githubusercontent.com/a/b/HEAD/lx-source.js')).toBe(true)
    const headers = callsOf(globalThis.fetch)[0][1]?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer ghp_testtoken')
  })

  it('默认值就是关着的（别因为合并了默认对象被打开）', () => {
    expect(DEFAULT_DISCOVERY_SETTINGS.enabled).toBe(false)
  })
})

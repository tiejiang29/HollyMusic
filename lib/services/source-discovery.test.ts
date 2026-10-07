/**
 * 音源发现（P0-a 发现 / P0-b 判级 / P0-c 导入）的服务层测试。
 *
 * 两处刻意的做法：
 * - 把 safePublicFetch 桥到 global fetch 上（DNS 解析在测试里没有意义），但**请求形状**照验；
 * - 假脚本正文全部是本文件自己写的特征骨架，不引入任何真实音源脚本内容。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
import path from 'node:path'

const { prismaMock, importSubscriptionMock, readConfigMock, fsReadFileMock } = vi.hoisted(() => ({
  prismaMock: { appSetting: {}, sourceCandidate: {} } as Record<string, Record<string, unknown>>,
  importSubscriptionMock: vi.fn(),
  readConfigMock: vi.fn(async () => ({ sources: [] as Array<{ path: string; name?: string }> })),
  fsReadFileMock: vi.fn(async () => '' as string),
}))

// 已装源的内容哈希要读盘，这里隔掉：脚本正文由测试自己给
vi.mock('node:fs/promises', () => ({ default: { readFile: fsReadFileMock } }))

vi.mock('@/lib/db', () => ({ prisma: prismaMock }))
vi.mock('@/lib/server/url-guard', () => ({
  safePublicFetch: (url: string, init?: RequestInit) => fetch(url, init),
}))
vi.mock('@/lib/services/source-manager-service', () => ({
  parseScriptMeta: (content: string) => ({
    name: /@name\s+([^\r\n]+)/.exec(content)?.[1]?.trim(),
    version: /@version\s+([^\r\n]+)/.exec(content)?.[1]?.trim(),
  }),
  // 导入通道本身有它自己的测试，这里只关心发现层怎么调它（地址与 sha 从哪来、几时不给调）
  importSubscription: importSubscriptionMock,
  // "已导入"的判据看配置文件，不是候选状态 —— 用它来演"源被删了"的两种局面
  readConfig: readConfigMock,
  SOURCE_MANAGER_CONSTANTS: { SCRIPTS_DIR: path.resolve(process.cwd(), 'custom-sources') },
  SourceSubscriptionError: class SourceSubscriptionError extends Error {
    readonly status: number
    constructor(message: string, status = 422) {
      super(message)
      this.name = 'SourceSubscriptionError'
      this.status = status
    }
  },
}))

const { probeDeps } = vi.hoisted(() => ({
  probeDeps: {
    pickProbeSamples: vi.fn(async () => ({
      tx: [{ source: 'tx', songmid: 'sample-1', songId: '8136', name: '样本歌', singer: '样本歌手', interval: '180', types: [], _types: {}, typeUrl: {} }],
    })),
    verifyHead: vi.fn(async () => ({ outcome: 'ok' as const, reason: null, container: 'mp3' as const })),
  },
}))

vi.mock('./source-probe', () => probeDeps)

const {
  normalizeRepo, isPlausibleScriptPath, scoreCandidate, toNameKey, betterKeeper, toIsoTime,
  searchGitHubRepos, sanitizeRepoQuery, repoSearchItemFromApi,
  auditRepoFreshness, daysSincePush, verifyContentAnchor, assetDigestHex,
  pickReleaseAssets, fetchCandidateContent,
  runDiscoveryCrawl, saveDiscoverySettings, DEFAULT_DISCOVERY_SETTINGS,
  probeCandidate, importCandidate, dismissCandidate, listCandidates,
  shipmentOf, reopenCandidatesForRemovedSource,
  looksLikeObfuscatedSource,
  runDiscoveryDrain, requestDiscoveryStop, discoveryStatus,
  startCandidateProbe, startCandidateProbeBatch, pruneOrphanCandidates, _setProbeGapForTest, _setRunnerForTest,
} = await import('./source-discovery')
const { gitBlobSha } = await import('@/lib/server/git-blob-sha')

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
  importSubscriptionMock.mockReset()
  readConfigMock.mockReset()
  readConfigMock.mockResolvedValue({ sources: [] })
  fsReadFileMock.mockReset()
  fsReadFileMock.mockResolvedValue('')
  prismaMock.appSetting.findUnique = vi.fn(async ({ where }: KeyWhere) =>
    settingRows.has(where.key) ? { value: settingRows.get(where.key) } : null)
  prismaMock.appSetting.upsert = vi.fn(async ({ where, create, update }: SettingUpsert) => {
    settingRows.set(where.key, update?.value ?? create.value)
    return {}
  })
  prismaMock.sourceCandidate.findUnique = vi.fn(async (args: PathWhere | { where: { id: number } }) => {
    const where = args.where as { id?: number; repo_path?: { repo: string; path: string } }
    // 返回**快照**而不是行本身的引用：真 Prisma 每次查都是新对象，
    // 给引用的话"先改行再比较"这种自毁式顺序在测试里会看不出来
    if (typeof where.id === 'number') {
      const hit = rows.find(r => r.id === where.id)
      return hit ? { ...hit } : null
    }
    const target = where.repo_path!
    const hit = rows.find(r => r.repo === target.repo && r.path === target.path)
    return hit ? { ...hit } : null
  })
  prismaMock.sourceCandidate.create = vi.fn(async ({ data }: CreateArgs) => {
    // 补齐 schema 里带 @default 的列：真库由 Prisma 填，假库要自己填，否则测不出真实形状
    const row = {
      blobSha: '', scriptName: '', nameKey: '', contentHash: '', upstreamAt: '', sizeBytes: 0, score: 0,
      assetDigest: '', releaseTag: '', zipMember: '',
      verdict: 'pending', state: 'new', reason: null, checkedAt: null, probeJson: '', importedPath: '',
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
  // findMany 要**真的按 where 筛**：批量判级靠 `probeJson` 挑该判的，装样子就等于在测假库
  prismaMock.sourceCandidate.findMany = vi.fn(async (args?: {
    where?: Record<string, unknown> & { OR?: Array<Record<string, unknown>> }
    take?: number
  }) => {
    const where = (args?.where ?? {}) as {
      verdict?: string; state?: string; probeJson?: string; OR?: Array<Record<string, unknown>>
      repo?: string; releaseTag?: string; assetDigest?: string; zipMember?: string; importedPath?: string
      NOT?: { repo?: { in?: string[] } }
    }
    let out = rows
    // 字符串列一律真按等值筛（"包没换就跳过下载"那条判据靠 repo+tag+digest 三者同时命中；
    //  「源删了写回候选行」那条靠 importedPath 命中，漏了它就会变成"动了全表"）
    for (const key of ['repo', 'releaseTag', 'assetDigest', 'zipMember', 'importedPath'] as const) {
      const value = where[key]
      if (typeof value === 'string') out = out.filter(r => String(r[key] ?? '') === value)
    }
    if (where.NOT?.repo?.in) {
      const listed = new Set(where.NOT.repo.in)
      out = out.filter(r => !listed.has(r.repo))
    }
    if (where.verdict) out = out.filter(r => r.verdict === where.verdict)
    if (where.state) out = out.filter(r => r.state === where.state)
    if (where.probeJson !== undefined) out = out.filter(r => r.probeJson === where.probeJson)
    if (where.OR) {
      // 分支内是 AND、分支间是 OR：按真 Prisma 的语义逐字段比，别只认 probeJson
      // （批量判级用 `probeJson` 挑该判的，「仍然判级」补跑去重用 `{id}` + `{verdict, contentHash/nameKey}`，
      //  只写 probeJson 的话新那条会匹配到全表，等于测了个假库）
      const match = (row: Row, branch: Record<string, unknown>) => Object.entries(branch).every(([field, want]) => {
        const got = String(row[field] ?? '')
        if (want && typeof want === 'object') {
          const contains = (want as { contains?: string }).contains
          return contains ? got.includes(contains) : true
        }
        return got === String(want)
      })
      out = out.filter(row => where.OR!.some(branch => match(row, branch)))
    }
    return typeof args?.take === 'number' ? out.slice(0, args.take) : out
  })
  // groupBy 要真的按 by 聚合：体检"每个仓还剩多少候选行"靠的就是这份数，装样子就测不出它
  prismaMock.sourceCandidate.groupBy = vi.fn(async ({ by }: { by: string[] }) => {
    const SEP = String.fromCharCode(1)
    const keyOf = (row: Row) => by.map(field => String(row[field] ?? '')).join(SEP)
    const grouped = new Map<string, number>()
    for (const row of rows) grouped.set(keyOf(row), (grouped.get(keyOf(row)) ?? 0) + 1)
    return [...grouped.entries()].map(([key, n]) => {
      const parts = key.split(SEP)
      const out: Record<string, unknown> = { _count: { id: n } }
      by.forEach((field, i) => { out[field] = parts[i] })
      return out
    })
  })
  prismaMock.sourceCandidate.count = vi.fn(async () => rows.filter(r => r.verdict === 'pending').length)
  // deleteMany 要真的把行从数组里摘掉，否则"清掉了"这句就只是断言一个返回数
  prismaMock.sourceCandidate.deleteMany = vi.fn(async ({ where }: { where: { id: { in: number[] } } }) => {
    const gone = new Set(where.id.in)
    const before = rows.length
    rows = rows.filter(r => !gone.has(r.id))
    return { count: before - rows.length }
  })
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

  it('`..` 单独占一段也是穿越：encodeURIComponent 不编码点，URL 会自己把 /repos/../ 折叠掉', () => {
    // 实测形状：new URL('https://api.github.com/repos/../etc/git/trees/HEAD').pathname === '/etc/git/trees/HEAD'
    for (const bad of ['../etc', 'foo/..', '../..', '..../x']) {
      expect(normalizeRepo(bad), bad).toBeNull()
    }
    expect(new URL('https://api.github.com/repos/../etc/git/trees/HEAD').pathname).toBe('/etc/git/trees/HEAD')
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

  it('两种来源格式混存时按真实时间比，不按字典序 —— HTTP 日期不能因为首字母是 T 就永远赢', () => {
    const httpDate = 'Tue, 08 Sep 2026 11:23:39 GMT'
    const isoNewer = '2026-10-01T00:00:00Z'
    // 字典序里 'T…' > '2…'，这条会判反
    expect(betterKeeper({ ...base, lastModified: httpDate }, { ...base, lastModified: isoNewer })).toBe(1)
    expect(betterKeeper({ ...base, lastModified: isoNewer }, { ...base, lastModified: httpDate })).toBe(-1)
  })

  it('时间读不出的按"最旧"处理，不能顶掉有时间的', () => {
    expect(betterKeeper({ ...base, lastModified: '' }, base)).toBe(1)
    expect(betterKeeper({ ...base, lastModified: '不是时间' }, base)).toBe(1)
  })
})

describe('toIsoTime', () => {
  it('HTTP 日期与 ISO 都归一成 ISO；解析不出就留空串', () => {
    expect(toIsoTime('Tue, 08 Sep 2026 11:23:39 GMT')).toBe('2026-09-08T11:23:39.000Z')
    expect(toIsoTime('2026-09-08T11:23:47Z')).toBe('2026-09-08T11:23:47.000Z')
    expect(toIsoTime('')).toBe('')
    expect(toIsoTime('不是时间')).toBe('')
    expect(toIsoTime(undefined)).toBe('')
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
    expect(discoveryStatus().lastError).toContain('未启用')
  })

  it('配额不够时中止并报出差额，而不是硬打到 403', async () => {
    await enable(['a/b', 'c/d', 'e/f'])
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 2, limit: 60, reset: 0 } } })
      throw new Error(`不该再打了: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    // 走 release 的仓最多两次接口调用（发布 + 回落时的树），预检按最坏情况算，不能按 1 次骗自己
    await expect(runDiscoveryCrawl()).rejects.toThrow(/余量 2，本轮最多需要 6 次/)
  })

  it('关掉"只取最新 release"后，预检回到一个仓一次调用', async () => {
    await saveDiscoverySettings({ enabled: true, repos: ['a/b', 'c/d', 'e/f'], preferLatestRelease: false })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 2, limit: 60, reset: 0 } } })
      throw new Error(`不该再打了: ${url}`)
    }))
    await expect(runDiscoveryCrawl()).rejects.toThrow(/余量 2，本轮最多需要 3 次/)
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
    // 存的是**响应头那个时间**（不是我们写入的时间），并归一成 ISO —— 两种来源格式混存时字典序会判反
    expect(rows.find(r => r.state === 'new')?.upstreamAt).toBe('2026-10-04T00:00:00.000Z')
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

  it('token 只跟 api.github.com 走：raw 与 release 下载都不带 Authorization', async () => {
    await enable(['a/b'], 'ghp_testtoken')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 100, limit: 100, reset: 0 } } })
      if (url.includes('/releases?per_page=')) {
        return jsonResponse([{ tag_name: 'v1', published_at: '2026-10-01T00:00:00Z', prerelease: false, assets: [{ name: 's.js', size: 40, digest: `sha256:${'a'.repeat(64)}` }] }])
      }
      return new Response(FAKE_SOURCE_SCRIPT, { headers: { 'content-type': 'text/plain' } })
    }))
    await runDiscoveryCrawl()

    const calls = callsOf(globalThis.fetch)
    const api = calls.filter(([u]) => String(u).startsWith('https://api.github.com'))
    const others = calls.filter(([u]) => !String(u).startsWith('https://api.github.com'))
    // 两边都得真有调用，否则这个断言就成了空转
    expect(api.length).toBeGreaterThan(0)
    expect(others.some(([u]) => String(u).startsWith('https://github.com/'))).toBe(true)
    for (const [, init] of api) expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer ghp_testtoken')
    for (const [, init] of others) expect((init?.headers as Record<string, string>).Authorization, String(init?.headers)).toBeUndefined()
  })

  it('默认值就是关着的（别因为合并了默认对象被打开）', () => {
    expect(DEFAULT_DISCOVERY_SETTINGS.enabled).toBe(false)
  })
  it('默认仓库清单：形状全都合法、无重复（混进一个拼不出地址的项就会白扣配额）', () => {
    const repos = DEFAULT_DISCOVERY_SETTINGS.repos
    expect(repos.length).toBeGreaterThan(30)
    for (const repo of repos) expect(normalizeRepo(repo), repo).toBe(repo)
    expect(new Set(repos).size).toBe(repos.length)
  })
})
// ————— P0-b：一次性子进程判级 —————
const RAW_URL = 'https://raw.githubusercontent.com/a/b/HEAD/lx-source.js'

function seedSuspect(over: Partial<Row> = {}): number {
  const row = {
    id: nextId++, repo: 'a/b', path: 'lx-source.js', rawUrl: RAW_URL, blobSha: '',
    assetDigest: '', releaseTag: '', zipMember: '',
    scriptName: '合成测试音源 v1.2.0', nameKey: '合成测试音源', contentHash: '', upstreamAt: '',
    sizeBytes: 400, score: 8, verdict: 'suspect', state: 'new', reason: null,
    probeJson: '', probedAt: null, checkedAt: null, importedPath: '', ...over,
  } as Row
  rows.push(row)
  return row.id
}

function stubRawFetch(text: string) {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 100, limit: 100, reset: 0 } } })
    return new Response(text, { headers: { 'content-type': 'text/plain' } })
  })
}

/** 假的一次性子进程通道（真身是 runner-client 的 probeScript/validateScript） */
function fakeRunner(options: { loadOk?: boolean; loadError?: string; probeImpl?: () => Promise<unknown> } = {}) {
  return {
    mode: 'process',
    validateScript: vi.fn(async () => (options.loadOk === false
      ? { ok: false, error: options.loadError ?? '脚本没发 inited' }
      : { ok: true, sourceInfo: { sources: { tx: {} } } })),
    probeScript: vi.fn(options.probeImpl ?? (async () => ({ ok: true, sourceInfo: {}, callValue: 'https://cdn.example.test/play.mp3' }))),
  }
}

describe('probeCandidate', () => {
  beforeEach(() => {
    probeDeps.verifyHead.mockClear()
    _setRunnerForTest(null)
  })

  it('blob sha 与 tree 不一致 ⇒ 一次都不交给子进程执行，并把拒绝理由落库', async () => {
    const id = seedSuspect({ blobSha: '0'.repeat(40) })
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))
    const runner = fakeRunner()
    _setRunnerForTest(runner)

    const report = await probeCandidate(id)
    expect(report.shaVerified).toBe(false)
    expect(report.note).toContain('拒绝执行')
    expect(runner.validateScript).not.toHaveBeenCalled()
    expect(runner.probeScript).not.toHaveBeenCalled()
    expect(String(rows.find(r => r.id === id)?.probeJson)).toContain('拒绝执行')
  })

  it('sha 对得上才执行：先加载拿平台声明，再逐平台真取一次址 + 首块魔数', async () => {
    const id = seedSuspect({ blobSha: gitBlobSha(FAKE_SOURCE_SCRIPT) })
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))
    const runner = fakeRunner()
    _setRunnerForTest(runner)

    const report = await probeCandidate(id)
    expect(report.shaVerified).toBe(true)
    expect(report.cells.tx?.outcome).toBe('ok')
    expect(report.cells.tx?.container).toBe('mp3')
    expect(report.note).toBe('1/1 个平台真出货')
    expect(runner.validateScript).toHaveBeenCalledTimes(1)
    expect(runner.probeScript).toHaveBeenCalledTimes(1)
    expect(runner.probeScript.mock.calls[0][1]).toMatchObject({ source: 'tx', quality: '320k' })
    expect(probeDeps.verifyHead).toHaveBeenCalledWith('https://cdn.example.test/play.mp3')
  })

  it('tree 没给 sha 时无从校验：照判，但 shaVerified 留成 null（面板要分得开"验过"和"没法验"）', async () => {
    const id = seedSuspect({ blobSha: '' })
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))
    _setRunnerForTest(fakeRunner())
    const report = await probeCandidate(id)
    expect(report.shaVerified).toBeNull()
  })

  it('脚本初始化失败记 load-failed，且绝不再去取址', async () => {
    const id = seedSuspect({ blobSha: gitBlobSha(FAKE_SOURCE_SCRIPT) })
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))
    const runner = fakeRunner({ loadOk: false, loadError: '脚本没发 inited' })
    _setRunnerForTest(runner)

    const report = await probeCandidate(id)
    expect(report.cells['_']?.outcome).toBe('load-failed')
    expect(report.note).toContain('初始化失败')
    expect(runner.probeScript).not.toHaveBeenCalled()
  })

  it('inline 模式拒绝判级：跑不可信代码没有隔离可言', async () => {
    const id = seedSuspect({ blobSha: gitBlobSha(FAKE_SOURCE_SCRIPT) })
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))
    const runner = { ...fakeRunner(), mode: 'inline' }
    _setRunnerForTest(runner)

    const report = await probeCandidate(id)
    expect(report.note).toContain('inline')
    expect(runner.validateScript).not.toHaveBeenCalled()
  })

  it('脚本说"这首歌我没有"归 no-address，不计成脚本报错（与账本口径一致）', async () => {
    const id = seedSuspect({ blobSha: gitBlobSha(FAKE_SOURCE_SCRIPT) })
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))
    _setRunnerForTest(fakeRunner({
      probeImpl: async () => ({ ok: true, sourceInfo: {}, callError: '无版权，无法播放' }),
    }))
    const report = await probeCandidate(id)
    expect(report.cells.tx?.outcome).toBe('no-address')
  })

  it('下载失败时抛错且不落任何结论（网络抖动不该被固化成"这源不行"）', async () => {
    const id = seedSuspect({ blobSha: 'x' })
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.endsWith('/rate_limit')
        ? jsonResponse({ resources: { core: { remaining: 100, limit: 100, reset: 0 } } })
        : new Response('nope', { status: 404 })))
    const runner = fakeRunner()
    _setRunnerForTest(runner)

    await expect(probeCandidate(id)).rejects.toThrow(/HTTP 404/)
    expect(runner.validateScript).not.toHaveBeenCalled()
    expect(rows.find(r => r.id === id)?.probeJson).toBe('')
  })

  it('只给"疑似音源"判级：pending 直接拒', async () => {
    const id = seedSuspect({ verdict: 'pending' })
    await expect(probeCandidate(id)).rejects.toThrow(/疑似音源/)
  })

  it('「仍然判级」：像载荷的 not-source 允许 force 跑，真出货就提升为疑似可用并把来源写进依据', async () => {
    const id = seedSuspect({
      verdict: 'not-source', score: 2, sizeBytes: 60 * 1024, blobSha: gitBlobSha(FAKE_SOURCE_SCRIPT),
    })
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))
    _setRunnerForTest(fakeRunner())

    const report = await probeCandidate(id, { force: true })
    expect(report.cells.tx?.outcome).toBe('ok')
    const row = rows.find(r => r.id === id)!
    expect(row.verdict).toBe('suspect')
    expect(String(row.reason)).toContain('仍然判级')
    expect(String(row.reason)).toContain('1/1 个平台真出货')
  })

  it('提升等级时顺带并组：赢家（上游时间新的那条）留在册，输家标 stale 并把数量写进依据', async () => {
    const sha = gitBlobSha(FAKE_SOURCE_SCRIPT)
    // 在册的另一条同名候选，上游时间更新 ⇒ 按 betterKeeper 第一档它就是赢家
    const keeper = seedSuspect({
      nameKey: '玉宁熙pro', scriptName: 'lx-玉宁熙-Pro v1.2.5', contentHash: 'hash-125',
      upstreamAt: '2026-10-03T00:00:00Z', path: 'V261003.zip!V261003/lx-玉宁熙1.2.5.js',
    })
    const id = seedSuspect({
      verdict: 'not-source', score: 2, sizeBytes: 60 * 1024, blobSha: sha,
      nameKey: '玉宁熙pro', scriptName: 'lx-玉宁熙-Pro v1.2.2', contentHash: 'hash-122', upstreamAt: '',
    })
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))
    _setRunnerForTest(fakeRunner())

    await probeCandidate(id, { force: true })
    const promoted = rows.find(r => r.id === id)!
    expect(promoted.verdict).toBe('suspect')
    // 它是输家：等级照样提上来，但状态是被顶掉，「疑似可用」里只剩那一条更新的同名源
    expect(promoted.state).toBe('stale')
    expect(String(promoted.reason)).toContain('同名的另一条上游更新')
    expect(String(promoted.reason)).not.toContain('顺带顶掉')
    expect(rows.find(r => r.id === keeper)!.state).toBe('new')
    expect(String(rows.find(r => r.id === keeper)!.reason)).not.toContain('仍然判级')
  })

  it('并组时同内容（sha256）也算，即使名字不一样；not-source 的同行不进池子（判据没写宽）', async () => {
    const sha = gitBlobSha(FAKE_SOURCE_SCRIPT)
    const twin = seedSuspect({ nameKey: '别的源', scriptName: '另一个名字 v9', contentHash: 'same-hash' })
    // 同字节但还没判成疑似的一行：不该被卷进这次比较
    const notSuspect = seedSuspect({ verdict: 'not-source', nameKey: '玉宁熙pro', contentHash: 'same-hash' })
    const id = seedSuspect({
      verdict: 'not-source', score: 2, sizeBytes: 60 * 1024, blobSha: sha,
      nameKey: '玉宁熙pro', contentHash: 'same-hash', upstreamAt: '2026-10-05T00:00:00Z',
    })
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))
    _setRunnerForTest(fakeRunner())

    await probeCandidate(id, { force: true })
    expect(rows.find(r => r.id === id)!.state).toBe('new')        // 上游时间最新 ⇒ 它留
    expect(String(rows.find(r => r.id === id)!.reason)).toContain('顺带顶掉 1 条')
    expect(rows.find(r => r.id === twin)!.state).toBe('stale')    // 同内容的在册疑似被顶掉
    expect(rows.find(r => r.id === notSuspect)!.state).toBe('new')
  })

  it('仍然判级 0 出货 ⇒ 等级不动（留在 not-source），但红绿灯留在行上供人看', async () => {
    const id = seedSuspect({
      verdict: 'not-source', score: 2, sizeBytes: 60 * 1024, blobSha: gitBlobSha(FAKE_SOURCE_SCRIPT),
    })
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))
    _setRunnerForTest(fakeRunner({ probeImpl: async () => ({ ok: true, sourceInfo: {}, callError: '无版权，无法播放' }) }))

    const report = await probeCandidate(id, { force: true })
    expect(report.cells.tx?.outcome).toBe('no-address')
    const row = rows.find(r => r.id === id)!
    expect(row.verdict).toBe('not-source')
    expect(String(row.probeJson)).toContain('no-address')
  })

  it('仍然判级不放水完整性：sha 对不上照旧一次都不执行', async () => {
    const id = seedSuspect({
      verdict: 'not-source', score: 2, sizeBytes: 60 * 1024, blobSha: '0'.repeat(40),
    })
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))
    const runner = fakeRunner()
    _setRunnerForTest(runner)

    const report = await probeCandidate(id, { force: true })
    expect(report.shaVerified).toBe(false)
    expect(runner.validateScript).not.toHaveBeenCalled()
    expect(rows.find(r => r.id === id)?.verdict).toBe('not-source')
  })

  it('不像载荷的不给仍然判级：没 @name、体积在窗口外、pending 都拒（防它变成万能口子）', async () => {
    const sha = gitBlobSha(FAKE_SOURCE_SCRIPT)
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))
    _setRunnerForTest(fakeRunner())

    await expect(probeCandidate(seedSuspect({ verdict: 'not-source', scriptName: '', sizeBytes: 60 * 1024, blobSha: sha }), { force: true }))
      .rejects.toThrow(/仍然判级/)
    await expect(probeCandidate(seedSuspect({ verdict: 'not-source', sizeBytes: 5 * 1024, blobSha: sha }), { force: true }))
      .rejects.toThrow(/仍然判级/)
    await expect(probeCandidate(seedSuspect({ verdict: 'not-source', sizeBytes: 5 * 1024 * 1024, blobSha: sha }), { force: true }))
      .rejects.toThrow(/仍然判级/)
    await expect(probeCandidate(seedSuspect({ verdict: 'pending', sizeBytes: 60 * 1024, blobSha: sha }), { force: true }))
      .rejects.toThrow(/仍然判级/)
    // 不带 force 时老口子一个字没变
    await expect(probeCandidate(seedSuspect({ verdict: 'not-source', sizeBytes: 60 * 1024, blobSha: sha })))
      .rejects.toThrow(/疑似音源/)
  })

  it('looksLikeObfuscatedSource 的窗口是闭区间，且只认 not-source', () => {
    expect(looksLikeObfuscatedSource({ verdict: 'not-source', scriptName: 'X', sizeBytes: 20 * 1024 })).toBe(true)
    expect(looksLikeObfuscatedSource({ verdict: 'not-source', scriptName: 'X', sizeBytes: 1024 * 1024 })).toBe(true)
    expect(looksLikeObfuscatedSource({ verdict: 'not-source', scriptName: 'X', sizeBytes: 20 * 1024 - 1 })).toBe(false)
    expect(looksLikeObfuscatedSource({ verdict: 'not-source', scriptName: 'X', sizeBytes: 1024 * 1024 + 1 })).toBe(false)
    expect(looksLikeObfuscatedSource({ verdict: 'not-source', scriptName: '   ', sizeBytes: 60 * 1024 })).toBe(false)
    expect(looksLikeObfuscatedSource({ verdict: 'suspect', scriptName: 'X', sizeBytes: 60 * 1024 })).toBe(false)
    expect(looksLikeObfuscatedSource({ verdict: 'pending', scriptName: 'X', sizeBytes: 60 * 1024 })).toBe(false)
  })

  it('一次性进程崩了 ⇒ 记 harness（我们通道没判成），不记成"源不行"', async () => {
    const id = seedSuspect({ blobSha: gitBlobSha(FAKE_SOURCE_SCRIPT) })
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))
    _setRunnerForTest(fakeRunner({ probeImpl: async () => ({ ok: false, error: '脚本判级进程异常退出' }) }))

    const report = await probeCandidate(id)
    expect(report.cells.tx?.outcome).toBe('harness')
    expect(report.note).toContain('通道没判成')
    expect(report.note).toContain('可重判')
  })

  it('脚本上游断连（socket hang up）仍算 error —— 真数据里它从不与进程崩溃同现，不是一回事', async () => {
    const id = seedSuspect({ blobSha: gitBlobSha(FAKE_SOURCE_SCRIPT) })
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))
    _setRunnerForTest(fakeRunner({ probeImpl: async () => ({ ok: false, error: 'socket hang up' }) }))

    const report = await probeCandidate(id)
    expect(report.cells.tx?.outcome).toBe('error')
    expect(report.note).not.toContain('通道没判成')
  })

  it('加载阶段就崩 ⇒ 那一格也算 harness', async () => {
    const id = seedSuspect({ blobSha: gitBlobSha(FAKE_SOURCE_SCRIPT) })
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))
    const runner = { ...fakeRunner(), validateScript: vi.fn(async () => ({ ok: false, error: '脚本校验进程异常退出' })) }
    _setRunnerForTest(runner)

    const report = await probeCandidate(id)
    expect(report.cells['_']?.outcome).toBe('harness')
  })
})

// ————— P0-c：导入闭环 —————

/** 造一份判级结果：只关心"哪几格真出货"，其余字段按真形状填 */
function probeReportOf(outcomes: Record<string, string>): string {
  return JSON.stringify({
    cells: Object.fromEntries(Object.entries(outcomes).map(([platform, outcome]) => [
      platform,
      { outcome, latencyMs: 120, container: outcome === 'ok' ? 'mp3' : null, reason: null },
    ])),
    shaVerified: true,
    note: null,
  })
}

describe('importCandidate', () => {
  it('判级有平台出货才放行：地址与 blob sha 都取自库里那一行，不给调用方插手', async () => {
    const sha = gitBlobSha(FAKE_SOURCE_SCRIPT)
    const id = seedSuspect({ blobSha: sha, probeJson: probeReportOf({ tx: 'ok', kw: 'no-address' }) })
    importSubscriptionMock.mockResolvedValue({ path: 'custom-sources/合成测试音源 v1.2.0.js', name: '合成测试音源' })

    const source = await importCandidate(id)
    expect(importSubscriptionMock).toHaveBeenCalledWith(RAW_URL, { expectedBlobSha: sha })
    expect(source.path).toContain('custom-sources')
    expect(rows.find(r => r.id === id)).toMatchObject({
      state: 'imported', importedPath: 'custom-sources/合成测试音源 v1.2.0.js',
    })
  })

  it('一个平台都没出货 ⇒ 挡住，一次都不碰导入通道（这是唯一会写生产配置的入口）', async () => {
    const id = seedSuspect({ probeJson: probeReportOf({ tx: 'error' }) })
    await expect(importCandidate(id)).rejects.toThrow(/没有一个平台真出货/)
    expect(importSubscriptionMock).not.toHaveBeenCalled()
  })

  it('从没判过 = 一样挡住：没证据不等于证据是坏的，但更不等于能装', async () => {
    const id = seedSuspect()
    await expect(importCandidate(id)).rejects.toThrow(/没有一个平台真出货/)
    expect(importSubscriptionMock).not.toHaveBeenCalled()
  })

  it('force 越的是"人没确认"这一道，blob sha 复验照样带着走 —— 完整性不给撤', async () => {
    const sha = 'a'.repeat(40)
    const id = seedSuspect({ blobSha: sha, probeJson: probeReportOf({ tx: 'error' }) })
    importSubscriptionMock.mockResolvedValue({ path: 'custom-sources/x.js', name: 'x' })

    await importCandidate(id, { force: true })
    expect(importSubscriptionMock).toHaveBeenCalledWith(RAW_URL, { expectedBlobSha: sha })
  })

  it('已导入且那条源还在配置里 ⇒ 不给重复导入，force 也不行（点两下多一个 -1.js 叫垃圾）', async () => {
    const id = seedSuspect({ state: 'imported', importedPath: 'custom-sources/x.js', probeJson: probeReportOf({ tx: 'ok' }) })
    readConfigMock.mockResolvedValue({ sources: [{ path: 'custom-sources/x.js' }] })
    await expect(importCandidate(id, { force: true })).rejects.toThrow(/已经导入为 custom-sources\/x\.js/)
    expect(importSubscriptionMock).not.toHaveBeenCalled()
  })

  it('那条源已经在「音源管理」里删掉了 ⇒ 重新开放导入（判据看配置，不是看候选状态）', async () => {
    const sha = 'b'.repeat(40)
    const id = seedSuspect({ state: 'imported', importedPath: 'custom-sources/x.js', blobSha: sha, probeJson: probeReportOf({ tx: 'ok' }) })
    readConfigMock.mockResolvedValue({ sources: [{ path: 'custom-sources/别的源.js' }] })
    importSubscriptionMock.mockResolvedValue({ path: 'custom-sources/x-1.js', name: 'X' })

    await importCandidate(id)
    expect(importSubscriptionMock).toHaveBeenCalledWith(RAW_URL, { expectedBlobSha: sha })
    expect(rows.find(r => r.id === id)).toMatchObject({ state: 'imported', importedPath: 'custom-sources/x-1.js' })
  })

  it('导入通道报错（sha 对不上就是这里拦的）原样带上原因，且不回写 state：失败的操作不该判死候选', async () => {
    const id = seedSuspect({ probeJson: probeReportOf({ tx: 'ok' }) })
    const { SourceSubscriptionError } = await import('@/lib/services/source-manager-service')
    importSubscriptionMock.mockRejectedValue(new SourceSubscriptionError('内容与仓库 tree 记录的 blob 不一致，拒绝导入', 409))

    await expect(importCandidate(id)).rejects.toThrow(/blob 不一致/)
    const row = rows.find(r => r.id === id)
    expect(row?.state).toBe('new')
    expect(row?.importedPath).toBe('')
  })

  it('非 suspect 的候选不给导入', async () => {
    const id = seedSuspect({ verdict: 'not-source' })
    await expect(importCandidate(id)).rejects.toThrow(/疑似音源/)
  })

  it('已导入的候选不给"剔除" —— 那会让配置里的源变成没人认领的文件', async () => {
    const id = seedSuspect({ state: 'imported', importedPath: 'custom-sources/x.js' })
    readConfigMock.mockResolvedValue({ sources: [{ path: 'custom-sources/x.js' }] })
    await expect(dismissCandidate(id)).rejects.toThrow(/音源管理/)
    expect(rows.find(r => r.id === id)?.state).toBe('imported')
  })

  it('源已经被删掉的候选可以正常剔除（状态只是历史，不该把行锁死）', async () => {
    const id = seedSuspect({ state: 'imported', importedPath: 'custom-sources/x.js' })
    await dismissCandidate(id)
    expect(rows.find(r => r.id === id)?.state).toBe('stale')
  })
})

// ————— P0-c 补：候选 vs 已装源 —————
describe('导入前先跟已经装着的源比一次', () => {
  const INSTALLED_PATH = 'custom-sources/已装的源.js'
  const SAME_HASH = createHash('sha256').update(FAKE_SOURCE_SCRIPT, 'utf8').digest('hex')
  const OTHER_HASH = 'd'.repeat(64)

  beforeEach(() => {
    fsReadFileMock.mockResolvedValue(FAKE_SOURCE_SCRIPT)
    readConfigMock.mockResolvedValue({ sources: [{ path: INSTALLED_PATH, name: '合成测试音源 v9.9.9' }] })
  })

  it('字节完全相同 ⇒ 拒，force 也不给越，并且一次都不下载', async () => {
    const id = seedSuspect({ contentHash: SAME_HASH, nameKey: '', probeJson: probeReportOf({ tx: 'ok' }) })
    await expect(importCandidate(id, { force: true })).rejects.toThrow(/内容完全相同/)
    expect(importSubscriptionMock).not.toHaveBeenCalled()
  })

  it('同名但内容不同 ⇒ 拒；force 能越 —— "我就要两条并排对照"是管理员的决定', async () => {
    const id = seedSuspect({ contentHash: OTHER_HASH, nameKey: '合成测试音源', probeJson: probeReportOf({ tx: 'ok' }) })
    await expect(importCandidate(id)).rejects.toThrow(/同名源/)
    importSubscriptionMock.mockResolvedValue({ path: 'custom-sources/别的.js', name: 'X' })
    await importCandidate(id, { force: true })
    expect(importSubscriptionMock).toHaveBeenCalledTimes(1)
  })

  it('撞车先于判级报：库里就有那份，这条比"你还没判过"更有决定性', async () => {
    const id = seedSuspect({ contentHash: OTHER_HASH, nameKey: '合成测试音源', probeJson: '' })
    await expect(importCandidate(id)).rejects.toThrow(/同名源/)
  })

  it('同名是**归一后**比：括号注记与版本号不一样也认得出同一个源', async () => {
    readConfigMock.mockResolvedValue({ sources: [{ path: INSTALLED_PATH, name: '合成测试音源（二改修复版） 1.2.0' }] })
    const id = seedSuspect({ contentHash: OTHER_HASH, nameKey: '合成测试音源', probeJson: probeReportOf({ tx: 'ok' }) })
    await expect(importCandidate(id)).rejects.toThrow(/同名源/)
  })

  it('配置里有、盘上读不到时，不该把别的导入一起挡死', async () => {
    fsReadFileMock.mockRejectedValue(new Error('ENOENT'))
    const id = seedSuspect({ contentHash: '', nameKey: '', probeJson: probeReportOf({ tx: 'ok' }) })
    importSubscriptionMock.mockResolvedValue({ path: 'custom-sources/新.js', name: 'X' })
    await expect(importCandidate(id)).resolves.toBeTruthy()
  })

  it('列表里就把撞车对象标出来（面板据此提前提示，不必等管理员点了才知道）', async () => {
    seedSuspect({ contentHash: SAME_HASH, nameKey: '', scriptName: '合成测试音源 v1.2.0' })
    const [view] = await listCandidates()
    expect(view.duplicateOf).toEqual({ kind: 'content', path: INSTALLED_PATH, name: '合成测试音源 v9.9.9' })
  })
})

// ————— 删掉音源 ⇒ 引用它的候选行写回 —————

describe('源删除后把候选行写回可再导入', () => {
  it('按 importedPath 找行：状态回 new、importedPath 清空、这段历史留在依据里', async () => {
    const id = seedSuspect({ state: 'imported', importedPath: 'custom-sources/聚合.js', reason: '4/5 个平台真出货' })
    const untouched = seedSuspect({ repo: 'x/y', path: 'other.js', importedPath: 'custom-sources/别的.js' })
    expect(await reopenCandidatesForRemovedSource('custom-sources/聚合.js')).toBe(1)
    const row = rows.find(r => r.id === id)!
    expect(row.state).toBe('new')
    expect(row.importedPath).toBe('')
    expect(String(row.reason)).toContain('4/5 个平台真出货')
    expect(String(row.reason)).toContain('曾导入为 custom-sources/聚合.js，源已删除 ⇒ 重新开放导入')
    expect(rows.find(r => r.id === untouched)!.importedPath).toBe('custom-sources/别的.js')
  })

  it('落盘路径重名时会有两条指向同一条源，两条都得写回；原本没有依据的行也给一句人话', async () => {
    const a = seedSuspect({ state: 'imported', importedPath: 'custom-sources/同名.js' })
    const b = seedSuspect({ repo: 'p/q', path: 'b.js', state: 'imported', importedPath: 'custom-sources/同名.js', reason: null })
    expect(await reopenCandidatesForRemovedSource('custom-sources/同名.js')).toBe(2)
    expect(rows.filter(r => r.importedPath === 'custom-sources/同名.js')).toEqual([])
    expect(String(rows.find(r => r.id === b)!.reason)).toBe('曾导入为 custom-sources/同名.js，源已删除 ⇒ 重新开放导入')
    expect(rows.find(r => r.id === a)!.state).toBe('new')
  })

  it('导入→删除→再导入→再删除 是常规操作：同一句历史不叠两遍', async () => {
    const id = seedSuspect({ state: 'imported', importedPath: 'custom-sources/某.js', reason: '3/5 个平台真出货' })
    expect(await reopenCandidatesForRemovedSource('custom-sources/某.js')).toBe(1)
    const once = String(rows.find(r => r.id === id)!.reason)
    // 第二次导入+删除：行重新挂上 importedPath，再写回一次
    const row = rows.find(r => r.id === id)!
    row.state = 'imported'
    row.importedPath = 'custom-sources/某.js'
    expect(await reopenCandidatesForRemovedSource('custom-sources/某.js')).toBe(1)
    const twice = String(rows.find(r => r.id === id)!.reason)
    expect(twice).toBe(once)
    expect((twice.match(/曾导入为/g) ?? []).length).toBe(1)
  })

  it('空路径直接不查库：配置里不存在"路径为空"的源，写回全表是灾难', async () => {
    seedSuspect({ state: 'imported', importedPath: 'custom-sources/某.js' })
    expect(await reopenCandidatesForRemovedSource('')).toBe(0)
    expect(rows.filter(r => r.state === 'imported').length).toBe(1)
  })
})

// ————— 候选列表排序 —————

describe('候选列表排序（判级真出货优先，静态分只给没判过的排队）', () => {
  it('判过但零出货的，仍排在没判过的高分前面；没判过的之间按分高在前', async () => {
    seedSuspect({ scriptName: '甲 v1', score: 11, probeJson: probeReportOf({ tx: 'error', wy: 'no-address' }) })
    seedSuspect({ scriptName: '乙 v1', score: 4, probeJson: probeReportOf({ tx: 'ok', wy: 'ok', kw: 'ok', kg: 'timeout' }) })
    seedSuspect({ scriptName: '丙 v1', score: 20 })
    seedSuspect({ scriptName: '丁 v1', score: 6 })
    const views = await listCandidates()
    expect(views.map(v => v.scriptName)).toEqual(['乙 v1', '甲 v1', '丙 v1', '丁 v1'])
  })

  it('出货数相同按判级时间新的在前；take 是排完才切（切的是最该看的，不是插入序）', async () => {
    const at = (dayOfMonth: number) => new Date(Date.UTC(2026, 9, dayOfMonth))
    seedSuspect({ scriptName: '旧 v1', score: 9, probedAt: at(1), probeJson: probeReportOf({ tx: 'ok' }) })
    seedSuspect({ scriptName: '新 v1', score: 3, probedAt: at(5), probeJson: probeReportOf({ tx: 'ok' }) })
    seedSuspect({ scriptName: '没判 v1', score: 30 })
    expect((await listCandidates()).map(v => v.scriptName)).toEqual(['新 v1', '旧 v1', '没判 v1'])
    expect((await listCandidates({ take: 1 })).map(v => v.scriptName)).toEqual(['新 v1'])
  })

  it('shipmentOf：从没判过与"判过但零出货"是两回事（排序分档与面板都靠这个）', () => {
    expect(shipmentOf('')).toEqual({ judged: false, ok: 0 })
    expect(shipmentOf('不是 JSON')).toEqual({ judged: true, ok: 0 })
    expect(shipmentOf(probeReportOf({ tx: 'ok', kg: 'harness' }))).toEqual({ judged: true, ok: 1 })
  })
})

// ————— 连轮清存量 —————
/** 一棵只含指定文件的仓库树；正文默认返回骨架脚本，failRaw 时 500（演"下载一直失败"） */
function stubRepoTree(files: Array<{ path: string; sha: string }>, options: { failRaw?: boolean } = {}) {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 5000, limit: 5000, reset: 0 } } })
    if (url.includes('/git/trees/')) {
      return jsonResponse({ tree: files.map(f => ({ path: f.path, type: 'blob', sha: f.sha, size: 100 })) })
    }
    if (options.failRaw) return new Response('nope', { status: 500 })
    return new Response(FAKE_SOURCE_SCRIPT, { headers: { 'content-type': 'text/plain', 'last-modified': 'Wed, 01 Oct 2026 00:00:00 GMT' } })
  })
}

describe('runDiscoveryDrain（连轮清完待判定）', () => {
  it('一轮吃满下载额度就自动接下一轮，pending 清零即停', async () => {
    await saveDiscoverySettings({ enabled: true, repos: ['a/b'], maxDownloadsPerRound: 1 })
    vi.stubGlobal('fetch', stubRepoTree([
      { path: 'lx-a.js', sha: 'aaa' }, { path: 'lx-b.js', sha: 'bbb' }, { path: 'lx-c.js', sha: 'ccc' },
    ]))

    const totals = await runDiscoveryDrain()
    // 三个文件、每轮只许下 1 个 ⇒ 要 3 轮；剩余数是**从假库里数 pending 行**得来的，不是我手喂的
    expect(totals.rounds).toBe(3)
    expect(totals.downloaded).toBe(3)
    expect(totals.pendingLeft).toBe(0)
    expect(totals.note).toContain('清零')
    expect(discoveryStatus().draining).toBe(false)
    expect(discoveryStatus().drainLast?.rounds).toBe(3)
  })

  it('全新库也得先跑一轮：pending 还是 0 不等于没活干（树里可能一堆没登记过的文件）', async () => {
    await saveDiscoverySettings({ enabled: true, repos: ['a/b'], maxDownloadsPerRound: 5 })
    vi.stubGlobal('fetch', stubRepoTree([{ path: 'lx-a.js', sha: 'aaa' }]))

    const totals = await runDiscoveryDrain()
    expect(totals.rounds).toBe(1)
    expect(totals.downloaded).toBe(1)
    expect(totals.pendingLeft).toBe(0)
  })

  it('一整轮没能减少待判定 ⇒ 停下并报原因（下载全失败会一直留 pending，没这条判据就永远空转）', async () => {
    await saveDiscoverySettings({ enabled: true, repos: ['a/b'], maxDownloadsPerRound: 5 })
    vi.stubGlobal('fetch', stubRepoTree([{ path: 'lx-a.js', sha: 'aaa' }], { failRaw: true }))

    const totals = await runDiscoveryDrain()
    expect(totals.pendingLeft).toBe(1)
    expect(totals.note).toMatch(/没能减少待判定/)
  })

  it('停止：当前轮在仓与仓之间中断，连轮随即收尾', async () => {
    await saveDiscoverySettings({ enabled: true, repos: ['a/b'], maxDownloadsPerRound: 5 })
    vi.stubGlobal('fetch', stubRepoTree([{ path: 'lx-a.js', sha: 'aaa' }]))

    const task = runDiscoveryDrain()
    // 抢在第一轮扫到任何仓之前按下去
    expect(requestDiscoveryStop()).toEqual({ stopping: true })
    const totals = await task
    expect(totals.stopped).toBe(true)
    expect(totals.note).toContain('手动停止')
    expect(discoveryStatus().stopRequested).toBe(false)
  })

  it('没在跑的时候按停止是句空话：回 stopping:false，别让人以为按坏了', () => {
    expect(requestDiscoveryStop()).toEqual({ stopping: false })
  })

  it('连轮期间再点"开始发现"不会被塞成第二个任务', async () => {
    await saveDiscoverySettings({ enabled: true, repos: ['a/b'], maxDownloadsPerRound: 5 })
    vi.stubGlobal('fetch', stubRepoTree([{ path: 'lx-a.js', sha: 'aaa' }]))
    const task = runDiscoveryDrain()
    expect(() => runDiscoveryCrawl()).toThrow(/连轮/)
    await task
  })
})

// ————— 批量判级 —————
async function waitProbeBatch(timeoutMs = 5_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const batch = discoveryStatus().probeBatch
    if (batch && !batch.running) return batch
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('批量判级没在预期时间内收口')
}

describe('startCandidateProbeBatch（批量判级）', () => {
  beforeEach(() => {
    _setProbeGapForTest(0)
    _setRunnerForTest(fakeRunner())
  })
  afterEach(() => {
    _setProbeGapForTest(null)
    _setRunnerForTest(null)
  })

  it('一批最多 50 条，只挑在册且没判过的，判完把结果写回行上', async () => {
    await enable(['a/b'])
    for (let i = 0; i < 55; i++) seedSuspect({})
    const judgedJson = JSON.stringify({ cells: { tx: { outcome: 'ok', latencyMs: 1, container: 'mp3', reason: null } }, shaVerified: true, note: '以前判过' })
    const judged = seedSuspect({ probeJson: judgedJson })
    const stale = seedSuspect({ state: 'stale' })
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))

    expect(startCandidateProbeBatch().started).toBe(true)
    const batch = await waitProbeBatch()
    expect(batch?.total).toBe(50)
    expect(batch?.done).toBe(50)
    expect(batch?.withAddress).toBe(50)
    // 已判过的没被动、stale 的没被捞进来判
    expect(rows.find(r => r.id === judged)?.probeJson).toBe(judgedJson)
    expect(rows.find(r => r.id === stale)?.probeJson).toBe('')
  })

  it('一条判不成不拦整批：计入失败，后面的照判', async () => {
    await enable(['a/b'])
    seedSuspect({})
    seedSuspect({ path: 'broken.js', rawUrl: 'https://raw.githubusercontent.com/a/b/HEAD/broken.js' })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 5000, limit: 5000, reset: 0 } } })
      if (url.includes('broken.js')) return new Response('nope', { status: 404 })
      return new Response(FAKE_SOURCE_SCRIPT, { headers: { 'content-type': 'text/plain' } })
    }))

    expect(startCandidateProbeBatch().started).toBe(true)
    const batch = await waitProbeBatch()
    expect(batch?.done).toBe(2)
    expect(batch?.failed).toBe(1)
    expect(batch?.withAddress).toBe(1)
  })

  it('按停止就不再判下一条（停止标志在同一次点击里就生效，一条也还没开始）', async () => {
    await enable(['a/b'])
    seedSuspect({})
    seedSuspect({})
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))

    expect(startCandidateProbeBatch().started).toBe(true)
    expect(requestDiscoveryStop()).toEqual({ stopping: true })
    const batch = await waitProbeBatch()
    expect(batch?.stopped).toBe(true)
    expect(batch?.done).toBe(0)
    expect(rows.every(r => r.probeJson === '')).toBe(true)
  })

  it('没有待判的候选：起得来但立刻收，并写明原因', async () => {
    await enable(['a/b'])
    seedSuspect({ probeJson: '{"cells":{},"shaVerified":null,"note":"判过"}' })

    expect(startCandidateProbeBatch().started).toBe(true)
    const batch = await waitProbeBatch()
    expect(batch?.total).toBe(0)
    expect(batch?.note).toMatch(/没有待判级的候选/)
  })

  it('重判只捞"通道没判成"的，判成功或判成真不行的都不重复消耗上游', async () => {
    await enable(['a/b'])
    const crashed = seedSuspect({ probeJson: JSON.stringify({ cells: { tx: { outcome: 'harness', latencyMs: 12, container: null, reason: '脚本判级进程异常退出' } }, shaVerified: true, note: null }) })
    seedSuspect({ probeJson: JSON.stringify({ cells: { tx: { outcome: 'error', latencyMs: 12, container: null, reason: 'socket hang up' } }, shaVerified: true, note: null }) })
    seedSuspect({ probeJson: JSON.stringify({ cells: { tx: { outcome: 'ok', latencyMs: 12, container: 'mp3', reason: null } }, shaVerified: true, note: null }) })
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))
    _setRunnerForTest(fakeRunner())

    expect(startCandidateProbeBatch().started).toBe(true)
    const batch = await waitProbeBatch()
    expect(batch?.total).toBe(1)
    expect(batch?.done).toBe(1)
    expect(rows.find(r => r.id === crashed)?.probeJson).toContain('"ok"')
  })

  it('一批在跑时不再起第二批，也不给单条插队', async () => {
    await enable(['a/b'])
    seedSuspect({})
    vi.stubGlobal('fetch', stubRawFetch(FAKE_SOURCE_SCRIPT))

    expect(startCandidateProbeBatch().started).toBe(true)
    expect(startCandidateProbeBatch()).toEqual({ started: false, reason: '已有一批判级在跑' })
    expect(startCandidateProbe(1)).toEqual({ started: false, reason: '有一批判级正在跑' })
    await waitProbeBatch()
  })
})

describe('pruneOrphanCandidates（清理已移除仓留下的候选）', () => {
  it('只删不在清单里的仓，清单里的行一行都不动', async () => {
    await enable(['a/b'])
    const kept = seedSuspect({})
    const orphanA = seedSuspect({ repo: 'old/c', path: 'x.js' })
    const orphanB = seedSuspect({ repo: 'old/d', path: 'y.js' })

    const result = await pruneOrphanCandidates()
    expect(result.removed).toBe(2)
    expect(rows.map(r => r.id)).toEqual([kept])
    expect(rows.some(r => r.id === orphanA || r.id === orphanB)).toBe(false)
  })

  it('已导入成音源的行保留 —— 它是配置里那条源的溯源，删了就答不出"这脚本哪来的"', async () => {
    await enable(['a/b'])
    const imported = seedSuspect({ repo: 'old/c', state: 'imported', importedPath: 'custom-sources/老源.js' })
    seedSuspect({ repo: 'old/d' })

    const result = await pruneOrphanCandidates()
    expect(result.removed).toBe(1)
    expect(result.keptImported).toEqual(['old/c → custom-sources/老源.js'])
    expect(rows.map(r => r.id)).toEqual([imported])
  })

  it('清单被清空时拒绝执行：那等于"所有候选都不在清单里"，一键清表不该这么容易', async () => {
    await saveDiscoverySettings({ enabled: true, repos: ['a/b'] })
    seedSuspect({ repo: 'a/b' })
    await saveDiscoverySettings({ repos: [] })

    await expect(pruneOrphanCandidates()).rejects.toThrow(/先加回至少一个仓/)
    expect(rows.length).toBe(1)
  })
})

// ————— 按关键词搜 GitHub 仓库 —————
describe('sanitizeRepoQuery', () => {
  it('剔控制字符、钳长度；非字符串一律当空', () => {
    expect(sanitizeRepoQuery('  lxmusic\u0000 source\r\n')).toBe('lxmusic source')
    expect(sanitizeRepoQuery('x'.repeat(500))).toHaveLength(200)
    expect(sanitizeRepoQuery(undefined)).toBe('')
    expect(sanitizeRepoQuery(42)).toBe('')
  })
})

describe('repoSearchItemFromApi', () => {
  const base = {
    full_name: 'foo/bar', description: '洛雪音乐源', stargazers_count: 12,
    pushed_at: '2026-10-01T00:00:00Z', language: 'JavaScript', fork: false, archived: false, private: false,
  }

  it('私有的不进面板；full_name 形状不对的也不进（GitHub 给的不等于免检）', () => {
    expect(repoSearchItemFromApi({ ...base, private: true }, new Set())).toBeNull()
    expect(repoSearchItemFromApi({ ...base, full_name: 'foo/bar/baz' }, new Set())).toBeNull()
    expect(repoSearchItemFromApi({ ...base, full_name: '' }, new Set())).toBeNull()
  })

  it('已在清单里的要标出来（面板据此置灰，避免重复勾选）', () => {
    const view = repoSearchItemFromApi(base, new Set(['foo/bar']))
    expect(view?.alreadyListed).toBe(true)
    expect(view?.repo).toBe('foo/bar')
    expect(view?.lastPushAt).toBe('2026-10-01T00:00:00Z')
  })

  it('没有 pushed_at 才退回 updated_at，两个都没有就是空串（不能编一个时间给面板看）', () => {
    expect(repoSearchItemFromApi({ full_name: 'foo/bar', updated_at: '2026-09-09T00:00:00Z' }, new Set())?.lastPushAt)
      .toBe('2026-09-09T00:00:00Z')
    expect(repoSearchItemFromApi({ full_name: 'foo/bar' }, new Set())?.lastPushAt).toBe('')
  })
})

describe('searchGitHubRepos', () => {
  it('请求形状：q 走查询参数、默认按最近更新排，带 token 时走 Bearer', async () => {
    await enable(['a/b'], 'tok123')
    const fetch = vi.fn(async () => jsonResponse({ total_count: 0, items: [] }))
    vi.stubGlobal('fetch', fetch)

    await searchGitHubRepos('lxmusic source')
    const [url, init] = callsOf(fetch)[0]
    expect(url).toContain('https://api.github.com/search/repositories?')
    expect(new URL(url).searchParams.get('q')).toBe('lxmusic source')
    expect(new URL(url).searchParams.get('sort')).toBe('updated')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok123')
  })

  it('sort=best 时不带 sort 参数（交给 GitHub 的最佳匹配）', async () => {
    await enable(['a/b'])
    const fetch = vi.fn(async () => jsonResponse({ total_count: 0, items: [] }))
    vi.stubGlobal('fetch', fetch)
    await searchGitHubRepos('lx music', 1, 'best')
    expect(new URL(callsOf(fetch)[0][0]).searchParams.get('sort')).toBeNull()
  })

  it('不认识 sort 时按 updated，不接受任意值拼进 URL', async () => {
    await enable(['a/b'])
    const fetch = vi.fn(async () => jsonResponse({ total_count: 0, items: [] }))
    vi.stubGlobal('fetch', fetch)
    await searchGitHubRepos('lx music', 1, 'stars; sort=bad')
    expect(new URL(callsOf(fetch)[0][0]).searchParams.get('sort')).toBe('updated')
  })

  it('私有的与形状不对的被丢掉，清单里的标 alreadyListed', async () => {
    await enable(['a/b', 'known/repo'])
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      total_count: 4,
      items: [
        { full_name: 'a/b', stargazers_count: 1, pushed_at: '2026-10-01T00:00:00Z' },
        { full_name: 'known/repo', stargazers_count: 2 },
        { full_name: 'new/guy', description: '音源', stargazers_count: 3, private: true },
        { full_name: 'weird/shape/extra', stargazers_count: 4 },
      ],
    })))

    const result = await searchGitHubRepos('lxmusic source')
    expect(result.items.map(i => i.repo)).toEqual(['a/b', 'known/repo'])
    expect(result.items[0].alreadyListed).toBe(true)
    expect(result.total).toBe(4)
  })

  it('配额用完时报的是"这一档与爬树分开"，数字来自搜索接口自己的响应头', async () => {
    await enable(['a/b'])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
      status: 403,
      headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '10', 'x-ratelimit-reset': '9999999999' },
    })))
    await expect(searchGitHubRepos('lxmusic source')).rejects.toThrow(/搜索配额用尽.*这一档和爬仓库树的额度是分开的/s)
  })

  it('搜索接口的响应头里有配额，就把它带回去给面板显示', async () => {
    await enable(['a/b'])
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(
      { total_count: 1, items: [{ full_name: 'new/guy', stargazers_count: 5, pushed_at: '2026-10-05T00:00:00Z' }] },
      { 'x-ratelimit-remaining': '27', 'x-ratelimit-limit': '30', 'x-ratelimit-reset': '9999999999' },
    )))
    const result = await searchGitHubRepos('lxmusic source')
    expect(result.quota).toEqual({ remaining: 27, limit: 30, resetAt: 9999999999 })
    expect(result.items[0].repo).toBe('new/guy')
  })

  it('空词与太短的词都不打网络', async () => {
    await enable(['a/b'])
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(searchGitHubRepos('   ')).rejects.toThrow(/搜索词是空的/)
    await expect(searchGitHubRepos('lx')).rejects.toThrow(/太短/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('翻页越界要钳在 GitHub 的 1000 条窗口内，并透传 incomplete_results', async () => {
    await enable(['a/b'])
    const fetch = vi.fn(async () => jsonResponse({ total_count: 5000, incomplete_results: true, items: [] }))
    vi.stubGlobal('fetch', fetch)
    const result = await searchGitHubRepos('lxmusic source', 9999, 'updated', 30)
    expect(result.page).toBe(33)
    expect(new URL(callsOf(fetch)[0][0]).searchParams.get('page')).toBe('33')
    expect(result.incomplete).toBe(true)
  })

  it('HTTP 422（写法不被接受）说人话，不把 GitHub 的原文透出去', async () => {
    await enable(['a/b'])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"Validation Failed","documentation_url":"https://docs.github.com/rest"}', { status: 422 })))
    await expect(searchGitHubRepos('音源 in:name')).rejects.toThrow(/GitHub 搜索没接受这个关键词/)
  })
})

// ————— 只扫勾选的那几个仓 —————
describe('runDiscoveryCrawl 的仓子集', () => {
  it('给了子集就只打这几个仓的树，并把"只扫了 1/2"写进结论', async () => {
    await enable(['a/b', 'c/d'])
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 100, limit: 100, reset: 0 } } })
      if (url.includes('/git/trees/')) return jsonResponse({ tree: [], truncated: false })
      throw new Error(`不该下载: ${url}`)
    }))

    const summary = await runDiscoveryCrawl({ onlyRepos: ['c/d'] })
    expect(urls.filter(u => u.includes('/git/trees/'))).toEqual([
      'https://api.github.com/repos/c/d/git/trees/HEAD?recursive=1',
    ])
    expect(summary.note).toContain('只扫了勾选的 1/2 个仓')
  })

  it('子集里清单外的仓带不进来：一个都不剩就明说，绝不退化成"那就扫全清单"', async () => {
    await enable(['a/b'])
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 100, limit: 100, reset: 0 } } })
      return jsonResponse({ tree: [], truncated: false })
    })
    vi.stubGlobal('fetch', fetch)

    await expect(runDiscoveryCrawl({ onlyRepos: ['x/y'] })).rejects.toThrow(/还没进扫描清单/)
    expect(fetch).not.toHaveBeenCalled()
    // 起轮是 202 + 后台跑，面板唯一的出口就是 lastError：没写进去就是"点了没反应"
    expect(discoveryStatus().lastError).toContain('勾选的 1 个仓都还没进扫描清单')
  })

  it('写法全不合法的子集（含 URL、路径穿越）当场拒绝，不打 GitHub', async () => {
    await enable(['a/b'])
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    // 这一档是同步抛的：请求形状就不对，没必要先起一个后台任务再失败
    expect(() => runDiscoveryCrawl({ onlyRepos: ['https://evil.test/a/b', '../etc'] })).toThrow(/写法都不合法/)
    expect(fetch).not.toHaveBeenCalled()
  })
})

// ————— 停更仓体检 —————
describe('daysSincePush', () => {
  const now = Date.parse('2026-10-05T12:00:00.000Z')
  it('读不出时间就是 null、时钟偏前按 0 天：这两种都不该被判成停更', () => {
    expect(daysSincePush('', now)).toBeNull()
    expect(daysSincePush(undefined, now)).toBeNull()
    expect(daysSincePush('乱码', now)).toBeNull()
    expect(daysSincePush('2026-10-06T00:00:00.000Z', now)).toBe(0)
    expect(daysSincePush('2026-09-05T12:00:00.000Z', now)).toBe(30)
  })
})

describe('auditRepoFreshness（停更仓体检）', () => {
  const repoPayload = (over: Record<string, unknown> = {}) => ({
    full_name: 'a/b', pushed_at: '2026-10-01T12:00:00.000Z', stargazers_count: 5, archived: false, ...over,
  })
  const rate = () => jsonResponse({ resources: { core: { remaining: 100, limit: 100, reset: 0 } } })

  it('每个仓打一次仓库接口，pushed_at 超阈值才判 stale', async () => {
    await enable(['a/b', 'c/d'])
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return rate()
      if (url.endsWith('/repos/a/b')) return jsonResponse(repoPayload({ pushed_at: '2024-01-01T00:00:00.000Z' }))
      if (url.endsWith('/repos/c/d')) return jsonResponse(repoPayload({ full_name: 'c/d' }))
      throw new Error(`不该打: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)

    const report = await auditRepoFreshness(365)
    expect(report.checked).toBe(2)
    expect(report.items.find(i => i.repo === 'a/b')?.stale).toBe(true)
    expect(report.items.find(i => i.repo === 'c/d')?.stale).toBe(false)
    expect(fetch.mock.calls.filter(([u]) => String(u).includes('/repos/')).length).toBe(2)
  })

  it('404 判"已消失"、archived 判停更，两者都进 stale', async () => {
    await enable(['a/b', 'c/d', 'e/f'])
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return rate()
      if (url.endsWith('/repos/a/b')) return new Response('{"message":"Not Found"}', { status: 404 })
      if (url.endsWith('/repos/c/d')) return jsonResponse(repoPayload({ full_name: 'c/d', archived: true }))
      return jsonResponse(repoPayload({ full_name: 'e/f' }))
    }))

    const report = await auditRepoFreshness(365)
    const gone = report.items.find(i => i.repo === 'a/b')
    expect(gone?.missing).toBe(true)
    expect(gone?.stale).toBe(true)
    const archived = report.items.find(i => i.repo === 'c/d')
    expect(archived?.archived).toBe(true)
    expect(archived?.stale).toBe(true)
    expect(report.failed).toEqual([])
  })

  it('超时与 5xx 只进 failed，绝不判成停更 —— 没查到不等于不动了', async () => {
    await enable(['a/b', 'c/d'])
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return rate()
      if (url.endsWith('/repos/a/b')) throw new Error('socket hang up')
      return new Response('bad gateway', { status: 502 })
    }))

    const report = await auditRepoFreshness(365)
    expect(report.items).toEqual([])
    expect(report.failed.length).toBe(2)
    expect(report.failed.join(' ')).toContain('socket hang up')
    expect(report.failed.join(' ')).toContain('HTTP 502')
  })

  it('跟完重定向后名字变了要说"改名到"，但不算停更（GitHub 的重定向一直有效）；只差大小写不算搬家', async () => {
    await enable(['a/b'])
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return rate()
      return jsonResponse(repoPayload({ full_name: 'new/owner-name' }))
    }))
    const moved = await auditRepoFreshness(365)
    expect(moved.items[0].movedTo).toBe('new/owner-name')
    expect(moved.items[0].stale).toBe(false)

    await enable(['A/B'])
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return rate()
      return jsonResponse(repoPayload({ full_name: 'a/b' }))
    }))
    const cased = await auditRepoFreshness(365)
    expect(cased.items[0].movedTo).toBe('')
  })

  it('每个仓在候选表里还剩多少行要一起报回来（剔仓的人得知道会连带清掉多少）', async () => {
    await enable(['a/b', 'c/d'])
    seedSuspect({ repo: 'a/b' })
    seedSuspect({ repo: 'a/b' })
    seedSuspect({ repo: 'c/d' })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return rate()
      return jsonResponse(repoPayload({ full_name: url.endsWith('/repos/c/d') ? 'c/d' : 'a/b' }))
    }))

    const report = await auditRepoFreshness(365)
    expect(report.items.find(i => i.repo === 'a/b')?.candidates).toBe(2)
    expect(report.items.find(i => i.repo === 'c/d')?.candidates).toBe(1)
  })

  it('配额不够就报差额，一个仓库接口都不打（体检是 N 次调用，不是免费的）', async () => {
    await enable(['a/b', 'c/d', 'e/f'])
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 2, limit: 60, reset: 0 } } })
      throw new Error(`不该再打了: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)

    await expect(auditRepoFreshness(365)).rejects.toThrow(/余量 2，体检 3 个仓/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('阈值钳在 30~3650 天：填 1 天不会把清单剔空', async () => {
    await enable(['a/b'])
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return rate()
      return jsonResponse(repoPayload({ pushed_at: new Date(Date.now() - 10 * 86_400_000).toISOString() }))
    }))

    const report = await auditRepoFreshness(1)
    expect(report.maxAgeDays).toBe(30)
    expect(report.items[0].stale).toBe(false)
  })

  it('清单是空的就没得体检，也不打网络', async () => {
    await saveDiscoverySettings({ enabled: true, repos: [] })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(auditRepoFreshness()).rejects.toThrow(/空的/)
    expect(fetch).not.toHaveBeenCalled()
  })
})

// ————— 有 release 的仓只取最新那一次发布 —————
describe('完整性锚点', () => {
  it('assetDigestHex 只认 64 位 hex：取不出就当没有锚点，不能拿解析错的串拒掉好源', () => {
    expect(assetDigestHex(`sha256:${'a'.repeat(64)}`)).toBe('a'.repeat(64))
    expect(assetDigestHex(`sha256=${'A'.repeat(64)}`)).toBe('a'.repeat(64))
    expect(assetDigestHex('a'.repeat(64))).toBe('a'.repeat(64))
    expect(assetDigestHex('sha256:太短')).toBe('')
    expect(assetDigestHex('')).toBe('')
    expect(assetDigestHex(undefined)).toBe('')
  })

  it('verifyContentAnchor：release 看 sha256，tree 看 blob sha，两个都没有是"无从校验"而不是通过', () => {
    const hex = createHash('sha256').update(FAKE_SOURCE_SCRIPT, 'utf8').digest('hex')
    expect(verifyContentAnchor(FAKE_SOURCE_SCRIPT, '', `sha256:${hex}`)).toBe(true)
    expect(verifyContentAnchor(FAKE_SOURCE_SCRIPT, '', `sha256:${'f'.repeat(64)}`)).toBe(false)
    expect(verifyContentAnchor(FAKE_SOURCE_SCRIPT, gitBlobSha(FAKE_SOURCE_SCRIPT), '')).toBe(true)
    expect(verifyContentAnchor(FAKE_SOURCE_SCRIPT, '', '')).toBeNull()
  })

  it('判级遇到 digest 对不上：拒绝执行，说的是 sha256 而不是 blob sha', async () => {
    await enable(['a/b'])
    const id = seedSuspect({
      path: 'HYWmusic_v1.0.3.js', releaseTag: 'v260908', assetDigest: `sha256:${'f'.repeat(64)}`, blobSha: '',
      rawUrl: 'https://github.com/a/b/releases/download/v260908/HYWmusic_v1.0.3.js',
    })
    const runner = fakeRunner()
    _setRunnerForTest(runner)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 100, limit: 100, reset: 0 } } })
      return new Response(FAKE_SOURCE_SCRIPT, { headers: { 'content-type': 'text/plain' } })
    }))

    const report = await probeCandidate(id)
    expect(report.shaVerified).toBe(false)
    expect(report.note).toContain('sha256')
    expect(runner.validateScript).not.toHaveBeenCalled()
  })

  it('导入一条 release 候选：复验交给导入通道的是 sha256，不再是 blob sha', async () => {
    await enable(['a/b'])
    const hex = createHash('sha256').update(FAKE_SOURCE_SCRIPT, 'utf8').digest('hex')
    const downloadUrl = 'https://github.com/a/b/releases/download/v260908/HYWmusic_v1.0.3.js'
    const id = seedSuspect({
      path: 'HYWmusic_v1.0.3.js', rawUrl: downloadUrl, blobSha: '',
      assetDigest: `sha256:${hex}`, releaseTag: 'v260908', probeJson: probeReportOf({ tx: 'ok' }),
    })
    importSubscriptionMock.mockResolvedValue({ path: 'custom-sources/合成测试音源.js', name: '合成测试音源' })

    await importCandidate(id)
    expect(importSubscriptionMock).toHaveBeenCalledWith(downloadUrl, { expectedSha256: hex })
  })
})

describe('最新 release 采集（散 js ＋ 最近的一个 zip）', () => {
  const HEX_A = 'a'.repeat(64)
  const HEX_B = 'b'.repeat(64)
  const rate = () => jsonResponse({ resources: { core: { remaining: 100, limit: 100, reset: 0 } } })

  const jsAsset = (name: string, over: Record<string, unknown> = {}) => ({ name, size: 11_000, digest: `sha256:${HEX_A}`, ...over })
  const zipAsset = (name: string, digest: string) => ({ name, size: 282_000, digest: `sha256:${digest}` })
  const release = (tag: string, publishedAt: string, assets: Array<Record<string, unknown>>) => ({
    tag_name: tag, published_at: publishedAt, prerelease: false, assets,
  })

  /** 自造的 zip 夹具：形状照真包（deflate + 中央目录存大小） */
  function makeZip(files: Array<{ name: string; body: string }>): Buffer {
    const parts: Buffer[] = []
    const central: Buffer[] = []
    let offset = 0
    for (const file of files) {
      const nameBuf = Buffer.from(file.name, 'utf8')
      const body = Buffer.from(file.body, 'utf8')
      const data = zlib.deflateRawSync(body)
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0x808, 6)
      local.writeUInt16LE(8, 8)
      local.writeUInt32LE(data.length, 18)
      local.writeUInt32LE(body.length, 22)
      local.writeUInt16LE(nameBuf.length, 26)
      parts.push(local, nameBuf, data)
      const record = Buffer.alloc(46)
      record.writeUInt32LE(0x02014b50, 0)
      record.writeUInt16LE(20, 4)
      record.writeUInt16LE(20, 6)
      record.writeUInt16LE(0x808, 8)
      record.writeUInt16LE(8, 10)
      record.writeUInt32LE(data.length, 20)
      record.writeUInt32LE(body.length, 24)
      record.writeUInt16LE(nameBuf.length, 28)
      record.writeUInt32LE(offset, 42)
      central.push(record, nameBuf)
      offset += local.length + nameBuf.length + data.length
    }
    const cd = Buffer.concat(central)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(files.length, 8)
    eocd.writeUInt16LE(files.length, 10)
    eocd.writeUInt32LE(cd.length, 12)
    eocd.writeUInt32LE(offset, 16)
    return Buffer.concat([...parts, cd, eocd])
  }

  const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex')

  interface StubOptions {
    releases?: unknown
    /** zip 资产的响应：Buffer 当包体、Response 当异常响应、null 表示"下载会失败" */
    zipBody?: Buffer | Response | null
    scriptText?: string
  }

  /**
   * 一个仓的假通道：/releases?per_page=… 给发布列表，release 下载地址给 zip 包体或脚本文本。
   * 返回 urls（都打过哪些地址）与各计数，断言"有没有打仓库树/重下包"靠它。
   */
  function releaseStub(list: unknown[], opts: StubOptions = {}) {
    const urls: string[] = []
    const counts = { zipFetches: 0, scriptFetches: 0 }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      if (url.endsWith('/rate_limit')) return rate()
      if (url.includes('/releases?per_page=')) {
        return opts.releases !== undefined ? opts.releases as Response : jsonResponse(list)
      }
      if (url.includes('/git/trees/')) {
        return jsonResponse({ tree: [{ path: 'lx-music-source.js', type: 'blob', sha: 'tree1', size: 500 }], truncated: false })
      }
      if (url.includes('/releases/download/')) {
        // 同一个前缀下有两种东西：`.zip` 结尾给包体，其余是散 js 的正文 —— 不分开的话
        // 散 js 会拿到一包字节，digest 必然对不上，测出来的就是假失败
        if (/\.zip$/i.test(url)) {
          if (opts.zipBody instanceof Response) return opts.zipBody
          if (opts.zipBody) { counts.zipFetches++; return new Response(new Uint8Array(opts.zipBody)) }
          if (opts.zipBody === null) throw new Error('socket hang up')
        }
        counts.scriptFetches++
        return new Response(opts.scriptText ?? FAKE_SOURCE_SCRIPT, { headers: { 'content-type': 'text/plain' } })
      }
      counts.scriptFetches++
      return new Response(opts.scriptText ?? FAKE_SOURCE_SCRIPT, { headers: { 'content-type': 'text/plain' } })
    }))
    return { urls, counts, treeCalls: () => urls.filter(u => u.includes('/git/trees/')).length }
  }

  it('最新一次的散 js ＋ 更早一次发布里的 zip，两种一起收，且不扫仓库树', async () => {
    await enable(['a/b'])
    const zip = makeZip([{ name: 'V260817/其他/念心音源 v1.0.2.js', body: FAKE_SOURCE_SCRIPT }])
    const stub = releaseStub([
      release('v260908', '2026-09-08T11:23:47Z', [jsAsset('HYWmusic_._v1.0.3.js')]),
      release('2026.08.17', '2026-08-17T03:42:24Z', [zipAsset('V260817.zip', sha(zip))]),
    ], { zipBody: zip })

    const summary = await runDiscoveryCrawl()
    expect(stub.treeCalls()).toBe(0)
    expect(summary.seen).toBe(2)
    expect(summary.releaseRepos.join(' ')).toContain('散 js 1 条')
    expect(summary.releaseRepos.join(' ')).toContain('展开 1 条')
    const paths = rows.map(r => r.path)
    expect(paths).toContain('HYWmusic_._v1.0.3.js')
    // 包内条目的唯一键是 `包名!条目名`，同名的两个包不会互相覆盖
    expect(paths).toContain('V260817.zip!V260817/其他/念心音源 v1.0.2.js')
    const member = rows.find(r => r.path.includes('!'))!
    expect(member.zipMember).toBe('V260817/其他/念心音源 v1.0.2.js')
    expect(member.assetDigest).toBe(`sha256:${sha(zip)}`)
    expect(member.verdict).toBe('suspect')
    expect(stub.counts.scriptFetches).toBe(1)
    // 整包只下一次，两个条目不会各下一遍
    expect(stub.counts.zipFetches).toBe(1)
  })

  it('只有 zip 没有散 js 的仓（guoyue 那个形状）也走 release，不再白扫一遍 tree', async () => {
    await enable(['a/b'])
    const zip = makeZip([
      { name: 'V261003/gdstudio音乐源.js', body: FAKE_SOURCE_SCRIPT },
      { name: 'V261003/HelloWorld音源.js', body: FAKE_SOURCE_SCRIPT },
    ])
    const stub = releaseStub([release('V261003', '2026-10-03T02:31:44Z', [zipAsset('V261003.zip', sha(zip))])], { zipBody: zip })

    const summary = await runDiscoveryCrawl()
    expect(stub.treeCalls()).toBe(0)
    expect(summary.created).toBe(2)
    expect(summary.releaseFallbacks).toEqual([])
  })

  it('从没发过 release（200 空数组，这个接口不回 404）就静默回落扫 tree', async () => {
    await enable(['a/b'])
    const stub = releaseStub([])
    const summary = await runDiscoveryCrawl()
    expect(stub.treeCalls()).toBe(1)
    expect(summary.releaseFallbacks).toEqual([])
    expect(rows[0].path).toBe('lx-music-source.js')
  })

  it('有发布但既没散 js 也没 zip ⇒ 回落扫 tree，并把原因说清', async () => {
    await enable(['a/b'])
    const stub = releaseStub([release('v1', '2026-01-01T00:00:00Z', [{ name: 'bundle.txt', size: 10 }])])
    const summary = await runDiscoveryCrawl()
    expect(stub.treeCalls()).toBe(1)
    expect(summary.releaseFallbacks.join(' ')).toContain('没有 .js 资产')
    expect(summary.releaseFallbacks.join(' ')).toContain('没找到 zip')
  })

  it('release 接口 502 只是"这次没查到"：回落扫 tree，不写成"这仓没发布"', async () => {
    await enable(['a/b'])
    const stub = releaseStub([], { releases: new Response('bad gateway', { status: 502 }) })
    const summary = await runDiscoveryCrawl()
    expect(stub.treeCalls()).toBe(1)
    expect(summary.releaseFallbacks.join(' ')).toContain('HTTP 502')
  })

  it('散 js 收到了、包却下不动 ⇒ 不散 js 白丢，只记一句包的事', async () => {
    await enable(['a/b'])
    const stub = releaseStub([
      release('v2', '2026-09-08T00:00:00Z', [jsAsset('a.js')]),
      release('v1', '2026-08-08T00:00:00Z', [zipAsset('V1.zip', HEX_B)]),
    ], { zipBody: null })

    const summary = await runDiscoveryCrawl()
    expect(stub.treeCalls()).toBe(0)
    expect(summary.created).toBe(1)
    expect(summary.zipNotes.join(' ')).toContain('下载失败')
  })

  it('整包的 sha256 与发布记录不一致 ⇒ 这个包不收货，本轮退回扫 tree（解出来的东西不配进沙箱）', async () => {
    await enable(['a/b'])
    const zip = makeZip([{ name: 'V1/x.js', body: FAKE_SOURCE_SCRIPT }])
    const stub = releaseStub([release('v1', '2026-08-08T00:00:00Z', [zipAsset('V1.zip', HEX_B)])], { zipBody: zip })

    const summary = await runDiscoveryCrawl()
    expect(summary.zipNotes.join(' ')).toContain('sha256 与发布记录不一致')
    // 没收这个包，但也没让这一轮空手：退回 tree，且没有一条 zip 条目混进来
    expect(stub.treeCalls()).toBe(1)
    expect(rows.filter(r => r.zipMember)).toHaveLength(0)
    expect(rows[0].path).toBe('lx-music-source.js')
  })

  it('只有包、包又下不动 ⇒ 回落原因写"包没收进来"，不能张冠李戴成"这仓没有 .js 资产"', async () => {
    await enable(['a/b'])
    const stub = releaseStub(
      [release('V261003', '2026-10-03T02:31:44Z', [zipAsset('V261003.zip', HEX_A)])],
      { zipBody: null },
    )

    const summary = await runDiscoveryCrawl()
    expect(stub.treeCalls()).toBe(1)
    const note = summary.releaseFallbacks.join(' ')
    expect(note).toContain('V261003.zip 没收进来')
    expect(summary.zipNotes.join(' ')).toContain('下载失败')
  })

  it('一个包最多展开 50 条，剩下的写在结论里而不是静默丢', async () => {
    await enable(['a/b'])
    const many = Array.from({ length: 60 }, (_unused, index) => ({ name: `V1/f${index}.js`, body: 'x'.repeat(20) }))
    const zip = makeZip(many)
    releaseStub([release('v1', '2026-08-08T00:00:00Z', [zipAsset('V1.zip', sha(zip))])], { zipBody: zip })

    const summary = await runDiscoveryCrawl()
    expect(rows).toHaveLength(50)
    expect(summary.zipNotes.join(' ')).toContain('还有 10 个 .js 没登记')
    expect(summary.zipNotes.join(' ')).toContain('每包上限 50')
  })

  it('包没换（库里已记着同一个 sha256）就不再重下整包', async () => {
    await enable(['a/b'])
    const zip = makeZip([
      { name: 'V1/一.js', body: FAKE_SOURCE_SCRIPT },
      // 两条正文必须不同：同内容会被去重合成一条，那就测不出"复用 2 条"了
      { name: 'V1/二.js', body: FAKE_SOURCE_SCRIPT.replace('合成测试音源', '合成测试音源二号') },
    ])
    const list = [release('v1', '2026-08-08T00:00:00Z', [zipAsset('V1.zip', sha(zip))])]

    const first = releaseStub(list, { zipBody: zip })
    await runDiscoveryCrawl()
    expect(first.counts.zipFetches).toBe(1)

    const second = releaseStub(list, { zipBody: zip })
    const summary = await runDiscoveryCrawl()
    expect(second.counts.zipFetches).toBe(0)
    expect(second.treeCalls()).toBe(0)
    expect(summary.refreshed).toBe(2)
    expect(summary.zipNotes.join(' ')).toContain('跳过下载，复用 2 条')
  })

  it('改走 release 之后，tree 里那些不再刷新的历史行标成"已被顶掉"，行留着', async () => {
    await enable(['a/b'])
    const old = seedSuspect({ repo: 'a/b', path: '历史版本/v1.0.0.js' })
    const zip = makeZip([{ name: 'V1/新.js', body: FAKE_SOURCE_SCRIPT }])
    releaseStub([release('v1', '2026-08-08T00:00:00Z', [zipAsset('V1.zip', sha(zip))])], { zipBody: zip })

    const summary = await runDiscoveryCrawl()
    expect(summary.releaseSuperseded).toBe(1)
    expect(rows.find(r => r.id === old)?.state).toBe('stale')
    expect(rows).toHaveLength(2)
  })

  it('同一个资产换了内容（digest 变了）要重下；没变就不重下', async () => {
    await enable(['a/b'])
    releaseStub([release('v1', '2026-09-08T00:00:00Z', [jsAsset('a.js', { digest: `sha256:${HEX_A}` })])])
    await runDiscoveryCrawl()
    expect(rows[0].verdict).toBe('suspect')

    const unchanged = releaseStub([release('v1', '2026-09-08T00:00:00Z', [jsAsset('a.js', { digest: `sha256:${HEX_A}` })])])
    await runDiscoveryCrawl()
    expect(unchanged.counts.scriptFetches).toBe(0)

    const changed = releaseStub([release('v1', '2026-09-08T00:00:00Z', [jsAsset('a.js', { digest: `sha256:${HEX_B}` })])])
    await runDiscoveryCrawl()
    expect(changed.counts.scriptFetches).toBe(1)
  })

  it('GitHub 没给 digest 时不能拿"两边都是空串"当内容没变 —— 那会把更新固化掉', async () => {
    await enable(['a/b'])
    const list = [release('v1', '2026-09-08T00:00:00Z', [{ name: 'a.js', size: 500 }])]
    const first = releaseStub(list)
    await runDiscoveryCrawl()
    expect(first.counts.scriptFetches).toBe(1)

    const again = releaseStub(list)
    await runDiscoveryCrawl()
    expect(again.counts.scriptFetches).toBe(1)
  })

  it('关掉开关就回到"只扫 tree"：release 接口一次都不打', async () => {
    await saveDiscoverySettings({ enabled: true, repos: ['a/b'], preferLatestRelease: false })
    const stub = releaseStub([release('v1', '2026-09-08T00:00:00Z', [jsAsset('a.js')])])
    await runDiscoveryCrawl()
    expect(stub.urls.some(u => u.includes('/releases?per_page='))).toBe(false)
    expect(stub.treeCalls()).toBe(1)
  })

  it('pickReleaseAssets：按 published_at 排，不靠接口返回顺序；zip 是从新往旧数的第一个', () => {
    const picked = pickReleaseAssets([
      release('旧', '2026-01-01T00:00:00Z', [zipAsset('old.zip', HEX_A)]),
      release('最新散js', '2026-09-08T00:00:00Z', [jsAsset('new.js'), { name: 'notes.md', size: 10 }]),
      release('中间', '2026-05-05T00:00:00Z', [zipAsset('mid.zip', HEX_B)]),
    ])
    expect(picked.loose.map(item => item.asset.name)).toEqual(['new.js'])
    // 最近的一个 zip 是 5-05 那次，不是 1-01 那次
    expect(picked.zip?.asset.name).toBe('mid.zip')
    expect(picked.zip?.tag).toBe('中间')
  })

  it('pre-release 也算（这类仓常把汇总包发成 pre-release）', () => {
    const picked = pickReleaseAssets([
      { tag_name: 'v2', published_at: '2026-09-08T00:00:00Z', prerelease: true, assets: [jsAsset('beta.js')] },
    ])
    expect(picked.loose.map(item => item.asset.name)).toEqual(['beta.js'])
  })
})

describe('包内条目的复验与导入', () => {
  const zipOf = (files: Array<{ name: string; body: string }>) => {
    // 复用上一个套件里的构造思路（每个 describe 自己带一份，避免跨 describe 共享夹具带来的顺序依赖）
    const parts: Buffer[] = []
    const central: Buffer[] = []
    let offset = 0
    for (const file of files) {
      const nameBuf = Buffer.from(file.name, 'utf8')
      const body = Buffer.from(file.body, 'utf8')
      const data = zlib.deflateRawSync(body)
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0x808, 6)
      local.writeUInt16LE(8, 8)
      local.writeUInt32LE(data.length, 18)
      local.writeUInt32LE(body.length, 22)
      local.writeUInt16LE(nameBuf.length, 26)
      parts.push(local, nameBuf, data)
      const record = Buffer.alloc(46)
      record.writeUInt32LE(0x02014b50, 0)
      record.writeUInt16LE(20, 4)
      record.writeUInt16LE(20, 6)
      record.writeUInt16LE(0x808, 8)
      record.writeUInt16LE(8, 10)
      record.writeUInt32LE(data.length, 20)
      record.writeUInt32LE(body.length, 24)
      record.writeUInt16LE(nameBuf.length, 28)
      record.writeUInt32LE(offset, 42)
      central.push(record, nameBuf)
      offset += local.length + nameBuf.length + data.length
    }
    const cd = Buffer.concat(central)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(files.length, 8)
    eocd.writeUInt16LE(files.length, 10)
    eocd.writeUInt32LE(cd.length, 12)
    eocd.writeUInt32LE(offset, 16)
    return Buffer.concat([...parts, cd, eocd])
  }
  const ZIP_URL = 'https://github.com/a/b/releases/download/v1/V1.zip'
  const locator = (digest: string, member = 'V1/一.js') => ({ rawUrl: ZIP_URL, blobSha: '', assetDigest: `sha256:${digest}`, zipMember: member })

  it('取包内条目：先复验整包 sha256，对上了才解，anchor=true', async () => {
    const zip = zipOf([{ name: 'V1/一.js', body: FAKE_SOURCE_SCRIPT }])
    const digest = createHash('sha256').update(zip).digest('hex')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(zip))))

    const fetched = await fetchCandidateContent(locator(digest), 'tok')
    expect(fetched.anchor).toBe(true)
    expect(fetched.content).toBe(FAKE_SOURCE_SCRIPT)
  })

  it('整包 sha256 对不上 ⇒ anchor=false，一个字节都不给下游', async () => {
    const zip = zipOf([{ name: 'V1/一.js', body: FAKE_SOURCE_SCRIPT }])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(zip))))

    const fetched = await fetchCandidateContent(locator('f'.repeat(64)), 'tok')
    expect(fetched.anchor).toBe(false)
    expect(fetched.content).toBe('')
    expect(fetched.reason).toContain('sha256 与发布记录不一致')
  })

  it('包里找不到记录的那个条目（上游重发过包）也判 false，不拿别的条目顶上去', async () => {
    const zip = zipOf([{ name: 'V1/别的.js', body: FAKE_SOURCE_SCRIPT }])
    const digest = createHash('sha256').update(zip).digest('hex')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(zip))))

    const fetched = await fetchCandidateContent(locator(digest), 'tok')
    expect(fetched.anchor).toBe(false)
    expect(fetched.reason).toContain('没有记录的那个条目')
  })

  it('GitHub 没给 digest 的包：照取，但 anchor=null（无从校验，不等于通过）', async () => {
    const zip = zipOf([{ name: 'V1/一.js', body: FAKE_SOURCE_SCRIPT }])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(zip))))
    const fetched = await fetchCandidateContent({ rawUrl: ZIP_URL, blobSha: '', assetDigest: '', zipMember: 'V1/一.js' }, 'tok')
    expect(fetched.anchor).toBeNull()
    expect(fetched.content).toBe(FAKE_SOURCE_SCRIPT)
  })

  it('判级一条包内候选：复验整包通过后解出条目再进一次性进程', async () => {
    await enable(['a/b'])
    const zip = zipOf([{ name: 'V1/一.js', body: FAKE_SOURCE_SCRIPT }])
    const digest = createHash('sha256').update(zip).digest('hex')
    const id = seedSuspect({
      path: 'V1.zip!V1/一.js', rawUrl: ZIP_URL, blobSha: '', assetDigest: `sha256:${digest}`,
      releaseTag: 'v1', zipMember: 'V1/一.js',
    })
    const runner = fakeRunner()
    _setRunnerForTest(runner)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 100, limit: 100, reset: 0 } } })
      return new Response(new Uint8Array(zip))
    }))

    const report = await probeCandidate(id)
    expect(report.shaVerified).toBe(true)
    expect(runner.validateScript.mock.calls[0][0]).toBe(FAKE_SOURCE_SCRIPT)
  })

  it('判级时整包对不上 ⇒ 拒绝执行，一次性进程一次都不起', async () => {
    await enable(['a/b'])
    const zip = zipOf([{ name: 'V1/一.js', body: FAKE_SOURCE_SCRIPT }])
    const id = seedSuspect({
      path: 'V1.zip!V1/一.js', rawUrl: ZIP_URL, assetDigest: `sha256:${'f'.repeat(64)}`,
      releaseTag: 'v1', zipMember: 'V1/一.js',
    })
    const runner = fakeRunner()
    _setRunnerForTest(runner)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/rate_limit')) return jsonResponse({ resources: { core: { remaining: 100, limit: 100, reset: 0 } } })
      return new Response(new Uint8Array(zip))
    }))

    const report = await probeCandidate(id)
    expect(report.shaVerified).toBe(false)
    expect(report.note).toContain('拒绝执行')
    expect(runner.validateScript).not.toHaveBeenCalled()
  })

  it('导入一条包内候选：正文是解出来的条目，且**不登记订阅**（订阅更新对包内条目没意义）', async () => {
    await enable(['a/b'])
    const zip = zipOf([{ name: 'V1/一.js', body: FAKE_SOURCE_SCRIPT }])
    const digest = createHash('sha256').update(zip).digest('hex')
    const id = seedSuspect({
      path: 'V1.zip!V1/一.js', rawUrl: ZIP_URL, assetDigest: `sha256:${digest}`,
      releaseTag: 'v1', zipMember: 'V1/一.js', probeJson: probeReportOf({ tx: 'ok' }),
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(zip))))
    importSubscriptionMock.mockResolvedValue({ path: 'custom-sources/一.js', name: '一' })

    await importCandidate(id)
    expect(importSubscriptionMock).toHaveBeenCalledWith(ZIP_URL, {
      content: FAKE_SOURCE_SCRIPT, filename: '一.js', subscribe: false,
    })
  })

  it('导入时整包对不上就拒，导入通道一次都不碰', async () => {
    await enable(['a/b'])
    const zip = zipOf([{ name: 'V1/一.js', body: FAKE_SOURCE_SCRIPT }])
    const id = seedSuspect({
      path: 'V1.zip!V1/一.js', rawUrl: ZIP_URL, assetDigest: `sha256:${'e'.repeat(64)}`,
      releaseTag: 'v1', zipMember: 'V1/一.js', probeJson: probeReportOf({ tx: 'ok' }),
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(zip))))

    await expect(importCandidate(id)).rejects.toThrow(/sha256 与发布记录不一致/)
    expect(importSubscriptionMock).not.toHaveBeenCalled()
  })
})

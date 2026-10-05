/**
 * 音源发现（P0-a 发现 / P0-b 判级 / P0-c 导入）的服务层测试。
 *
 * 两处刻意的做法：
 * - 把 safePublicFetch 桥到 global fetch 上（DNS 解析在测试里没有意义），但**请求形状**照验；
 * - 假脚本正文全部是本文件自己写的特征骨架，不引入任何真实音源脚本内容。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
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
  normalizeRepo, isPlausibleScriptPath, scoreCandidate, toNameKey, betterKeeper,
  runDiscoveryCrawl, saveDiscoverySettings, DEFAULT_DISCOVERY_SETTINGS,
  probeCandidate, importCandidate, dismissCandidate, listCandidates,
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
    if (typeof where.id === 'number') return rows.find(r => r.id === where.id) ?? null
    const target = where.repo_path!
    return rows.find(r => r.repo === target.repo && r.path === target.path) ?? null
  })
  prismaMock.sourceCandidate.create = vi.fn(async ({ data }: CreateArgs) => {
    // 补齐 schema 里带 @default 的列：真库由 Prisma 填，假库要自己填，否则测不出真实形状
    const row = {
      blobSha: '', scriptName: '', nameKey: '', contentHash: '', upstreamAt: '', sizeBytes: 0, score: 0,
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
    const where = (args?.where ?? {}) as { verdict?: string; state?: string; probeJson?: string; OR?: Array<Record<string, unknown>> }
    let out = rows
    if (where.verdict) out = out.filter(r => r.verdict === where.verdict)
    if (where.state) out = out.filter(r => r.state === where.state)
    if (where.probeJson !== undefined) out = out.filter(r => r.probeJson === where.probeJson)
    if (where.OR) {
      const match = (row: Row, branch: Record<string, unknown>) => {
        const want = row.probeJson as string
        if (typeof branch.probeJson === 'string') return want === branch.probeJson
        const contains = (branch.probeJson as { contains?: string } | undefined)?.contains
        return contains ? want.includes(contains) : true
      }
      out = out.filter(row => where.OR!.some(branch => match(row, branch)))
    }
    return typeof args?.take === 'number' ? out.slice(0, args.take) : out
  })
  prismaMock.sourceCandidate.groupBy = vi.fn(async () => [])
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

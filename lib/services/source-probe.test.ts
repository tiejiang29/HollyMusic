/**
 * 音源周测回归测试。钉住四件容易静默失效的事：
 * 1. 探测绝不能写实时健康账本，否则探测自身的抖动会被 3c 当成真实用户的坏证据；
 * 2. 一格多首基准曲的合并规则（有一首出货就算这格可用）；
 * 3. 先验只给判坏的格子注入，挂起类走长档，好格不碰；
 * 4. 更新的一批要覆盖旧批次（否则源修好了先验还在拖它）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  probeSourceUrl: vi.fn(),
  safePublicFetch: vi.fn(),
  prisma: {
    $queryRaw: vi.fn(),
    musicInfo: { findMany: vi.fn() },
    sourceProbeRun: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    sourceProbeResult: { create: vi.fn(), findMany: vi.fn() },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/db', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/services/source-manager-service', () => ({ listSourcesWithStatus: vi.fn() }))
vi.mock('@/lib/server/url-guard', () => ({ safePublicFetch: mocks.safePublicFetch }))
vi.mock('@/lib/music-source-manager', () => ({
  musicSourceManager: { ensureFresh: vi.fn(async () => {}), probeSourceUrl: mocks.probeSourceUrl },
  readUrlBudgets: () => ({ urlMs: 15_000, perSourceMs: 8_000, totalMs: 18_000 }),
}))

const { planCells, latestProbeCells, seedHealthFromProbe, runSourceProbe } = await import('@/lib/services/source-probe')
const { listSourcesWithStatus } = await import('@/lib/services/source-manager-service')
const { sourceHealth } = await import('@/lib/server/source-health')

const PLATFORMS = ['kw', 'tx', 'wy', 'kg', 'mg']
const FLAC = Buffer.from('fLaC' + '0'.repeat(60))
const TEXT = Buffer.from('{"code":404,"msg":"gone"}' + ' '.repeat(60))

const audioResponse = () => ({
  ok: true, status: 200,
  headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'audio/flac' : null) },
  arrayBuffer: async () => FLAC,
  body: { cancel: async () => {} },
})
/** Content-Type 谎称 audio/mpeg、真取是 JSON —— 摸底实测的那类假地址 */
const textResponse = (status = 200) => ({
  ok: status < 400, status,
  headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'audio/mpeg' : null) },
  arrayBuffer: async () => TEXT,
  body: { cancel: async () => {} },
})

/** 每平台两首基准曲（顺带覆盖"一格多样本"的合并路径）；id → 平台 固定映射 */
const ID_OF_PLATFORM: Record<string, number[]> = { kw: [1, 2], tx: [3, 4], wy: [5, 6], kg: [7, 8], mg: [9, 10] }
const PLATFORM_OF_ID = new Map(PLATFORMS.flatMap(p => ID_OF_PLATFORM[p].map(id => [id, p] as const)))

function stubSampleQueries() {
  mocks.prisma.$queryRaw.mockImplementation(async (_strings: unknown, platform: unknown) =>
    ID_OF_PLATFORM[platform as string].map(id => ({ id })))
  mocks.prisma.musicInfo.findMany.mockImplementation(async (arg: { where: { id?: { in?: number[] } } }) => {
    const ids = arg.where.id?.in
    if (!ids) return []
    return ids.map(id => {
      const platform = PLATFORM_OF_ID.get(id)!
      return {
        id, source: platform, songmid: `${platform}-${id}`,
        data: JSON.stringify({ id: `${platform}-${id}`, name: '测试歌', singer: '测试歌手' }),
        name: '测试歌', singer: '测试歌手', durationSeconds: 200, hash: null, copyrightId: null,
        songId: null, albumId: null, albumMid: null, strMediaMid: null,
      }
    })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  sourceHealth.reset()
  mocks.prisma.sourceProbeRun.create.mockResolvedValue({ id: 7 })
  mocks.prisma.sourceProbeRun.update.mockResolvedValue({})
  mocks.prisma.sourceProbeResult.create.mockResolvedValue({})
  stubSampleQueries()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('planCells', () => {
  it('pt 白名单外的平台不列进批次（与瀑布同口径：不该测的格不测）', () => {
    const samples = { kw: [{ songmid: 'k1' }], tx: [{ songmid: 't1' }], wy: [{ songmid: 'w1' }] } as never
    const cells = planCells([{ name: '只支持酷我的源', pt: ['kw'] }, { name: '未声明 pt 的源' }], samples)
    expect(cells.filter(c => c.source === '只支持酷我的源').map(c => c.platform)).toEqual(['kw'])
    expect(cells.filter(c => c.source === '未声明 pt 的源').length).toBe(3)
  })
})

describe('runSourceProbe', () => {
  it('逐格取址 + 拉首块，结论落库，且一个实时账本样本都不写', async () => {
    vi.mocked(listSourcesWithStatus).mockResolvedValue([
      { name: '好源', path: 'a.js', enabled: true, pt: ['kw', 'tx'] },
      { name: '假地址源', path: 'b.js', enabled: true, pt: ['kw'] },
      { name: '停用的源', path: 'c.js', enabled: false, pt: ['kw'] },
    ] as never)
    mocks.probeSourceUrl.mockImplementation(async (name: string, musicInfo: { source: string }) =>
      name === '假地址源'
        ? { ok: true, url: 'https://up.example/fake.mp3', latencyMs: 120 }
        : { ok: true, url: `https://up.example/${musicInfo.source}.flac`, latencyMs: 300 })
    mocks.safePublicFetch.mockImplementation(async (url: string) => (url.includes('fake.mp3') ? textResponse() : audioResponse()))

    const summary = await runSourceProbe('manual')

    // 好源 2 平台 × 2 首 = 4 格；假地址源 1 平台 × 2 首 = 2 格
    expect(summary.probed).toBe(6)
    expect(summary.okCount).toBe(4)
    expect(summary.badCount).toBe(2)
    const written = mocks.prisma.sourceProbeResult.create.mock.calls.map(c => c[0].data)
    expect(written.find(r => r.source === '假地址源')).toMatchObject({ platform: 'kw', outcome: 'fake' })
    expect(written.every(r => r.quality === '320k')).toBe(true)
    expect(written.some(r => r.source === '停用的源')).toBe(false)
    // 关键隔离：探测证据不进真实流量账本，否则 3c 会把它当用户遇到的坏去熔断
    expect(sourceHealth.snapshot()).toEqual([])
    expect(mocks.prisma.sourceProbeRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'done' }) })
    )
  })

  it('同一时刻只跑一批：并发调用复用同一个 promise', async () => {
    vi.mocked(listSourcesWithStatus).mockResolvedValue([{ name: '好源', path: 'a.js', enabled: true, pt: ['kw'] }] as never)
    mocks.probeSourceUrl.mockResolvedValue({ ok: true, url: 'https://up.example/a.flac', latencyMs: 100 })
    mocks.safePublicFetch.mockResolvedValue(audioResponse())

    const [a, b] = await Promise.all([runSourceProbe('manual'), runSourceProbe('schedule')])
    expect(a).toBe(b)
    expect(mocks.prisma.sourceProbeRun.create).toHaveBeenCalledTimes(1)
  })

  it('取址就失败的格子不再发首块请求，结局按取址口径记', async () => {
    vi.mocked(listSourcesWithStatus).mockResolvedValue([{ name: '挂起源', path: 'a.js', enabled: true, pt: ['kw'] }] as never)
    mocks.probeSourceUrl.mockResolvedValue({ ok: false, outcome: 'timeout', reason: '取址超时', latencyMs: 8_000 })
    mocks.safePublicFetch.mockResolvedValue(audioResponse())

    const summary = await runSourceProbe('manual')

    expect(summary.badCount).toBe(2) // kw 的两首基准曲都算进这一格
    expect(mocks.safePublicFetch).not.toHaveBeenCalled()
    expect(mocks.prisma.sourceProbeResult.create.mock.calls[0][0].data).toMatchObject({ outcome: 'timeout', latencyMs: 8_000 })
  })
})

describe('latestProbeCells 与先验注入', () => {
  const run1 = new Date('2026-09-19T11:00:00Z')
  const run2 = new Date('2026-09-19T11:30:00Z')
  const row = (over: Record<string, unknown> = {}) => ({
    runAt: run1, source: '源A', platform: 'kw', outcome: 'ok', reason: null, latencyMs: 300, ...over,
  })
  /** 键是内部拼的 `源+分隔符+平台`，测试里按前后缀匹配即可，不必复制那个分隔符 */
  const findCell = (
    cells: Map<string, { outcome: string; runAt: Date }>, source: string, platform: string
  ) => [...cells.entries()]
    .filter(([k]) => k.startsWith(source) && k.endsWith(platform))
    .map(([, v]) => v)[0]

  it('一格两样本：有一首出货就算这格可用', async () => {
    mocks.prisma.sourceProbeResult.findMany.mockResolvedValue([
      row({ outcome: 'error', reason: '脚本内部报错' }), row({ outcome: 'ok' }),
    ] as never)
    expect(findCell(await latestProbeCells(), '源A', 'kw')?.outcome).toBe('ok')
  })

  it('全不出货时取最恶劣的结局，且更新的一批覆盖旧批次', async () => {
    mocks.prisma.sourceProbeResult.findMany.mockResolvedValue([
      row({ outcome: 'error' }), row({ outcome: 'no-address' }),
      row({ source: '源B', outcome: 'timeout' }), row({ source: '源B', outcome: 'error' }),
      // 源A 新批次里修好了：旧批次的 error 不能再作数
      row({ source: '源A', runAt: run2, outcome: 'ok' }),
    ] as never)
    const cells = await latestProbeCells()
    expect(findCell(cells, '源B', 'kw')?.outcome).toBe('timeout')
    expect(findCell(cells, '源A', 'kw')?.outcome).toBe('ok')
    expect(findCell(cells, '源A', 'kw')?.runAt.getTime()).toBe(run2.getTime())
  })

  it('先验只给判坏的格子注入，出货与"没搜到"都不碰', async () => {
    mocks.prisma.sourceProbeResult.findMany.mockResolvedValue([
      row({ source: '坏源', outcome: 'fake', reason: '响应是文本/HTML/JSON，不是音频' }),
      row({ source: '好源', outcome: 'ok' }),
      row({ source: '没版权源', outcome: 'no-address' }),
    ] as never)

    expect(await seedHealthFromProbe()).toBe(1)
    expect(sourceHealth.coolStatus('坏源', 'kw').skip).toBe(true)
    expect(sourceHealth.coolStatus('好源', 'kw').skip).toBe(false)
    expect(sourceHealth.coolStatus('没版权源', 'kw').skip).toBe(false)
    // 先验要能看出出处：面板 title 直接读 lastBadReason
    expect(sourceHealth.view('坏源', 'kw')?.lastBadReason).toContain('周测')
  })

  it('挂起类先验走长档（5min），快速失败走 60s', async () => {
    mocks.prisma.sourceProbeResult.findMany.mockResolvedValue([
      row({ source: '挂起的', outcome: 'timeout' }),
      row({ source: '快速失败的', outcome: 'error', platform: 'tx' }),
    ] as never)
    // 冻结时钟：retryAfterMs 是"冷却截止 - now"，跨一毫秒就会差 1
    vi.useFakeTimers({ now: new Date('2026-09-19T12:00:00Z').getTime() })
    await seedHealthFromProbe()

    expect(sourceHealth.coolStatus('挂起的', 'kw').retryAfterMs).toBe(300_000)
    expect(sourceHealth.coolStatus('快速失败的', 'tx').retryAfterMs).toBe(60_000)
  })

  it('先验判错也能自己爬回来：冷却到期放半开，一次真实成功即彻底解除', async () => {
    mocks.prisma.sourceProbeResult.findMany.mockResolvedValue([row({ source: '被冤枉的', outcome: 'error' })] as never)
    await seedHealthFromProbe()
    expect(sourceHealth.coolStatus('被冤枉的', 'kw').skip).toBe(true)

    vi.useFakeTimers({ now: Date.now() })
    vi.advanceTimersByTime(60_001)
    expect(sourceHealth.claimProbe('被冤枉的', 'kw')).toBe(true)
    sourceHealth.recordResolve('被冤枉的', 'kw', 'ok', 200)
    expect(sourceHealth.coolStatus('被冤枉的', 'kw').skip).toBe(false)
    expect(sourceHealth.view('被冤枉的', 'kw')?.backoffs).toBe(0)
  })
})

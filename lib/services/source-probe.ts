/**
 * 音源周测（3c 的先验来源）。
 *
 * 要解决的问题：健康账本是纯内存的，重启即清零，于是 3c 每次冷启动都全盲——实测面板上
 * 只有 1/31 格有数据，因为瀑布止于首个出货的源，排在后面的源天然没有样本。周测主动把
 * 「启用源 × 平台」全矩阵跑一遍并落库，启动时再把判坏的格子作为先验注回账本。
 *
 * 三条设计约束：
 * 1. **不写实时账本**（取址走 manager.probeSourceUrl，字节段在这里自己判）。探测证据与
 *    真实用户证据必须分开，否则探测自身的抖动会被 3c 当成"用户遇到的坏"去熔断。
 * 2. **只取址不够**。摸底实测过：地址给了、Content-Type 谎称 audio/mpeg、真取是 404 + 64
 *    字节文本。所以每格都要拉一次首块，判据复用生产的 judgeUpstreamPayload。
 * 3. **先验只设冷却，不塞假样本**。冷却到期照常半开，一次真实成功即彻底恢复——先验错了
 *    最多浪费一首歌，不会把一个源永久锁死。
 */

import { logger } from '@/lib/logger'
import { prisma } from '@/lib/db'
import { musicSourceManager, readUrlBudgets } from '@/lib/music-source-manager'
import { sourceHealth } from '@/lib/server/source-health'
import { judgeUpstreamPayload, SNIFF_HEAD_BYTES } from '@/lib/server/audio-sniff'
import { safePublicFetch } from '@/lib/server/url-guard'
import { listSourcesWithStatus } from '@/lib/services/source-manager-service'
import type { SourceProbeVerdict, SourceWithStatus } from '@/lib/services/source-manager-service'
import type { MusicInfo, QualityType } from '@/lib/types/music'

/** 全平台清单（与音源脚本声明的平台口径一致） */
const PLATFORMS = ['kw', 'tx', 'wy', 'kg', 'mg'] as const
/** 每平台几首基准曲。2 首是摸底用的量：单首会把"源里没这首歌"当成坏 */
const SAMPLES_PER_PLATFORM = 2
/** 固定探测音质。摸底结论：坏的主流形态与音质档无关，多档只会成倍放大成本 */
const PROBE_QUALITY: QualityType = '320k'
/** 首块预算与字节数 */
const HEAD_TIMEOUT_MS = 8_000
const HEAD_BYTES = 64 * 1024
/** 格与格之间的喘息：NAS 是低配常驻进程，探测不该排到用户请求前面 */
const GAP_BETWEEN_CELLS_MS = 150
/** 先验有效期：跨过一个完整周期仍算数，再老就不认（音源更新后随时可能恢复） */
const PRIOR_TTL_MS = 9 * 24 * 60 * 60 * 1000
const DEFAULT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

/** 计坏的结局（与账本的 RESOLVE_BAD ∪ BYTE_BAD 同口径；no-address 与 unverified 不算坏） */
const BAD_OUTCOMES: ReadonlySet<string> = new Set(['timeout', 'error', 'ssrf', 'fake', 'http-error', 'head-error'])
/** 挂起类：先验冷却按长档注入（与账本内部分档一致） */
const HANG_OUTCOMES: ReadonlySet<string> = new Set(['timeout', 'head-error'])

export type ProbeCellOutcome =
  | 'ok' | 'no-address' | 'timeout' | 'error' | 'ssrf' | 'fake'
  | 'http-error' | 'head-error' | 'unverified' | 'unsupported'

export interface ProbeCellResult {
  source: string
  platform: string
  songmid: string
  outcome: ProbeCellOutcome
  latencyMs: number | null
  reason: string | null
  container: string | null
}

export interface ProbeSummary {
  runId: number
  total: number
  probed: number
  okCount: number
  badCount: number
  startedAt: Date
}

/** 每个 `源×平台` 最近一次周测的结论 */
export interface ProbeCellVerdict {
  outcome: string
  reason: string | null
  runAt: Date
  latencyMs: number | null
}

/** 单飞：同一进程内绝不并跑两批（一起打会把第三方接口惹毛，结果也互相干扰） */
let running: Promise<ProbeSummary> | null = null

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function probeIntervalMs(): number {
  return envInt('SOURCE_PROBE_INTERVAL_HOURS', DEFAULT_INTERVAL_MS / 3600_000) * 3600_000
}

export function probeEnabled(): boolean {
  return process.env.SOURCE_PROBE_ENABLED !== '0'
}

/** 上一批里"至少有一个源真出过货"的歌——用来给基准曲排序，见 pickProbeSamples */
async function provenSongmids(): Promise<Set<string>> {
  const last = await prisma.sourceProbeRun.findFirst({
    where: { status: 'done' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true },
  })
  if (!last) return new Set()
  const rows = await prisma.sourceProbeResult.findMany({
    where: { runAt: last.startedAt, outcome: 'ok' }, select: { songmid: true }, distinct: ['songmid'],
  })
  return new Set(rows.map(r => r.songmid))
}

/**
 * 基准样本。三条规则都是被实测逼出来的：
 * 1. 优先"真被播过"的歌（被播过即说明有源解得动），不足再退推荐白名单、退不限时长
 *    ——NAS 首批 mg 一首都没选上（那几行 MusicInfo 时长为空），而家人正好在连听 mg；
 * 2. **上一批有源出货过的歌优先**：避免一次选样把整列带偏（NAS 上两首 kg 冷门歌让 7 个源
 *    里 6 个被判"全格皆坏"，实际是这些源没这首歌的版权）；
 * 3. 排序带 id 兜底，同一份库每次选出的是同一批样本，跨批次才可比。
 */
export async function pickProbeSamples(perPlatform = SAMPLES_PER_PLATFORM): Promise<Record<string, MusicInfo[]>> {
  const out: Record<string, MusicInfo[]> = {}
  const proven = await provenSongmids()
  const pool = Math.max(perPlatform * 3, perPlatform)
  for (const platform of PLATFORMS) {
    const played = await prisma.$queryRaw<{ id: number }[]>`
      SELECT m.id AS id
      FROM MusicInfo m JOIN PlayHistory p ON p.musicInfoId = m.id
      WHERE m.source = ${platform} AND m.durationSeconds > 0
      GROUP BY m.id
      ORDER BY SUM(p.playCount) DESC, MAX(p.playedAt) DESC, m.id ASC
      LIMIT ${pool}
    `
    let ids = played.map(r => Number(r.id))
    if (ids.length < pool) {
      const recommended = await prisma.musicInfo.findMany({
        where: { source: platform, durationSeconds: { gt: 0 }, isRecommended: true, id: { notIn: ids } },
        orderBy: { updatedAt: 'desc' }, take: pool - ids.length, select: { id: true },
      })
      ids = ids.concat(recommended.map(r => r.id))
    }
    if (ids.length < perPlatform) {
      // 最后一级不限时长：宁可测一首时长未知的歌，也不能让整个平台没样本
      const any = await prisma.musicInfo.findMany({
        where: { source: platform, id: { notIn: ids } },
        orderBy: { updatedAt: 'desc' }, take: pool - ids.length, select: { id: true },
      })
      ids = ids.concat(any.map(r => r.id))
    }
    const rows = await prisma.musicInfo.findMany({ where: { id: { in: ids } } })
    const picked = ids
      .map(id => rows.find(r => r.id === id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
    const rank = (row: { songmid: string }) => (proven.has(row.songmid) ? 0 : 1)
    const ranked = [...picked].sort((a, b) => rank(a) - rank(b) || a.id - b.id)
    out[platform] = ranked.slice(0, perPlatform).map(toProbeMusicInfo)
  }
  return out
}

type MusicInfoRow = {
  source: string; songmid: string; data: string; name: string | null; singer: string | null
  durationSeconds: number | null; hash: string | null; copyrightId: string | null
  songId: string | null; albumId: string | null; albumMid: string | null; strMediaMid: string | null
}

/** 搜索结果原样（data 列）就是脚本在生产里拿到的对象；缺 types 时补空数组，与读库边界同口径 */
function toProbeMusicInfo(row: MusicInfoRow): MusicInfo {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(row.data) as Record<string, unknown>
  } catch {
    parsed = {}
  }
  const base = parsed as Partial<MusicInfo>
  return {
    ...base,
    source: row.source,
    songmid: base.songmid ?? row.songmid,
    name: base.name ?? row.name ?? '',
    singer: base.singer ?? row.singer ?? '',
    types: Array.isArray(base.types) ? base.types : [],
  } as unknown as MusicInfo
}

/**
 * 首块验证：把"拿到了地址"与"地址真能给音频字节"分开计。
 * 走 safePublicFetch（逐跳 SSRF 校验），只读头部，不落磁盘缓存也不进音乐库。
 */
async function verifyHead(url: string): Promise<{ outcome: ProbeCellOutcome; reason: string | null; container: string | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS)
  timer.unref?.()
  try {
    const resp = await safePublicFetch(url, {
      signal: controller.signal,
      headers: {
        Range: `bytes=0-${HEAD_BYTES - 1}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    })
    const head = new Uint8Array(await resp.arrayBuffer())
    await resp.body?.cancel().catch(() => {})
    const judgment = judgeUpstreamPayload({
      contentType: resp.headers.get('content-type'),
      head: head.subarray(0, SNIFF_HEAD_BYTES),
    })
    if (judgment.verdict === 'audio') return { outcome: 'ok', reason: null, container: judgment.container }
    if (!resp.ok) return { outcome: 'http-error', reason: `HTTP ${resp.status}｜${judgment.reason}`, container: null }
    if (judgment.verdict === 'reject') return { outcome: 'fake', reason: judgment.reason, container: null }
    return { outcome: 'unverified', reason: judgment.reason, container: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { outcome: 'head-error', reason: message.slice(0, 120), container: null }
  } finally {
    clearTimeout(timer)
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 一批要探的格子：pt 白名单外的平台压根不列进来，与瀑布口径一致 */
export function planCells(
  sources: { name: string; pt?: string[] }[],
  samples: Record<string, MusicInfo[]>
): { source: string; platform: string; musicInfo: MusicInfo }[] {
  const cells: { source: string; platform: string; musicInfo: MusicInfo }[] = []
  for (const s of sources) {
    const scoped = s.pt && s.pt.length ? PLATFORMS.filter(p => s.pt!.includes(p)) : [...PLATFORMS]
    for (const platform of scoped) {
      for (const musicInfo of samples[platform] || []) {
        cells.push({ source: s.name, platform, musicInfo })
      }
    }
  }
  return cells
}

async function probeOne(
  cell: { source: string; platform: string; musicInfo: MusicInfo },
  resolveTimeoutMs: number
): Promise<ProbeCellResult> {
  const resolved = await musicSourceManager.probeSourceUrl(cell.source, cell.musicInfo, PROBE_QUALITY, resolveTimeoutMs)
  const base = { source: cell.source, platform: cell.platform, songmid: cell.musicInfo.songmid }
  if (!resolved.ok) {
    return { ...base, outcome: resolved.outcome, latencyMs: resolved.latencyMs, reason: resolved.reason, container: null }
  }
  const head = await verifyHead(resolved.url)
  return { ...base, outcome: head.outcome, latencyMs: resolved.latencyMs, reason: head.reason, container: head.container }
}

/**
 * 跑一批周测。同一时刻进程内只会有一个在跑（重复调用复用同一个 promise）。
 */
export function runSourceProbe(trigger: 'manual' | 'schedule' = 'schedule'): Promise<ProbeSummary> {
  if (running) return running
  running = doRun(trigger).finally(() => { running = null })
  return running
}

export function isProbeRunning(): boolean {
  return running !== null
}

async function doRun(trigger: 'manual' | 'schedule'): Promise<ProbeSummary> {
  const startedAt = new Date()
  const run = await prisma.sourceProbeRun.create({ data: { startedAt, trigger, samples: '{}' } })
  const summary: ProbeSummary = { runId: run.id, total: 0, probed: 0, okCount: 0, badCount: 0, startedAt }
  try {
    await musicSourceManager.ensureFresh()
    const [sources, samples] = await Promise.all([listSourcesWithStatus(), pickProbeSamples()])
    const enabled = sources.filter(s => s.enabled).map(s => ({ ...s, name: s.name || s.path }))
    const cells = planCells(enabled, samples)
    summary.total = cells.length

    const snapshot: Record<string, { songmid: string; name: string; singer: string }[]> = {}
    for (const [platform, list] of Object.entries(samples)) {
      snapshot[platform] = list.map(m => ({ songmid: m.songmid, name: m.name, singer: m.singer }))
    }
    await prisma.sourceProbeRun.update({
      where: { id: run.id }, data: { samples: JSON.stringify(snapshot), total: cells.length },
    })

    // 取址预算沿用瀑布的单源档：探测看到的"慢"要和真实用户会等的时间同一把尺
    const perSourceBudget = readUrlBudgets().perSourceMs
    for (const cell of cells) {
      const result = await probeOne(cell, perSourceBudget)
      summary.probed++
      if (result.outcome === 'ok') summary.okCount++
      if (BAD_OUTCOMES.has(result.outcome)) summary.badCount++
      await prisma.sourceProbeResult.create({
        data: {
          runAt: startedAt, source: result.source, platform: result.platform, songmid: result.songmid,
          quality: PROBE_QUALITY, outcome: result.outcome, latencyMs: result.latencyMs,
          // 源脚本抛的错常整段带换行（墨澜把所有后端的失败原因拼在一起），不压平会把
          // 面板 title 与日志排版撑坏
          reason: result.reason ? result.reason.replace(/\s+/g, ' ').trim().slice(0, 160) : null,
          container: result.container,
        },
      })
      await sleep(GAP_BETWEEN_CELLS_MS)
    }

    await prisma.sourceProbeRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: 'done', probed: summary.probed, okCount: summary.okCount, badCount: summary.badCount },
    })
    logger.info(`[source-probe] 周测完成（${trigger}）：出货 ${summary.okCount}/${summary.probed}，坏 ${summary.badCount}，计划 ${summary.total} 格`)
    return summary
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await prisma.sourceProbeRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: 'failed', detail: message.slice(0, 400) },
    }).catch(() => {})
    logger.warn('[source-probe] 周测失败:', err)
    throw new Error(`周测失败：${message}`)
  }
}

/**
 * 每个 `源×平台` 最近一次的结论。
 *
 * 一格里有多首基准曲，取值规则：有一首出货就算这格可用（个别歌缺版权不代表源坏了）；
 * 全不出货时取最恶劣的那个结局（坏 > 无地址 > 认不出），这才是要注入先验的东西。
 */
export async function latestProbeCells(): Promise<Map<string, ProbeCellVerdict>> {
  const since = new Date(Date.now() - PRIOR_TTL_MS)
  const rows = await prisma.sourceProbeResult.findMany({
    where: { runAt: { gte: since } },
    orderBy: { runAt: 'asc' },
    select: { runAt: true, source: true, platform: true, outcome: true, reason: true, latencyMs: true },
  })
  const grouped = new Map<string, { runAt: Date; rows: typeof rows }>()
  for (const r of rows) {
    const key = `${r.source}\u0000${r.platform}`
    const g = grouped.get(key)
    if (!g) grouped.set(key, { runAt: r.runAt, rows: [r] })
    // 行已按 runAt 升序：同一批累加，遇到更新的批次整组替换
    else if (r.runAt.getTime() > g.runAt.getTime()) { g.runAt = r.runAt; g.rows = [r] }
    else if (r.runAt.getTime() === g.runAt.getTime()) g.rows.push(r)
  }
  const cells = new Map<string, ProbeCellVerdict>()
  for (const [key, g] of grouped) {
    cells.set(key, pickVerdict(g.rows, g.runAt))
  }
  return cells
}

const OUTCOME_SEVERITY: ProbeCellOutcome[] = [
  'ok', 'no-address', 'unverified', 'unsupported', 'http-error', 'head-error', 'error', 'ssrf', 'fake', 'timeout',
]

function pickVerdict(rows: { outcome: string; reason: string | null; latencyMs: number | null }[], runAt: Date): ProbeCellVerdict {
  const ok = rows.find(r => r.outcome === 'ok')
  if (ok) return { outcome: 'ok', reason: ok.reason, runAt, latencyMs: ok.latencyMs }
  const worst = rows.reduce((acc, r) => (
    OUTCOME_SEVERITY.indexOf(r.outcome as ProbeCellOutcome) > OUTCOME_SEVERITY.indexOf(acc.outcome as ProbeCellOutcome) ? r : acc
  ), rows[0])
  return { outcome: worst.outcome, reason: worst.reason, runAt, latencyMs: worst.latencyMs }
}

/**
 * 用最近一次周测给空账本注入先验（启动时调用）。
 *
 * 只设冷却、不伪造样本窗：真实流量的证据必须是自己的。到期后照常放半开，一次成功就
 * 彻底恢复，所以先验判错最多让一首歌多等一轮。
 */
export async function seedHealthFromProbe(): Promise<number> {
  const cells = await latestProbeCells()
  let seeded = 0
  for (const [key, verdict] of cells) {
    if (!BAD_OUTCOMES.has(verdict.outcome)) continue
    const [source, platform] = key.split('\u0000')
    const ageMin = Math.max(1, Math.round((Date.now() - verdict.runAt.getTime()) / 60_000))
    sourceHealth.seedCooldown(source, platform, {
      hangLike: HANG_OUTCOMES.has(verdict.outcome),
      reason: `来自 ${ageMin} 分钟前的周测：${verdict.reason || verdict.outcome}`,
    })
    seeded++
  }
  if (seeded) logger.info(`[source-probe] 已按最近一次周测给 ${seeded} 个 源×平台 注入冷却先验`)
  return seeded
}

/** 面板/接口用：最近一批的元数据 + 是否在跑 */
export async function probeStatus() {
  const last = await prisma.sourceProbeRun.findFirst({ orderBy: { startedAt: 'desc' } })
  return {
    running: isProbeRunning(),
    last: last ? {
      id: last.id, startedAt: last.startedAt, finishedAt: last.finishedAt, trigger: last.trigger,
      status: last.status, total: last.total, probed: last.probed, okCount: last.okCount,
      badCount: last.badCount, detail: last.detail,
    } : null,
  }
}

/**
 * 给音源清单挂上最近一次周测结论（面板「周测」列）。
 * 键口径与账本一致：`config.name || path`，否则挂不上（3b-2 就踩过这个）。
 */
export async function attachProbeVerdicts(list: SourceWithStatus[]): Promise<void> {
  const cells = await latestProbeCells()
  if (cells.size === 0) return
  for (const s of list) {
    const name = s.name || s.path
    const verdicts: SourceProbeVerdict[] = []
    for (const platform of PLATFORMS) {
      const v = cells.get(`${name}\u0000${platform}`)
      if (v) verdicts.push({ platform, outcome: v.outcome, reason: v.reason, runAt: v.runAt.getTime(), latencyMs: v.latencyMs })
    }
    if (verdicts.length) s.probe = verdicts
  }
}

const SCHEDULER_GLOBAL_KEY = Symbol.for('holly.sourceProbeScheduler')

/**
 * 周测排期：启动后先补跑（距上次超过一个周期就跑），之后按周期轮。
 * 与 cover-backfill 同一套写法：globalThis 守卫（dev 热重载会重复注册），定时器 unref
 * 不让它拖住进程退出。SOURCE_PROBE_ENABLED=0 可整体关掉。
 */
export function startSourceProbeScheduler(opts: { firstDelayMs?: number } = {}): void {
  const holder = globalThis as Record<symbol, unknown>
  if (holder[SCHEDULER_GLOBAL_KEY]) return
  holder[SCHEDULER_GLOBAL_KEY] = true
  if (!probeEnabled()) {
    logger.info('[source-probe] SOURCE_PROBE_ENABLED=0，周测与先验注入均关闭')
    return
  }

  const intervalMs = probeIntervalMs()
  const runIfStale = async (why: string) => {
    try {
      const last = await prisma.sourceProbeRun.findFirst({
        where: { status: 'done' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true },
      })
      if (last && Date.now() - last.startedAt.getTime() < intervalMs) {
        logger.info(`[source-probe] ${why}：距上次周测不足周期，跳过`)
        return
      }
      await runSourceProbe('schedule')
    } catch (err) {
      logger.warn(`[source-probe] ${why}失败:`, err)
    }
  }

  const first = setTimeout(() => {
    // 先注先验再考虑补跑：刚重启的进程要立刻知道"上次测出来谁坏"，这一步不该等几秒以上
    void seedHealthFromProbe().catch(err => logger.warn('[source-probe] 先验注入失败（不影响取址）:', err))
    void runIfStale('启动补跑判定')
    const timer = setInterval(() => void runIfStale('周期轮'), intervalMs)
    timer.unref?.()
  }, opts.firstDelayMs ?? 30_000)
  first.unref?.()
}

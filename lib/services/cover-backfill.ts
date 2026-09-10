/**
 * 封面自动回填服务
 *
 * kw/kg/tx 的列表类上游接口（榜单/歌单/搜索入库链路）不携带封面，批量入库后
 * MusicInfo.img 会留下 NULL。本服务用 music-pic 原生通道（kw artistpicserver /
 * kg get_res_privilege / tx albumMid 模板）自动补齐，触发点两处：
 *
 *   1. 服务启动后首轮（instrumentation.ts 接线）
 *   2. 每 6 小时定时轮——批量入库或入库覆盖（upsert 在 checksum 变化时会用上游
 *      空 img 覆盖回来）造成的缺口由下一轮自动补上，无需再做手动存量回填
 *
 * img 字段状态机：
 *   NULL（未尝试）→ 成功写入封面 URL；上游确认无封面 → 写入空串（不再重试）；
 *   单次执行中的意外异常不写库，留给下一轮。
 *
 * 成功时同时更新 img 列与 data JSON 内的 img（各列表接口与统计层都消费 data），
 * 不动 checksum，避免后续同曲入库被误判为内容变更。
 */
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import type { MusicInfo } from '@/lib/types/music'

// 原生封面获取模块（参考 lx-music 各源 pic 实现），与 cover.ts 同款接法
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getPic: getPicNative } = require('../music-core/music-pic')

/** 需要回填的源：wy/mg 搜索时已带 img，tx 仅按 albumMid 模板拼接（零请求） */
const BACKFILL_SOURCES = ['kw', 'kg', 'tx'] as const

/** kw/kg 返回的是上游权威接口给出的地址，直接信任；tx 是本地拼模板，需验证可达 */
const VERIFY_URL_SOURCES = new Set<string>(['tx'])

export type CoverPicResolver = (musicInfo: MusicInfo) => Promise<string | null>

export interface BackfillOptions {
  /** 本次最多处理多少行（不传则处理全部候选） */
  limit?: number
  /** 封面解析器（默认 music-pic 原生通道；测试注入用） */
  resolvePic?: CoverPicResolver
  /** 游标分页单批行数 */
  chunkSize?: number
  /** 并发数 */
  concurrency?: number
  /** 解析失败重试间隔（测试可注入 0 提速） */
  retryDelayMs?: number
  /** 相邻并发批之间的礼貌间隔（测试可注入 0 提速） */
  batchPauseMs?: number
}

export interface BackfillResult {
  /** 扫描到的候选行数 */
  scanned: number
  /** 成功写入封面 URL 的行数 */
  updated: number
  /** 上游确认无封面、标记空串的行数 */
  markedEmpty: number
  /** 解析/写库异常、留给下一轮的行数 */
  failed: number
}

const DEFAULT_CHUNK_SIZE = 200
const DEFAULT_CONCURRENCY = 6
/** 解析失败重试间隔：getPic 内部把网络异常也吞成 null，重试一次过滤瞬态抖动 */
const RETRY_DELAY_MS = 500
/** 相邻并发批之间的礼貌间隔 */
const BATCH_PAUSE_MS = 100

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function resolveWithRetry(
  mi: MusicInfo,
  resolvePic: CoverPicResolver,
  retryDelayMs: number
): Promise<string | null> {
  const first = await resolvePic(mi)
  if (first) return first
  if (retryDelayMs > 0) await sleep(retryDelayMs)
  return resolvePic(mi)
}

/** tx 模板 URL 可达性验证：能拿到 image/* 响应头即认为有效（不读 body） */
async function isReachableImageUrl(url: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000)
    const resp = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    })
    clearTimeout(timeoutId)
    const ok = resp.ok && (resp.headers.get('content-type') || '').startsWith('image/')
    await resp.body?.cancel()
    return ok
  } catch {
    return false
  }
}

async function processRow(
  row: { id: number; source: string; data: string | null },
  resolvePic: CoverPicResolver,
  retryDelayMs: number
): Promise<'updated' | 'markedEmpty' | 'failed'> {
  let mi: MusicInfo | null = null
  if (row.data) {
    try {
      mi = JSON.parse(row.data) as MusicInfo
    } catch {
      mi = null
    }
  }

  let url: string | null = null
  if (mi) {
    try {
      url = await resolveWithRetry(mi, resolvePic, retryDelayMs)
    } catch (err) {
      // 意外异常（非"上游确认无封面"）不写库，行保持 NULL 留给下一轮
      logger.warn(`[cover-backfill] 解析异常 #${row.id}(${row.source}):`, err)
      return 'failed'
    }
  }

  if (url && VERIFY_URL_SOURCES.has(row.source) && !(await isReachableImageUrl(url))) {
    url = null
  }

  if (url) {
    // data JSON 同步写 img，保持 img 列与 data 消费方一致；checksum 不动
    const dataJson = mi ? JSON.stringify({ ...mi, img: url }) : undefined
    await prisma.musicInfo.update({
      where: { id: row.id },
      data: { img: url, ...(dataJson ? { data: dataJson } : {}) },
    })
    return 'updated'
  }

  // 上游确认无封面（含 data 缺失/损坏、tx 模板 404）：标记空串，退出候选集不再重试
  await prisma.musicInfo.update({ where: { id: row.id }, data: { img: '' } })
  return 'markedEmpty'
}

/**
 * 扫描 img 为 NULL 的 kw/kg/tx 行并回填封面。
 * 游标分页推进，本轮内已处理的行（含失败行）不会重复扫描。
 */
export async function backfillMissingCovers(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const {
    limit = Number.POSITIVE_INFINITY,
    resolvePic = getPicNative as CoverPicResolver,
    chunkSize = DEFAULT_CHUNK_SIZE,
    concurrency = DEFAULT_CONCURRENCY,
    retryDelayMs = RETRY_DELAY_MS,
    batchPauseMs = BATCH_PAUSE_MS,
  } = opts

  const result: BackfillResult = { scanned: 0, updated: 0, markedEmpty: 0, failed: 0 }
  let cursor = 0

  while (result.scanned < limit) {
    const rows = await prisma.musicInfo.findMany({
      where: { img: null, source: { in: [...BACKFILL_SOURCES] }, id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: chunkSize,
    })
    if (rows.length === 0) break
    cursor = rows[rows.length - 1].id

    for (let i = 0; i < rows.length; i += concurrency) {
      if (result.scanned >= limit) break
      const batch = rows.slice(i, i + concurrency).slice(0, limit - result.scanned)
      const outcomes = await Promise.all(
        batch.map(async row => {
          try {
            return await processRow(row, resolvePic, retryDelayMs)
          } catch (err) {
            logger.warn(`[cover-backfill] 行处理失败 #${row.id}(${row.source}):`, err)
            return 'failed' as const
          }
        })
      )
      result.scanned += batch.length
      for (const o of outcomes) result[o]++
      if (i + concurrency < rows.length && batchPauseMs > 0) await sleep(batchPauseMs)
    }
  }

  return result
}

/** 定时轮默认间隔 */
export const COVER_BACKFILL_INTERVAL_MS = 6 * 60 * 60 * 1000

const SCHEDULER_GLOBAL_KEY = Symbol.for('hollymusic.coverBackfillScheduler')

/**
 * 启动封面回填调度：firstDelayMs 后执行首轮，此后每 intervalMs 自愈一轮。
 * 通过 Symbol.for 全局守卫，dev 热重载/重复调用不会叠加定时器。
 */
export function startCoverBackfillScheduler(opts: {
  firstDelayMs?: number
  intervalMs?: number
} = {}): void {
  const holder = globalThis as Record<symbol, unknown>
  if (holder[SCHEDULER_GLOBAL_KEY]) return
  holder[SCHEDULER_GLOBAL_KEY] = true

  const { firstDelayMs = 15_000, intervalMs = COVER_BACKFILL_INTERVAL_MS } = opts
  const runOnce = async () => {
    try {
      const r = await backfillMissingCovers()
      if (r.scanned > 0) logger.info('[cover-backfill] 本轮完成:', r)
    } catch (err) {
      logger.warn('[cover-backfill] 本轮失败:', err)
    }
  }

  const first = setTimeout(() => {
    void runOnce()
    const timer = setInterval(() => void runOnce(), intervalMs)
    timer.unref?.()
  }, firstDelayMs)
  first.unref?.()
}

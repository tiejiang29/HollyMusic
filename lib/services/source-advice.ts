/**
 * 按周测结果给「改 `pt` / 改 priority」的建议 —— **只给建议，不自动改配置**。
 *
 * 为什么不是自动改写（用户 2026-10-07 定的形态，两条护栏都在档里）：
 * - `priority` 手工排序是他认定的基线，"让程序自动改写它"曾被摸底数据否决过一次，
 *   理由是马太效应：没数据的源被压到队尾之后就再也拿不到数据。这里的前提就是那条否决
 *   被修好之后才成立的（周测现在能覆盖全矩阵），但**决定权仍在人**：面板点一下才写。
 * - `music-sources.json` 只有一个原子写入者，任何"后台悄悄改配置"都等于开第二条写路径。
 *
 * 三条判据都是**连续两批同向**才提：只看最新一批的话，一首冷门歌没版权、或某次网络抖动
 * 就足够把一个好好地干着的平台的源摘掉。同理，`no-address`（源里没这首歌）与
 * `unsupported`（脚本压根没这个平台）都不算坏证据 —— 与账本那边的口径一致。
 */
import { logger } from '@/lib/logger'
import { readSetting, writeSetting } from '@/lib/services/app-setting'
import {
  readConfig, readConfigText, writeConfigText, updateSourcesBatch,
} from '@/lib/services/source-manager-service'
import { PLATFORMS, probeCellKey, recentProbeBatches, type ProbeBatch, type ProbeBatchCell } from '@/lib/services/source-probe'

/** 固化前拍的配置原文快照，只留最近一份（撤销是"退回上一步"，不是版本历史） */
export const UNDO_SETTING_KEY = 'source_advice_undo'

export type AdviceKind = 'add-pt' | 'drop-pt' | 'priority'

export interface Advice {
  /** 稳定键，面板勾选与固化都靠它：`kind:路径:平台` */
  id: string
  kind: AdviceKind
  path: string
  /** 周测与账本用的源名（`config.name || path`） */
  source: string
  platform: string | null
  /** 面板那行人话："把 酷狗 加回支持平台" */
  action: string
  /** 依据："最近两批各 2/2 出货，中位 340ms" */
  evidence: string
  /** 固化时真正写进配置的值。客户端只传 id，这份由服务端自己算 */
  patch: { pt?: string[]; priority?: number }
}

interface AdviceRow {
  path: string
  name: string
  priority: number
  pt: string[]
}

const PLATFORM_LABELS: Record<string, string> = { tx: '腾讯', wy: '网易', kw: '酷我', kg: '酷狗', mg: '咪咕' }
const platformLabel = (platform: string): string => PLATFORM_LABELS[platform] ?? platform

const median = (values: number[]): number | null => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.floor((sorted.length - 1) / 2)])
}

/** 一格在两批里的合并说法："2/2 出货，中位 340ms" */
function cellSummary(cells: Array<ProbeBatchCell | undefined>): string {
  const got = cells.filter((c): c is ProbeBatchCell => !!c)
  if (!got.length) return '没测过'
  const samples = got.reduce((sum, c) => sum + c.samples, 0)
  const ok = got.reduce((sum, c) => sum + c.okCount, 0)
  const latency = median(got.flatMap(c => c.latencies))
  return `${ok}/${samples} 出货${latency !== null ? `，中位 ${latency}ms` : ''}`
}

/**
 * 纯函数：给一批源配置 + 最近几批周测，算出建议。
 * 拆出来是为了能直测 —— 固化写的是生产配置，判据不能只靠端到端验。
 */
export function computeAdvice(rows: AdviceRow[], batches: ProbeBatch[]): Advice[] {
  const [latest, prev] = batches
  // 只有一批就没有"同向"可言。宁可不提，也不拿单批抖动去改生产配置
  if (!latest || !prev) return []
  const out: Advice[] = []

  for (const row of rows) {
    for (const platform of PLATFORMS) {
      const a = latest.cells.get(probeCellKey(row.name, platform))
      const b = prev.cells.get(probeCellKey(row.name, platform))
      if (!a || !b) continue
      const inPt = row.pt.length === 0 || row.pt.includes(platform)
      const bothOk = a.okCount > 0 && b.okCount > 0
      // 坏 = 一批里没一首出货、且有真坏的行。`no-address`/`unsupported` 到不了这里
      const bothBad = a.okCount === 0 && a.badCount > 0 && b.okCount === 0 && b.badCount > 0
      if (!inPt && bothOk) {
        out.push({
          id: `add-pt:${row.path}:${platform}`, kind: 'add-pt', path: row.path, source: row.name, platform,
          action: `把 ${platformLabel(platform)} 加回支持平台`,
          evidence: `被 pt 摘着仍出货：${cellSummary([a, b])}`,
          // 按平台清单的顺序补回去，保持配置里 pt 的写法稳定（否则每次固化都换一遍顺序）
          patch: { pt: [...PLATFORMS].filter(p => row.pt.includes(p) || p === platform) },
        })
      } else if (inPt && row.pt.length > 0 && bothBad) {
        out.push({
          id: `drop-pt:${row.path}:${platform}`, kind: 'drop-pt', path: row.path, source: row.name, platform,
          action: `把 ${platformLabel(platform)} 从支持平台里摘掉`,
          evidence: `连续两批判坏：${b.badReason ?? a.badReason ?? '原因未记'}`,
          patch: { pt: row.pt.filter(p => p !== platform) },
        })
      }
    }
  }

  // priority 是**全局顺位**（瀑布按它排一次，再按平台筛），所以只能有一套建议。
  // 真数据上踩过：按平台各算一份时，同一个源在酷我被提到 1、在腾讯被压到 6，勾两条就互相覆盖。
  const ranked = rows
    .map(row => {
      const cells = [latest, prev].flatMap(b =>
        PLATFORMS.map(p => b.cells.get(probeCellKey(row.name, p))).filter((c): c is ProbeBatchCell => !!c))
      const perBatch = [latest, prev].map(b =>
        PLATFORMS.some(p => (b.cells.get(probeCellKey(row.name, p))?.okCount ?? 0) > 0))
      const okPlatforms = new Set([latest, prev].flatMap(b => PLATFORMS.filter(p => (b.cells.get(probeCellKey(row.name, p))?.okCount ?? 0) > 0)))
      return {
        row,
        measured: cells.length > 0,
        okBatches: perBatch.filter(Boolean).length,
        okPlatforms: okPlatforms.size,
        latency: median(cells.flatMap(c => c.latencies)),
        samples: cells.reduce((sum, c) => sum + c.samples, 0),
        okSamples: cells.reduce((sum, c) => sum + c.okCount, 0),
      }
    })
    .filter(entry => entry.measured)
  if (ranked.length >= 2) {
    const slots = ranked.map(r => r.row.priority).sort((x, y) => x - y)
    // 有重复值说明这份配置的顺序本身就说不清，那就别重排
    if (new Set(slots).size === slots.length) {
      ranked.sort((x, y) => y.okBatches - x.okBatches
        || y.okPlatforms - x.okPlatforms
        || (x.latency ?? Number.MAX_SAFE_INTEGER) - (y.latency ?? Number.MAX_SAFE_INTEGER)
        || x.row.priority - y.row.priority
        || x.row.name.localeCompare(y.row.name))
      ranked.forEach((entry, index) => {
        if (entry.row.priority === slots[index]) return
        out.push({
          id: `priority:${entry.row.path}`, kind: 'priority', path: entry.row.path, source: entry.row.name, platform: null,
          action: `全局顺位 ${entry.row.priority} → ${slots[index]}`,
          evidence: `两批合计 ${entry.okSamples}/${entry.samples} 出货、能出 ${entry.okPlatforms} 个平台`
            + `${entry.latency !== null ? `，中位 ${entry.latency}ms` : ''}（${ranked.length} 个有实测的源一起排；没实测过的源不参与也不动）`,
          patch: { priority: slots[index] },
        })
      })
    }
  }
  return out
}

export interface AdviceView {
  suggestions: Advice[]
  /** 参与判断的批数（<2 时建议恒为空） */
  batchesUsed: number
  lastRunAt: string | null
  canUndo: boolean
}

/** 读配置 + 最近四批周测，算当前建议。纯读，不动任何文件 */
export async function buildAdvice(): Promise<AdviceView> {
  const [config, batches, undo] = await Promise.all([
    readConfig(), recentProbeBatches(4), readSetting<{ savedAt?: string } | null>(UNDO_SETTING_KEY, null),
  ])
  const rows: AdviceRow[] = config.sources.filter(s => s.enabled).map(s => ({
    path: s.path, name: s.name || s.path, priority: s.priority, pt: s.pt ?? [],
  }))
  return {
    suggestions: computeAdvice(rows, batches),
    batchesUsed: batches.length,
    lastRunAt: batches[0]?.runAt.toISOString() ?? null,
    canUndo: !!undo?.savedAt,
  }
}

/**
 * 固化勾选的那几条建议。
 *
 * **只认 id**：客户端传上来的 patch 值一概不信 —— 建议是这一刻算出来的，写进配置的必须
 * 是同一刻服务端自己算的那份，否则面板上挂着旧页面点固化就会按旧值覆盖（跟导入只认
 * candidateId 是同一个理由）。
 */
export async function applyAdvice(ids: string[]): Promise<{ applied: number; changed: number }> {
  const picked = new Set(ids)
  const { suggestions } = await buildAdvice()
  const chosen = suggestions.filter(item => picked.has(item.id))
  if (!chosen.length) return { applied: 0, changed: 0 }

  // 同一条源可能被勾了好几条建议（"把酷我加回来"和"把咪咕加回来"是两条），
  // 所以要按"当前配置 + 所有增删"重算一份 pt，不能把各自算好的数组互相覆盖
  const plan = new Map<string, { add: string[]; remove: string[]; priority?: number }>()
  for (const item of chosen) {
    const entry = plan.get(item.path) ?? { add: [], remove: [] }
    if (item.kind === 'add-pt' && item.platform) entry.add.push(item.platform)
    if (item.kind === 'drop-pt' && item.platform) entry.remove.push(item.platform)
    if (item.patch.priority !== undefined) entry.priority = item.patch.priority
    plan.set(item.path, entry)
  }
  const config = await readConfig()
  const patches: Array<{ path: string; pt?: string[]; priority?: number }> = []
  for (const [path, entry] of plan) {
    const source = config.sources.find(s => s.path === path)
    if (!source) continue
    const base = source.pt ?? []
    const patch: { pt?: string[]; priority?: number } = {}
    // 只在 pt 非空时改它：pt 空 = "全平台都支持"的隐式状态，勾出来的建议在这种配置下不存在
    if ((entry.add.length || entry.remove.length) && base.length) {
      patch.pt = PLATFORMS.filter(p => (base.includes(p) || entry.add.includes(p)) && !entry.remove.includes(p))
    }
    if (entry.priority !== undefined) patch.priority = entry.priority
    if (patch.pt !== undefined || entry.priority !== undefined) patches.push({ path, ...patch })
  }
  if (!patches.length) return { applied: 0, changed: 0 }

  const snapshot = await readConfigText()
  const changed = await updateSourcesBatch(patches)
  await writeSetting(UNDO_SETTING_KEY, { savedAt: new Date().toISOString(), text: snapshot })
  logger.info('[source-advice] 固化建议', { 条数: chosen.length, 改动源数: changed })
  return { applied: chosen.length, changed }
}

/** 撤销上次固化：按原文还原配置。没有快照就是无事可做，不报错 */
export async function undoAdvice(): Promise<{ restored: boolean; reason?: string }> {
  const undo = await readSetting<{ savedAt?: string; text?: string } | null>(UNDO_SETTING_KEY, null)
  if (!undo?.text) return { restored: false, reason: '没有可撤销的固化记录' }
  await writeConfigText(undo.text)
  await writeSetting(UNDO_SETTING_KEY, null)
  logger.info('[source-advice] 已撤销上次固化', { 快照时间: undo.savedAt ?? '未知' })
  return { restored: true }
}

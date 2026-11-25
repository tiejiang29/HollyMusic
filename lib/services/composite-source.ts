import type { SourceType } from '@/lib/types/music'
import { logger } from '@/lib/logger'
import { readSetting, writeSetting } from '@/lib/services/app-setting'
import { readConfig } from '@/lib/services/source-manager-service'

export const COMPOSITE_SETTING_KEY = 'audioComposite'

export interface CompositeMember {
  sourceName: string
  platform: SourceType
}

export type CrossPlatformMode = 'fallback' | 'parallel'

export interface CompositeSettings {
  enabled: boolean
  members: CompositeMember[]
  /** 跨平台成员：原平台候选走完后兜底 / 从第一轮同时竞价 */
  crossPlatformMode: CrossPlatformMode
  /** 1=串行灰度对照，6=完整并发 */
  width: number
  /** 低档可播兜底最多保留多久 */
  holdMs: number
  /** 单源取址预算 */
  resolveMs: number
  /** 上游首字节预算 */
  headerMs: number
  /** 整条候选链预算，必须小于 audio-serve 外层 20s */
  chainMs: number
}

export interface LaneStatView {
  laneId: string
  endpoint: string
  keyHash: string | null
  sourceName: string | null
  platform: string | null
  quality: string | null
  attempts: number
  httpOk: number
  httpBad: number
  payloadBad: number
  successRate: number | null
  lastUsedAt: number
  lastError: string | null
  badUntil: number
  cooling: boolean
  retryAfterMs: number
}

export const DEFAULT_COMPOSITE_SETTINGS: CompositeSettings = {
  enabled: false,
  members: [],
  crossPlatformMode: 'fallback',
  width: 1,
  holdMs: 2_000,
  resolveMs: 8_000,
  headerMs: 3_000,
  chainMs: 12_000,
}

let settingsCache: CompositeSettings | null = null

const VALID_PLATFORMS = new Set<SourceType>(['tx', 'wy', 'kw', 'kg', 'mg'])
const MAX_MEMBERS = 64

export class CompositeSourceError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message)
    this.name = 'CompositeSourceError'
  }
}

function clampInt(value: unknown, fallback: number, low: number, high: number): number {
  const n = typeof value === 'number' ? Math.trunc(value) : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(high, Math.max(low, n))
}

export function normalizeCompositeMembers(input: unknown): CompositeMember[] {
  if (!Array.isArray(input)) return []
  const out: CompositeMember[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const sourceName = typeof (raw as { sourceName?: unknown }).sourceName === 'string'
      ? (raw as { sourceName: string }).sourceName.trim()
      : ''
    const platform = (raw as { platform?: unknown }).platform
    if (!sourceName || !VALID_PLATFORMS.has(platform as SourceType)) continue
    const key = `${sourceName}\u0000${platform}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ sourceName, platform: platform as SourceType })
    if (out.length >= MAX_MEMBERS) break
  }
  return out
}

export function normalizeCompositeSettings(input: Partial<CompositeSettings> = {}): CompositeSettings {
  const chainMs = clampInt(input.chainMs, DEFAULT_COMPOSITE_SETTINGS.chainMs, 3_000, 19_000)
  return {
    enabled: input.enabled === true,
    members: normalizeCompositeMembers(input.members),
    crossPlatformMode: input.crossPlatformMode === 'parallel' ? 'parallel' : 'fallback',
    width: clampInt(input.width, DEFAULT_COMPOSITE_SETTINGS.width, 1, 6),
    holdMs: clampInt(input.holdMs, DEFAULT_COMPOSITE_SETTINGS.holdMs, 0, 5_000),
    resolveMs: clampInt(input.resolveMs, DEFAULT_COMPOSITE_SETTINGS.resolveMs, 1_000, chainMs),
    headerMs: clampInt(input.headerMs, DEFAULT_COMPOSITE_SETTINGS.headerMs, 500, chainMs),
    chainMs,
  }
}

export async function getCompositeSettings(): Promise<CompositeSettings> {
  if (settingsCache) return settingsCache
  const stored = await readSetting<Partial<CompositeSettings>>(COMPOSITE_SETTING_KEY, DEFAULT_COMPOSITE_SETTINGS)
  try {
    settingsCache = normalizeCompositeSettings(stored)
    return settingsCache
  } catch (error) {
    logger.warn('[composite] 配置归一化失败，回落到关闭态:', error)
    settingsCache = { ...DEFAULT_COMPOSITE_SETTINGS, members: [] }
    return settingsCache
  }
}

export function _clearCompositeSettingsCacheForTest(): void {
  settingsCache = null
}

export async function saveCompositeSettings(patch: Partial<CompositeSettings>): Promise<CompositeSettings> {
  const current = await getCompositeSettings()
  const next = normalizeCompositeSettings({
    enabled: patch.enabled ?? current.enabled,
    members: patch.members === undefined ? current.members : patch.members,
    crossPlatformMode: patch.crossPlatformMode ?? current.crossPlatformMode,
    width: patch.width ?? current.width,
    holdMs: patch.holdMs ?? current.holdMs,
    resolveMs: patch.resolveMs ?? current.resolveMs,
    headerMs: patch.headerMs ?? current.headerMs,
    chainMs: patch.chainMs ?? current.chainMs,
  })
  if (next.enabled && next.members.length === 0) {
    throw new CompositeSourceError('启用复合源前至少添加一个音源成员')
  }

  if (next.enabled) {
    const config = await readConfig()
    const names = new Set(config.sources.map(source => source.name || source.path))
    const unknown = next.members.filter(member => !names.has(member.sourceName))
    if (unknown.length > 0) {
      throw new CompositeSourceError(`成员音源已不存在：${unknown.map(item => item.sourceName).join('、')}`)
    }
  }

  await writeSetting(COMPOSITE_SETTING_KEY, next)
  settingsCache = next
  logger.info('[composite] 配置已保存', { enabled: next.enabled, members: next.members.length, width: next.width })
  return next
}

export async function getCompositeView(settingsOverride?: CompositeSettings): Promise<{ settings: CompositeSettings; lanes: LaneStatView[] }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { listLaneStats } = require('../music-core/backend-registry') as {
    listLaneStats: () => LaneStatView[]
  }
  const [settings, lanes] = await Promise.all([
    settingsOverride ? Promise.resolve(settingsOverride) : getCompositeSettings(),
    Promise.resolve(listLaneStats()),
  ])
  return { settings, lanes }
}

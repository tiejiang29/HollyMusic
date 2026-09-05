/**
 * 跨平台换源（同名歌跨平台匹配）
 *
 * 参考洛雪移动端的换源机制：按「歌名 + 歌手 + 时长容差」在其他平台
 * 搜索同一首歌，用于：
 * - 服务端自动换源（方案A）：播放瀑布在某平台全部失败后，尝试其他平台的同款
 * - 手动换源（方案B）：/api/music/alternatives 返回候选列表供用户选择
 */

import * as musicSearch from '@/lib/music-core/music-search'
import { logger } from '@/lib/logger'
import type { MusicInfo, SourceType } from '@/lib/types/music'

/** 换源尝试的平台顺序（与平台普遍可用性排序一致） */
const TOGGLE_SOURCE_ORDER: SourceType[] = ['wy', 'tx', 'kw', 'kg', 'mg']

/** 时长容差（秒）：同名翻唱/Live 常有 ±几秒差异，超太多视为不同版本 */
const INTERVAL_TOLERANCE_SECONDS = 4

/** 换源结果缓存：source-songmid → 匹配结果（null 表示已确认无替代，避免反复搜索） */
const toggleCache = new Map<string, MusicInfo | null>()
const TOGGLE_CACHE_MAX = 300

function cacheKey(musicInfo: MusicInfo): string {
  return `${musicInfo.source}-${musicInfo.songmid}`
}

function cacheSet(key: string, value: MusicInfo | null): void {
  if (toggleCache.size >= TOGGLE_CACHE_MAX) {
    // 简单清空策略：容量满时全清（换源命中本身有播放 URL 缓存兜底，损失可接受）
    toggleCache.clear()
  }
  toggleCache.set(key, value)
}

/** "04:29" → 269 秒；解析失败返回 null */
export function parseIntervalToSeconds(interval?: string | null): number | null {
  if (!interval) return null
  const m = interval.trim().match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/)
  if (!m) return null
  if (m[3] != null) {
    // hh:mm:ss
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  }
  return Number(m[1]) * 60 + Number(m[2])
}

/** 歌手名拆分（平台常见分隔符） */
function splitArtists(singer?: string | null): string[] {
  if (!singer) return []
  return singer
    .split(/[/,、&＆]/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
}

/** 歌名归一化：去空白与常见装饰符，用于宽松比对 */
function normalizeName(name?: string | null): string {
  if (!name) return ''
  return name.replace(/[\s'"'’“”()（）\[\]【】]/g, '').toLowerCase()
}

/**
 * 判断候选是否为同一首歌：
 * - 歌名宽松相等（归一化后互相包含）
 * - 至少一位歌手匹配（原唱/合唱任一命中即可）
 * - 时长若双方都有，容差 ±INTERVAL_TOLERANCE_SECONDS 秒
 */
function isSameSong(
  candidate: MusicInfo,
  name: string,
  singer: string,
  intervalSec: number | null
): boolean {
  const candName = normalizeName(candidate.name)
  const origName = normalizeName(name)
  if (!candName || !origName) return false
  if (!candName.includes(origName) && !origName.includes(candName)) return false

  const candArtists = splitArtists(candidate.singer)
  const origArtists = splitArtists(singer)
  if (candArtists.length > 0 && origArtists.length > 0) {
    const overlap = candArtists.some(a => origArtists.includes(a))
    if (!overlap) return false
  }

  if (intervalSec != null) {
    const candSec = parseIntervalToSeconds(candidate.interval)
    if (candSec != null && Math.abs(candSec - intervalSec) > INTERVAL_TOLERANCE_SECONDS) {
      return false
    }
  }

  return true
}

export interface AlternativeCandidate {
  musicInfo: MusicInfo
  source: SourceType
  intervalMatched: boolean
}

/**
 * 在其他平台搜索同款歌曲，返回全部候选（按平台顺序）。
 * 每平台取前 5 个候选做匹配，避免大歌单关键词命中过多翻唱。
 */
export async function findAlternatives(musicInfo: MusicInfo): Promise<AlternativeCandidate[]> {
  const { name, singer, source } = musicInfo
  if (!name) return []
  const intervalSec = parseIntervalToSeconds(musicInfo.interval)
  const keyword = singer ? `${name} ${singer}` : name

  const candidates: AlternativeCandidate[] = []
  const others = TOGGLE_SOURCE_ORDER.filter(s => s !== source)

  await Promise.all(
    others.map(async plat => {
      try {
        const result = await musicSearch.search(plat, keyword, 1, 8)
        const list = result?.list ?? []
        const matched = list
          .filter((item: MusicInfo) => isSameSong(item, name, singer ?? '', intervalSec))
          .slice(0, 2)
        for (const item of matched) {
          candidates.push({
            musicInfo: item,
            source: plat,
            intervalMatched: intervalSec != null && parseIntervalToSeconds(item.interval) != null,
          })
        }
      } catch (err) {
        logger.debug(`[source-toggle] ${plat} 平台搜索失败: ${err instanceof Error ? err.message : err}`)
      }
    })
  )

  // 按平台优先级排序，时长精确匹配的排前面
  const orderIndex = new Map(TOGGLE_SOURCE_ORDER.map((s, i) => [s, i]))
  candidates.sort((a, b) => {
    if (a.intervalMatched !== b.intervalMatched) return a.intervalMatched ? -1 : 1
    return (orderIndex.get(a.source) ?? 99) - (orderIndex.get(b.source) ?? 99)
  })
  return candidates
}

/**
 * 自动换源：返回最优替代版本；无替代返回 null。结果有缓存。
 */
export async function findBestAlternative(musicInfo: MusicInfo): Promise<MusicInfo | null> {
  const key = cacheKey(musicInfo)
  if (toggleCache.has(key)) return toggleCache.get(key) ?? null

  const candidates = await findAlternatives(musicInfo)
  const best = candidates[0]?.musicInfo ?? null
  cacheSet(key, best)
  if (best) {
    logger.info(
      `[source-toggle] 换源命中: ${musicInfo.source}-${musicInfo.name} → ${best.source}-${best.name} (${best.singer})`
    )
  } else {
    logger.info(`[source-toggle] 无替代版本: ${musicInfo.source}-${musicInfo.name}`)
  }
  return best
}

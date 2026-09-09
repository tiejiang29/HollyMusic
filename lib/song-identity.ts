/**
 * 跨副本歌曲归并工具。
 *
 * 同一首歌在曲库里往往有多个副本：跨音源（wy/kg/tx… 各存一份），
 * 甚至同音源多份（kg 不同音质的 FileHash 各不相同）。DB 层按 (source, songmid)
 * 幂等入库是有意为之——多副本是换源兜底的保险；展示层（推荐榜/搜索/随机听）
 * 再按此处的歌曲标识归并，只露出一份、优先带封面的副本。
 */

const SINGER_SPLIT_RE = /[、，,;；]+|\s+feat\.?\s+|\s+ft\.?\s+/i

/** 拆分合唱歌手串 "A、B" / "A, B" / "A feat. B" → 去重后的歌手数组。
 * 刻意不按 "/" 拆：保护 AC/DC 这类名字本身含斜杠的乐队。 */
export function splitSinger(raw: string | null | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(SINGER_SPLIT_RE)) {
    const name = part.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** 跨副本去重用的歌曲标识：规范化(歌名|歌手集合)。
 * 歌手集合 = 全部歌手归一化、去重、排序后拼接——与顺序无关，要求集合完全一致才算同曲。
 * 拆开的不同平台歌手写法（A、B / B，A / A feat. B）归一化后得到同一集合；
 * 主唱+合唱 与 纯主唱独唱版本集合不同，不会误并。 */
const IDENTITY_NORM_RE = /[\s·・']/g
const normalizePart = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(IDENTITY_NORM_RE, '')
export function songIdentity(mi: { name?: string | null; singer?: string | null }): string {
  const artists = [...new Set(splitSinger(mi.singer).map(normalizePart))].sort()
  return `${normalizePart(mi.name)}|${artists.join('|')}`
}

/** 参与归并判断的最小字段 */
export interface IdentityFields {
  name?: string | null
  singer?: string | null
  img?: string | null
}

/**
 * 同曲多副本归并：按 songIdentity 只保留一份，没封面的副本让位给有封面的。
 * 位置取该标识首次出现处（Map 覆盖写入不改变插入序），列表整体顺序不变。
 */
export function dedupeByIdentity<T>(items: T[], get: (item: T) => IdentityFields): T[] {
  const best = new Map<string, T>()
  for (const item of items) {
    const id = songIdentity(get(item))
    const kept = best.get(id)
    if (!kept || (!get(kept).img && get(item).img)) best.set(id, item)
  }
  return [...best.values()]
}

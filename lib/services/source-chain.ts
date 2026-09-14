/**
 * 三源编排器（搜索层链式降级）：酷我 → 咪咕 → Apple
 *
 * 链规则（用户定案）：
 * - 酷我结果中有「完全匹配」词条（归一化后名字相等）→ 用酷我
 * - 酷我无完全匹配 → 咪咕再搜，咪咕有完全匹配 → 用咪咕
 * - 两链都无完全匹配 → Apple 兜底
 * - Apple 也失败/为空 → 回落最好的模糊结果（酷我优先，其次咪咕），比空列表好
 *
 * 归一化口径：繁→简 + 小写 + 去非字母数字（"Taylor&nbsp;Swift"/"taylor swift" 等价）。
 * 详情层降级（kw/mg 失败按名字回落）在各 API 路由内，不经本编排器。
 */

import { logger } from '@/lib/logger'
import { searchKwArtists, searchKwAlbums, type KwArtistCard, type KwAlbumCard } from '@/lib/services/kw-chain-service'
import { searchMgArtists, searchMgAlbums, type MgArtistCard, type MgAlbumCard } from '@/lib/services/mg-chain-service'
import { searchItunesArtists, searchItunesAlbums, appleT2S } from '@/lib/services/itunes-service'
import { searchAmpArtists } from '@/lib/services/apple-amp-service'

export type ArtistCard = (KwArtistCard | MgArtistCard | { source: 'apple'; artistId: string; name: string; genre?: string })
export type AlbumCard = KwAlbumCard | MgAlbumCard | {
  source: 'apple'; albumId: string; name: string; artist: string; img: string | null; year?: string; trackCount?: number
}

/** 归一化比对键：简体+小写+去非字母数字 */
function normKey(value: string | null | undefined): string {
  return appleT2S(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function hasExactMatch<T extends { name?: string }>(list: T[], keyword: string): boolean {
  const k = normKey(keyword)
  if (!k) return false
  return list.some(item => normKey(item.name) === k)
}

/**
 * 歌手搜索链：kw(完全匹配?) → mg(完全匹配?) → apple → 模糊兜底
 * 返回 { source: 实际采用链, list: 卡片（每张带 source 字段） }
 */
export async function searchArtistCardsChain(
  keyword: string,
  limit = 10,
): Promise<{ source: 'kw' | 'mg' | 'apple'; list: ArtistCard[] }> {
  const [kwList, mgList] = await Promise.all([
    searchKwArtists(keyword, limit).catch(() => [] as KwArtistCard[]),
    // 咪咕并行预取（多数请求酷我有完全匹配，结果被丢弃也不亏——搜索有 24h 缓存）
    searchMgArtists(keyword, limit).catch(() => [] as MgArtistCard[]),
  ])

  if (hasExactMatch(kwList, keyword) && kwList.length > 0) {
    return { source: 'kw', list: kwList }
  }
  if (hasExactMatch(mgList, keyword) && mgList.length > 0) {
    return { source: 'mg', list: mgList }
  }

  // 两链均无完全匹配 → Apple 兜底（amp 版卡片自带官方头像；amp 失败回落老 iTunes Search API）
  try {
    const ampList = await searchAmpArtists(keyword, limit).catch(() => [])
    const appleList = ampList.length > 0 ? ampList : (await searchItunesArtists(keyword, limit)).map(c => ({ ...c, source: 'apple' as const }))
    if (appleList.length > 0) {
      return { source: 'apple', list: appleList }
    }
  } catch (error) {
    logger.warn('[source-chain] Apple 歌手搜索失败:', error instanceof Error ? error.message : error)
  }

  // 全兜底：返回最好的模糊结果（酷我优先）
  const best = kwList.length > 0 ? kwList : mgList
  return { source: best.length > 0 ? (best[0].source as 'kw' | 'mg') : 'kw', list: best }
}

/**
 * 专辑平台搜索链（本地库未命中时调用）：kw(完全匹配?) → mg(完全匹配?) → apple → 模糊兜底
 */
export async function searchAlbumCardsChain(
  keyword: string,
  limit = 30,
): Promise<AlbumCard[]> {
  const [kwList, mgList] = await Promise.all([
    searchKwAlbums(keyword, limit).catch(() => [] as KwAlbumCard[]),
    searchMgAlbums(keyword, limit).catch(() => [] as MgAlbumCard[]),
  ])

  if (hasExactMatch(kwList, keyword) && kwList.length > 0) return kwList
  if (hasExactMatch(mgList, keyword) && mgList.length > 0) return mgList

  try {
    const appleList = (await searchItunesAlbums(keyword, limit)).map(c => ({
      source: 'apple' as const,
      albumId: c.collectionId,
      name: c.title,
      artist: c.artist,
      img: c.img,
      year: c.year,
      trackCount: c.trackCount,
    }))
    if (appleList.length > 0) return appleList
  } catch (error) {
    logger.warn('[source-chain] Apple 专辑搜索失败:', error instanceof Error ? error.message : error)
  }

  return kwList.length > 0 ? kwList : mgList
}

/**
 * 多源编排器（搜索层链式降级）：TX 主链 → 酷我 → 咪咕 → Apple
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
import { searchTxArtists, type TxArtistCard } from '@/lib/services/tx-chain-service'
import { searchKwArtists, getKwArtistInfo, searchKwAlbums, type KwArtistCard, type KwAlbumCard } from '@/lib/services/kw-chain-service'
import { searchMgArtists, getMgArtistBio, searchMgAlbums, type MgArtistCard, type MgAlbumCard } from '@/lib/services/mg-chain-service'
import { searchItunesArtists, searchItunesAlbums, appleT2S } from '@/lib/services/itunes-service'
import { searchAmpArtists } from '@/lib/services/apple-amp-service'

export type ArtistCard = (TxArtistCard | KwArtistCard | MgArtistCard | { source: 'apple'; artistId: string; name: string; genre?: string })
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
): Promise<{ source: 'tx' | 'kw' | 'mg' | 'apple'; list: ArtistCard[] }> {
  // TX 主链（用户定案：TX 曲库最丰富）：tx/kw/mg 并行预取，完全匹配按 tx>kw>mg 判定
  const [txList, kwList, mgList] = await Promise.all([
    searchTxArtists(keyword, limit).catch(() => [] as TxArtistCard[]),
    searchKwArtists(keyword, limit).catch(() => [] as KwArtistCard[]),
    searchMgArtists(keyword, limit).catch(() => [] as MgArtistCard[]),
  ])

  if (hasExactMatch(txList, keyword) && txList.length > 0) {
    return { source: 'tx', list: txList }
  }
  if (hasExactMatch(kwList, keyword) && kwList.length > 0) {
    return { source: 'kw', list: kwList }
  }
  if (hasExactMatch(mgList, keyword) && mgList.length > 0) {
    return { source: 'mg', list: mgList }
  }

  // 三链均无完全匹配 → Apple 兜底（amp 版卡片自带官方头像；失败回落老 iTunes API）
  try {
    const ampList = await searchAmpArtists(keyword, limit).catch(() => [])
    const appleList = ampList.length > 0 ? ampList : (await searchItunesArtists(keyword, limit)).map(c => ({ ...c, source: 'apple' as const }))
    if (appleList.length > 0) {
      return { source: 'apple', list: appleList }
    }
  } catch (error) {
    logger.warn('[source-chain] Apple 歌手搜索失败:', error instanceof Error ? error.message : error)
  }

  // 全兜底：返回最好的模糊结果（tx 主链优先）
  const best = txList.length > 0 ? txList : kwList.length > 0 ? kwList : mgList
  return { source: best.length > 0 ? (best[0].source as 'tx' | 'kw' | 'mg') : 'tx', list: best }
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

/**
 * 快速歌手简介（免代理、300ms 级）：酷我百科 → 咪咕搜索 summary。
 * 供 TX 主链等无原生简介的链使用——主链不依赖 WIKI_PROXY（延迟不可接受）。
 */
export async function getFastArtistBio(name: string): Promise<string | null> {
  const q = name.trim()
  if (!q) return null
  // 酷我百科（歌手信息接口自带 bio，缓存 24h）
  try {
    const kwArtists = await searchKwArtists(q, 5)
    const kwHit = kwArtists.find(a => a.name === q) ?? kwArtists[0]
    if (kwHit) {
      const info = await getKwArtistInfo(kwHit.artistId)
      if (info?.bio) return info.bio
    }
  } catch { /* 落咪咕 */ }
  // 咪咕搜索 summary（按 singerId 锚定）
  try {
    const mgArtists = await searchMgArtists(q, 3)
    const mgHit = mgArtists.find(a => a.name === q) ?? mgArtists[0]
    if (mgHit) {
      const bio = await getMgArtistBio(mgHit.artistId, q)
      if (bio) return bio
    }
  } catch { /* 静默 */ }
  return null
}

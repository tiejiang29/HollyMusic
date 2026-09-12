/**
 * 单源歌曲搜索管线（从 app/api/search/route.ts 抽出共用）：
 * 搜索 → 整页入库（单事务）→ 附加 uid → 写单源缓存。
 * 搜索路由与专辑逐首搜曲（album-service）共用，保证入库/缓存行为完全一致。
 */
import { searchCache } from '@/lib/cache-manager'
import { upsertMusicInfosInTransaction, getStorageSongmidForMusicInfo } from '@/lib/db'
import { dedupeByIdentity } from '@/lib/song-identity'
import { logger } from '@/lib/logger'
import type { SearchResult, SourceType, Song } from '@/lib/types/music'
import * as musicSearch from '@/lib/music-core/music-search'

// 搜索缓存时间：210 分钟
const SEARCH_CACHE_TTL = 210 * 60 * 1000

export interface SingleSourceSearchResult extends Omit<SearchResult, 'list'> { list: Song[] }

export async function searchOneSource(source: SourceType, keyword: string, page: number, limit: number): Promise<SingleSourceSearchResult> {
  const cacheKey = `search:${source}:${keyword}:${page}:${limit}`
  const cached = searchCache.get(cacheKey) as (SearchResult & { list: Song[] }) | null
  if (cached) {
    logger.debug(`搜索缓存命中: ${cacheKey}`)
    return cached
  }

  const result: SearchResult = await musicSearch.search(source, keyword, page, limit)

  // 整页搜索结果在同一事务内顺序写入，避免 SQLite 多写入并发争抢写锁。
  // 入库失败时不返回或缓存无法被播放、歌词等接口查询到的 uid。
  try {
    await upsertMusicInfosInTransaction(result.list)
  } catch (error) {
    logger.error('search music info batch upsert failed', error)
    throw new Error('搜索结果入库失败')
  }

  // 同曲多副本（同源多音质等）只露出一份，优先带封面的副本；入缓存前归并
  const list: Song[] = dedupeByIdentity(
    result.list.map((mi) => ({
      ...mi,
      uid: `${mi.source}-${getStorageSongmidForMusicInfo(mi)}`,
    })),
    s => s,
  )
  const enriched = { ...result, list }

  searchCache.set(cacheKey, enriched, SEARCH_CACHE_TTL)
  logger.debug(`搜索结果已缓存: ${cacheKey} (${enriched.list.length} 条)`)
  return enriched
}

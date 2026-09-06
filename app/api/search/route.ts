/**
 * 音乐搜索 API
 * GET /api/search?source=kw&keyword=xxx&page=1&limit=30
 * GET /api/search?source=all&keyword=xxx —— 五源汇聚（服务端并发 + 按固定源顺序拼接）
 *
 * 需登录（requireUser），未登录返回 401。
 * 结果会入库（带 checksum 去重）并附加对外 uid，使前端可直接调封面/歌词/收藏。
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { searchCache } from '@/lib/cache-manager'
import { upsertMusicInfosInTransaction, getStorageSongmidForMusicInfo, getMusicInfo, prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import type { SearchResult, SourceType, Song } from '@/lib/types/music'
import * as musicSearch from '@/lib/music-core/music-search'

// 搜索缓存时间：210 分钟
const SEARCH_CACHE_TTL = 210 * 60 * 1000

/** 与前端 search-store 的 ALL_SOURCES 顺序一致：聚合结果按此顺序拼接。 */
const ALL_SOURCES: SourceType[] = ['tx', 'wy', 'kw', 'kg', 'mg']

/**
 * 本地音乐库搜索：name/singer/album contains 匹配，按 uid 反查 MusicInfo
 * 补全为标准 Song（封面/音质等与 /api/library 同一逻辑），命中标 local: true。
 * 不缓存——音乐库增删后搜索立即可见。
 */
async function searchLocalLibrary(keyword: string, limit: number): Promise<Song[]> {
  const k = keyword.trim()
  if (!k) return []
  const rows = await prisma.librarySong.findMany({
    where: { OR: [{ name: { contains: k } }, { singer: { contains: k } }, { album: { contains: k } }] },
    orderBy: [{ createdAt: 'desc' }],
    take: Math.max(1, limit),
  })
  const songs = await Promise.all(rows.map(async r => {
    // 重建索引生成的手动条目 uid 为空，无法进播放链路，跳过
    const dash = r.uid ? r.uid.indexOf('-') : -1
    if (!r.uid || dash <= 0) return null
    const mi = await getMusicInfo(r.uid.slice(0, dash), r.uid.slice(dash + 1))
    const base: Song = mi
      ? { ...mi, uid: r.uid }
      : {
          name: r.name,
          singer: r.singer,
          source: r.uid.slice(0, dash) as SourceType,
          songmid: r.uid.slice(dash + 1),
          interval: String(Math.round(r.durationSec || 0)),
          albumName: r.album || undefined,
          img: '',
          types: [],
          _types: {} as Song['_types'],
          typeUrl: {},
          uid: r.uid,
        }
    return { ...base, local: true } as Song
  }))
  return songs.filter((s): s is Song => s !== null)
}

/**
 * 单源搜索管线：搜索 → 整页入库（单事务）→ 附加 uid → 写单源缓存。
 * 汇聚模式与单源模式共用，保证入库/缓存行为完全一致。
 */
async function searchOneSource(source: SourceType, keyword: string, page: number, limit: number): Promise<SearchResult & { list: Song[] }> {
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

  const list: Song[] = result.list.map((mi) => ({
    ...mi,
    uid: `${mi.source}-${getStorageSongmidForMusicInfo(mi)}`,
  }))
  const enriched = { ...result, list }

  searchCache.set(cacheKey, enriched, SEARCH_CACHE_TTL)
  logger.debug(`搜索结果已缓存: ${cacheKey} (${enriched.list.length} 条)`)
  return enriched
}

export async function GET(request: NextRequest) {
  try {
    await requireUser(request) // 未登录 → AuthError → 401

    const searchParams = request.nextUrl.searchParams
    const source = searchParams.get('source') as SourceType | 'all' | 'local'
    const keyword = searchParams.get('keyword')
    const page = parseInt(searchParams.get('page') || '1')
    const limit = parseInt(searchParams.get('limit') || '30')

    // 参数验证
    if (!source) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '缺少必填参数: source', 400)
    }
    if (!keyword) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '缺少必填参数: keyword', 400)
    }

    if (source !== 'all' && source !== 'local') {
      const validSources: SourceType[] = ['kw', 'kg', 'tx', 'wy', 'mg']
      if (!validSources.includes(source)) {
        return createErrorResponse(
          ErrorCodes.SOURCE_NOT_SUPPORTED,
          `不支持的音源: ${source}，支持: all, local, ${validSources.join(', ')}`,
          400
        )
      }
    }

    if (page < 1 || limit < 1 || limit > 100) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '参数错误: page >= 1, 1 <= limit <= 100', 400)
    }

    logger.info(`搜索请求: ${source} - ${keyword} (page: ${page})`)

    // ---------- 纯本地库搜索 ----------
    if (source === 'local') {
      const list = await searchLocalLibrary(keyword, limit)
      return createSuccessResponse({ list, total: list.length, allPage: 1, page, limit, source: 'local' as const })
    }

    // ---------- 平台搜索（单源/五源汇聚），附带本地匹配 ----------
    // localList 每次实时查库（不进平台缓存）：音乐库增删后，下次搜索立即反映
    const localPromise = searchLocalLibrary(keyword, 8).catch((): Song[] => [])
    if (source !== 'all') {
      const [result, localList] = await Promise.all([
        searchOneSource(source, keyword, page, limit),
        localPromise,
      ])
      return createSuccessResponse({ ...result, localList })
    }

    // ---------- 五源汇聚 ----------
    // 聚合结果整体缓存；命中时一次返回，未命中才扇出五源。
    const allCacheKey = `search:all:${keyword}:${page}:${limit}`
    const cachedAll = searchCache.get(allCacheKey)
    if (cachedAll) {
      logger.debug(`搜索缓存命中: ${allCacheKey}`)
      const [localList] = await Promise.all([localPromise])
      return createSuccessResponse({ ...cachedAll, localList })
    }
    // 并发五源（allSettled），失败源跳过；至少一源成功即返回，
    // 顺序与前端 ALL_SOURCES 一致（tx→wy→kw→kg→mg 依次拼接）。
    const settled = await Promise.allSettled(
      ALL_SOURCES.map(s => searchOneSource(s, keyword, page, limit))
    )
    const okResults: Array<SearchResult & { list: Song[] }> = []
    const failErrs: unknown[] = []
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') okResults.push(r.value)
      else {
        failErrs.push(r.reason)
        logger.warn(`[search all] 源 ${ALL_SOURCES[i]} 失败:`, r.reason instanceof Error ? r.reason.message : r.reason)
      }
    })
    if (okResults.length === 0) {
      return createErrorResponse(
        ErrorCodes.SEARCH_FAILED,
        '所有音源搜索失败，请稍后重试',
        502
      )
    }

    // 部分源失败时透出失败源列表，客户端可提示"结果不含 xx"
    const failedSources = ALL_SOURCES.filter((_, i) => settled[i].status === 'rejected')
    const merged = {
      list: okResults.flatMap(r => r.list),
      total: okResults.reduce((sum, r) => sum + (r.total || r.list.length), 0),
      allPage: Math.max(...okResults.map(r => r.allPage || 1)),
      page,
      limit,
      source: 'all' as const,
      ...(failedSources.length > 0 ? { failedSources } : {}),
    }

    searchCache.set(allCacheKey, merged, SEARCH_CACHE_TTL)
    const [localList] = await Promise.all([localPromise])
    return createSuccessResponse({ ...merged, localList })
  } catch (error) {
    if (error instanceof AuthError) {
      return createErrorResponse('UNAUTHORIZED', error.message, 401)
    }
    logger.error('搜索失败:', error)
    return createErrorResponse(
      ErrorCodes.SEARCH_FAILED,
      error instanceof Error ? error.message : '搜索失败',
      500,
      error instanceof Error ? error.stack : undefined
    )
  }
}

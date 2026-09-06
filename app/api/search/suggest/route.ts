import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { prisma } from '@/lib/db'
import { searchCache } from '@/lib/cache-manager'

/**
 * 搜索联想 API（登录用户）
 * GET /api/search/suggest?keyword=xxx
 *
 * 数据源（并行，整体 1.2s 截断——联想宁快勿全）：
 * 1. 网易云 legacy suggest 接口（GET，无需加密；返回歌曲/歌手/专辑联想）
 * 2. 本地音乐库（name/singer 包含匹配；零网络，对用户自己的库最相关）
 *
 * 合并去重后最多 10 条；结果短缓存（10 分钟）。
 */

const FETCH_TIMEOUT_MS = 2_500
const OVERALL_BUDGET_MS = 1_200
const CACHE_TTL = 10 * 60 * 1000
const MAX_ITEMS = 10

export interface SuggestItem {
  text: string
  type: 'song' | 'singer' | 'album'
}

/** 网易云联想（legacy 接口，GET 明文，返回 result.{songs,artists,albums}） */
async function fetchNeteaseSuggest(keyword: string): Promise<SuggestItem[]> {
  try {
    const resp = await fetch(
      `https://music.163.com/api/search/suggest/web?s=${encodeURIComponent(keyword)}&limit=8`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          Referer: 'https://music.163.com/',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    )
    if (!resp.ok) return []
    const j = (await resp.json().catch(() => null)) as {
      result?: {
        songs?: Array<{ name?: string; artists?: Array<{ name?: string }> }>
        artists?: Array<{ name?: string }>
        albums?: Array<{ name?: string }>
      }
    } | null
    const r = j?.result
    if (!r) return []
    const items: SuggestItem[] = []
    for (const s of r.songs ?? []) {
      if (!s?.name) continue
      const artist = s.artists?.[0]?.name
      items.push({ text: artist ? `${s.name} - ${artist}` : s.name, type: 'song' })
    }
    for (const a of r.artists ?? []) {
      if (a?.name) items.push({ text: a.name, type: 'singer' })
    }
    for (const al of r.albums ?? []) {
      if (al?.name) items.push({ text: al.name, type: 'album' })
    }
    return items
  } catch {
    return []
  }
}

/** 本地音乐库联想（name/singer 包含匹配） */
async function fetchLibrarySuggest(keyword: string): Promise<SuggestItem[]> {
  try {
    const rows = await prisma.librarySong.findMany({
      where: {
        OR: [{ name: { contains: keyword } }, { singer: { contains: keyword } }],
      },
      select: { name: true, singer: true },
      take: 6,
      orderBy: { createdAt: 'desc' },
    })
    return rows.map(r => ({
      text: r.singer && !r.name.includes(r.singer) ? `${r.name} - ${r.singer.split(/[、,，/／&＆;；]/)[0]}` : r.name,
      type: 'song' as const,
    }))
  } catch {
    return []
  }
}

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)

    const keyword = (new URL(request.url).searchParams.get('keyword') || '').trim().slice(0, 60)
    if (!keyword) return createSuccessResponse<SuggestItem[]>([])

    const cacheKey = `suggest:v1:${keyword}`
    const cached = searchCache.get(cacheKey) as SuggestItem[] | null
    if (cached) return createSuccessResponse(cached)

    // 两源并行，整体预算 1.2s（超时源静默丢弃）
    const merged = await Promise.race([
      Promise.all([fetchNeteaseSuggest(keyword), fetchLibrarySuggest(keyword)]),
      new Promise<[SuggestItem[], SuggestItem[]]>(r => setTimeout(() => [[], []] as [SuggestItem[], SuggestItem[]], OVERALL_BUDGET_MS)),
    ])

    // 去重（文本归一：去空格小写），本地库优先排前
    const seen = new Set<string>()
    const items: SuggestItem[] = []
    for (const item of [...merged[1], ...merged[0]]) {
      const key = item.text.replace(/\s+/g, '').toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
      if (items.length >= MAX_ITEMS) break
    }

    searchCache.set(cacheKey, items, CACHE_TTL)
    return createSuccessResponse(items)
  } catch (error) {
    if (error instanceof AuthError) {
      return createErrorResponse('UNAUTHORIZED', error.message, 401)
    }
    logger.error('[api/search/suggest] error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '获取联想失败', 500)
  }
}

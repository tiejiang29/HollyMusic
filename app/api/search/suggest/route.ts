import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { prisma } from '@/lib/db'
import { searchCache } from '@/lib/cache-manager'
import { searchTxAlbums } from '@/lib/services/tx-chain-service'

/**
 * 搜索联想 API（登录用户）
 * GET /api/search/suggest?keyword=xxx
 *
 * 数据源（并行，整体 1.2s 截断——联想宁快勿全）：
 * 1. 网易云 legacy suggest 接口（GET，无需加密；返回歌曲/歌手联想）
 * 2. 本地音乐库（name/singer 包含匹配；零网络，对用户自己的库最相关）
 * 3. TX 专辑搜索（smartbox）：专辑语料（网易联想几乎不给专辑）
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

/**
 * 专辑联想（TX smartbox）：网易 legacy 联想对专辑几乎不给结果
 * （实测「叶惠美」「七里香」的 result.albums 均为空），故专辑语料改用 TX 专辑搜索，
 * 与专辑搜索链首（TX → 酷我 → 咪咕 → Apple）保持一致。
 */
async function fetchTxAlbumSuggest(keyword: string): Promise<SuggestItem[]> {
  try {
    const cards = await searchTxAlbums(keyword, 8)
    return cards.filter(c => c.name).map(c => ({ text: c.name, type: 'album' as const }))
  } catch {
    return []
  }
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
    const songs: SuggestItem[] = []
    for (const s of r.songs ?? []) {
      if (!s?.name) continue
      const artist = s.artists?.[0]?.name
      songs.push({ text: artist ? `${s.name} - ${artist}` : s.name, type: 'song' })
    }
    const singers: SuggestItem[] = []
    for (const a of r.artists ?? []) {
      if (a?.name) singers.push({ text: a.name, type: 'singer' })
    }
    const albums: SuggestItem[] = []
    for (const al of r.albums ?? []) {
      if (al?.name) albums.push({ text: al.name, type: 'album' })
    }
    return [...singers, ...songs, ...albums]
  } catch {
    return []
  }
}

/** 网易云艺人搜索（type=100）：补足 suggest 接口对短词只回 0-1 位歌手的短板 */
async function fetchNeteaseArtists(keyword: string): Promise<SuggestItem[]> {
  try {
    const resp = await fetch(
      `https://music.163.com/api/search/get?s=${encodeURIComponent(keyword)}&type=100&limit=5`,
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
      result?: { artists?: Array<{ name?: string }> }
    } | null
    return (j?.result?.artists ?? [])
      .filter(a => a?.name)
      .map(a => ({ text: a.name!, type: 'singer' as const }))
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

    const params = new URL(request.url).searchParams
    const keyword = (params.get('keyword') || '').trim().slice(0, 60)
    if (!keyword) return createSuccessResponse<SuggestItem[]>([])

    // 类型过滤（type=song|artist|album；缺省不过滤保持旧行为）。
    // artist 复用五源歌手联想（网易 suggest 的 singer 项），album 复用本地专辑前缀联想。
    const type = params.get('type') || ''

    const cacheKey = `suggest:v4:${type}:${keyword}`
    const cached = searchCache.get(cacheKey) as SuggestItem[] | null
    if (cached) return createSuccessResponse(cached)

    // 四源并行，整体预算 1.2s（超时源静默丢弃）
    const [wySuggest, libraryItems, artistItems, txAlbums] = await Promise.race([
      Promise.all([fetchNeteaseSuggest(keyword), fetchLibrarySuggest(keyword), fetchNeteaseArtists(keyword), fetchTxAlbumSuggest(keyword)]),
      new Promise<[SuggestItem[], SuggestItem[], SuggestItem[], SuggestItem[]]>(r =>
        setTimeout(() => [[], [], [], []] as [SuggestItem[], SuggestItem[], SuggestItem[], SuggestItem[]], OVERALL_BUDGET_MS)
      ),
    ])

    // 按结果类型取对应语料集（各自独立占满 10 条上限）：
    // 给某类型单独成集，避免专辑项排在歌手/歌曲之后被上限挤出（旧实现先合并再过滤，专辑常被挤空）。
    const items: SuggestItem[] = []
    const seen = new Set<string>()
    const push = (item: SuggestItem) => {
      if (items.length >= MAX_ITEMS) return
      const key = item.text.replace(/\s+/g, '').toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      items.push(item)
    }
    if (type === 'album') {
      // 专辑语料：TX 专辑搜索优先，其次网易联想里的专辑项
      for (const item of txAlbums) push(item)
      for (const item of wySuggest.filter(i => i.type === 'album')) push(item)
    } else if (type === 'artist') {
      for (const item of [...wySuggest, ...artistItems].filter(i => i.type === 'singer')) push(item)
    } else if (type === 'song') {
      for (const item of libraryItems) push(item)
      for (const item of wySuggest.filter(i => i.type === 'song')) push(item)
    } else {
      // 缺省（不按类型）：歌手置顶（人名搜索意图最强，也避免被大量歌曲挤出上限）
      // → 本地音乐库 → 歌曲 → TX 专辑 → 网易专辑
      let singerSlots = 4
      for (const item of [...wySuggest, ...artistItems].filter(i => i.type === 'singer')) {
        if (singerSlots <= 0) break
        const before = items.length
        push(item)
        if (items.length > before) singerSlots--
      }
      for (const item of libraryItems) push(item)
      for (const item of wySuggest.filter(i => i.type === 'song')) push(item)
      for (const item of txAlbums) push(item)
      for (const item of wySuggest.filter(i => i.type === 'album')) push(item)
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

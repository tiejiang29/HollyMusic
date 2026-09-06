import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError, requireAdmin, ForbiddenError } from '@/lib/services/user-context'
import { prisma, getMusicInfo } from '@/lib/db'
import { getLibraryStats, splitSingerArtists } from '@/lib/services/music-library'
import { pinyin } from 'pinyin-pro'


// ---------- 拼音首字母搜索（"zjl" → 周杰伦） ----------
// 纯字母关键词额外按歌名+歌手的拼音首字母子串匹配；缓存避免重复转换
const initialsCache = new Map<string, string>()
function getInitials(text: string): string {
  let v = initialsCache.get(text)
  if (v === undefined) {
    try {
      v = pinyin(text, { pattern: 'first', type: 'array' }).join('').toLowerCase()
    } catch {
      v = ''
    }
    if (initialsCache.size > 20000) initialsCache.clear()
    initialsCache.set(text, v)
  }
  return v
}

/** DB 完整串 groupBy 结果 → 拆分聚合的全歌手列表（含首字母，按字母序） */
function aggregateArtists(groups: Array<{ singer: string; _count: { _all: number } }>) {
  const map = new Map<string, number>()
  for (const g of groups) {
    for (const artist of splitSingerArtists(g.singer)) {
      map.set(artist, (map.get(artist) || 0) + g._count._all)
    }
  }
  return [...map.entries()]
    .map(([name, count]) => ({ singer: name, count, initials: getInitials(name) }))
    .sort((a, b) => a.singer.localeCompare(b.singer, 'zh'))
}

/**
 * 音乐库列表 API（登录用户）
 * GET /api/library?keyword=&singer=&page=&pageSize=
 * 返回分页歌曲列表 + 统计（数量/容量/配额/是否已满）+ 歌手聚合（浏览页左栏）。
 */
export async function GET(request: NextRequest) {
  try {
    await requireUser(request)

    const params = new URL(request.url).searchParams
    const keyword = params.get('keyword')?.trim() || ''
    const singer = params.get('singer')?.trim() || ''
    const page = Math.max(1, parseInt(params.get('page') || '1', 10) || 1)
    const pageSize = Math.min(200, Math.max(10, parseInt(params.get('pageSize') || '100', 10) || 100))

    // 纯字母关键词 → 额外匹配歌名/歌手拼音首字母（zjl → 周杰伦）；
    // 英文名仍走普通 contains（aespa 等）
    let initialsIds: number[] | null = null
    if (keyword && /^[a-z]+$/i.test(keyword)) {
      const all = await prisma.librarySong.findMany({ select: { id: true, name: true, singer: true } })
      const kw = keyword.toLowerCase()
      initialsIds = all
        .filter(r => (getInitials(r.name) + getInitials(r.singer)).includes(kw))
        .map(r => r.id)
    }

    const where = {
      ...(keyword
        ? {
            OR: [
              { name: { contains: keyword } },
              { singer: { contains: keyword } },
              { album: { contains: keyword } },
              ...(initialsIds ? [{ id: { in: initialsIds } }] : []),
            ],
          }
        : {}),
      // 多歌手筛选：完整 singer 串包含匹配（"周杰伦、费玉清" 按任一歌手都能筛出）
      ...(singer ? { singer: { contains: singer } } : {}),
    }

    const [list, total, stats, singerGroups] = await Promise.all([
      prisma.librarySong.findMany({
        where,
        orderBy: [{ singer: 'asc' }, { album: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.librarySong.count({ where }),
      getLibraryStats(),
      // 歌手聚合：主歌手（取完整串第一个之前的部分在服务端做太重，直接按完整串
      // groupBy；前端按逗号/顿号拆分聚合成主歌手视图）
      prisma.librarySong.groupBy({
        by: ['singer'],
        _count: { _all: true },
        orderBy: { _count: { singer: 'desc' } },
        take: 500,
      }),
    ])

    // 封面：按 uid 反查 MusicInfo.img（重建索引的手动条目 uid 为空，无封面走占位）
    const coverMap = new Map(
      await Promise.all(
        [...new Set(list.map(r => r.uid).filter(Boolean))].map(async uid => {
          const dash = uid.indexOf('-')
          if (dash <= 0) return [uid, ''] as const
          const mi = await getMusicInfo(uid.slice(0, dash), uid.slice(dash + 1))
          return [uid, mi?.img || ''] as const
        })
      )
    )

    return createSuccessResponse({
      list: list.map(r => ({ ...r, img: coverMap.get(r.uid) || '' })),
      total,
      page,
      pageSize,
      stats,
      // 服务端聚合全歌手（拆分多歌手串）+ 拼音首字母：前端歌手栏
      // 搜索/过滤直接用，避免前端引入拼音库
      singerGroups: aggregateArtists(singerGroups),
    })
  } catch (error) {
    if (error instanceof AuthError) {
      return createErrorResponse('UNAUTHORIZED', error.message, 401)
    }
    if (error instanceof ForbiddenError) {
      return createErrorResponse('FORBIDDEN', error.message, 403)
    }
    logger.error('[api/library GET] error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '获取音乐库失败', 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request)
    return createErrorResponse(ErrorCodes.INVALID_PARAMS, '不支持的操作', 400)
  } catch {
    return createErrorResponse('UNAUTHORIZED', '请先登录', 401)
  }
}

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError, requireAdmin, ForbiddenError } from '@/lib/services/user-context'
import { prisma } from '@/lib/db'
import { getLibraryStats } from '@/lib/services/music-library'

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

    const where = {
      ...(keyword
        ? {
            OR: [
              { name: { contains: keyword } },
              { singer: { contains: keyword } },
              { album: { contains: keyword } },
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

    return createSuccessResponse({
      list,
      total,
      page,
      pageSize,
      stats,
      singerGroups: singerGroups.map(g => ({ singer: g.singer, count: g._count._all })),
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

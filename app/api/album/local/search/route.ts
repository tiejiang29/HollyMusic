/**
 * 本地专辑搜索 API
 * GET /api/album/local/search?keyword=周杰伦&limit=30
 *
 * 本地专辑库（专辑名/歌手包含，gid 去重）优先；本地未命中自动回退网易平台专辑搜索（platformList）。
 * 安卓专辑板块"搜索专辑"用。
 * 需登录；库文件缺失时返回空列表。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { searchAlbums } from '@/lib/services/album-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const keyword = request.nextUrl.searchParams.get('keyword') || ''
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '30')
    // 本地专辑库优先；未命中自动回退网易平台专辑搜索（platformList）
    return createSuccessResponse(await searchAlbums(keyword, Number.isFinite(limit) ? limit : 30))
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '本地专辑搜索失败', 500)
  }
}

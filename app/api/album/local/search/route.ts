/**
 * 本地专辑搜索 API
 * GET /api/album/local/search?keyword=周杰伦&limit=30
 *
 * 专辑名前缀/包含 + 歌手包含，gid 去重。安卓专辑板块"搜索专辑"用。
 * 需登录；库文件缺失时返回空列表。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { searchLocalAlbums } from '@/lib/services/album-local-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const keyword = request.nextUrl.searchParams.get('keyword') || ''
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '30')
    return createSuccessResponse({ list: searchLocalAlbums(keyword, Number.isFinite(limit) ? limit : 30) })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '本地专辑搜索失败', 500)
  }
}

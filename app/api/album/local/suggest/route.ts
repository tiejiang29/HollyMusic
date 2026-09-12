/**
 * 本地专辑联想 API
 * GET /api/album/local/suggest?keyword=七里&limit=10
 *
 * 专辑名前缀联想（本地 SQLite 索引，毫秒级），供专辑搜索框输入联想。
 * 需登录；库文件缺失时返回空列表（功能降级）。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { suggestLocalAlbums } from '@/lib/services/album-local-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const keyword = request.nextUrl.searchParams.get('keyword') || ''
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '10')
    return createSuccessResponse({ list: suggestLocalAlbums(keyword, Number.isFinite(limit) ? limit : 10) })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '本地专辑联想失败', 500)
  }
}

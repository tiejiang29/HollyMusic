/**
 * 随机本地专辑 API
 * GET /api/album/local/random?size=20
 *
 * 本地专辑板块"随机显示专辑"。需登录；库文件缺失时返回空列表。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { randomLocalAlbums } from '@/lib/services/album-local-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const size = parseInt(request.nextUrl.searchParams.get('size') || '20')
    return createSuccessResponse({ list: randomLocalAlbums(Number.isFinite(size) ? size : 20) })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '随机专辑获取失败', 500)
  }
}

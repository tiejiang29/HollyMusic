/**
 * 热门本地专辑 API
 * GET /api/album/local/hot?size=12
 *
 * 五平台热歌榜反推：榜单上的歌必属热门专辑，匹配回本地库（既热门又能播）。
 * 按专辑的上榜歌曲数排序；热歌池自带缓存，匹配纯本地。需登录。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getHotLocalAlbums } from '@/lib/services/album-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const size = parseInt(request.nextUrl.searchParams.get('size') || '12')
    const list = await getHotLocalAlbums(Number.isFinite(size) ? size : 12)
    return createSuccessResponse({ list })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '热门专辑获取失败', 500)
  }
}

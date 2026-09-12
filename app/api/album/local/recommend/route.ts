/**
 * 画像推荐本地专辑 API
 * GET /api/album/local/recommend?size=12
 *
 * 按当前用户画像（收藏/歌单/播放聚合的歌手亲和度）推送本地专辑；画像不足回退随机。
 * 同用户同日确定性洗牌（刷新不变）。需登录。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { recommendLocalAlbums } from '@/lib/services/album-local-service'

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request)
    const size = parseInt(request.nextUrl.searchParams.get('size') || '12')
    const result = await recommendLocalAlbums(user.username, user.id, Number.isFinite(size) ? size : 12)
    return createSuccessResponse(result)
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '专辑推荐获取失败', 500)
  }
}

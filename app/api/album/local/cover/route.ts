/**
 * 本地专辑封面 API
 * GET /api/album/local/cover?gid=<uuid>
 *
 * 专辑卡片封面懒加载用：取专辑首曲目在 tx 搜一曲推导 QQ 专辑封面直链。
 * 结果缓存 24h（无封面也缓存，避免重复探测）。需登录；失败返回 {img: null}。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getAlbumCover } from '@/lib/services/album-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const gid = request.nextUrl.searchParams.get('gid') || ''
    if (!/^[0-9a-f-]{36}$/i.test(gid)) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '无效的专辑 gid', 400)
    }
    return createSuccessResponse({ img: await getAlbumCover(gid) })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '专辑封面获取失败', 500)
  }
}

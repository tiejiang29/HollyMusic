/**
 * 收藏状态检查 API
 * GET /api/favorites/check?id={songId}                                    → { starred: boolean }
 * GET /api/favorites/check?id={albumId}&type=album&source={平台}          → { starred: boolean }
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { checkStarred, checkAlbumStarred } from '@/lib/services/favorites-service'

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request)
    const params = request.nextUrl.searchParams
    const id = params.get('id')
    if (!id) return createErrorResponse(ErrorCodes.INVALID_PARAMS, '缺少必填参数: id', 400)
    const starred = params.get('type') === 'album'
      ? await checkAlbumStarred(user.id, id, params.get('source'))
      : await checkStarred(user.id, id)
    return createSuccessResponse({ starred })
  } catch (err) {
    if (err instanceof AuthError) return createErrorResponse('UNAUTHORIZED', err.message, 401)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '检查收藏失败', 500)
  }
}

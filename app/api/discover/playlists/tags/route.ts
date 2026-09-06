import { NextRequest } from 'next/server'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getPlaylistTags, isDiscoverySource } from '@/lib/services/discovery-service'

/** GET /api/discover/playlists/tags?source=tx —— 歌单广场标签（热门 + 分组，各平台上游同洛雪） */
export async function GET(request: NextRequest) {
  try {
    await requireUser(request) // 未登录 → AuthError → 401

    const source = request.nextUrl.searchParams.get('source') || 'tx'
    if (!isDiscoverySource(source)) return createErrorResponse(ErrorCodes.INVALID_PARAMS, '不支持的渠道', 400)
    return createSuccessResponse(await getPlaylistTags(source))
  } catch (error) {
    if (error instanceof AuthError) {
      return createErrorResponse('UNAUTHORIZED', error.message, 401)
    }
    logger.error('[api/discover/playlists/tags] error:', error instanceof Error ? error.message : error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '获取歌单标签失败', 500)
  }
}

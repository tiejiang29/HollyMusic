import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getTrending } from '@/lib/services/discovery-service'

/**
 * GET /api/discover/trending?topPerSource=10 —— 大家都在听
 * 五平台热歌榜各取前 N，跨平台去重合成一张歌单（标准 Song[]，可直接进播放队列）。
 */
export async function GET(request: NextRequest) {
  try {
    await requireUser(request) // 未登录 → AuthError → 401

    const topPerSource = parseInt(request.nextUrl.searchParams.get('topPerSource') || '10', 10)
    return createSuccessResponse(await getTrending(Number.isFinite(topPerSource) ? topPerSource : 10))
  } catch (error) {
    if (error instanceof AuthError) {
      return createErrorResponse('UNAUTHORIZED', error.message, 401)
    }
    logger.error('[api/discover/trending] error:', error instanceof Error ? error.message : error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '获取大家都在听失败', 500)
  }
}

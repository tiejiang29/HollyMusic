import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getPlaylistGroups, isDiscoverySource } from '@/lib/services/discovery-service'

/**
 * GET /api/discover/playlists/groups?source=tx&perTag=6 —— 推荐歌单按类型聚合
 * 热门标签每类拉 N 张歌单，一次返回全部分区（移动端首页"分区卡片"成型接口）。
 */
export async function GET(request: NextRequest) {
  try {
    await requireUser(request) // 未登录 → AuthError → 401

    const source = request.nextUrl.searchParams.get('source') || 'tx'
    if (!isDiscoverySource(source)) return createErrorResponse(ErrorCodes.INVALID_PARAMS, '不支持的渠道', 400)
    const perTag = parseInt(request.nextUrl.searchParams.get('perTag') || '6', 10)
    return createSuccessResponse(await getPlaylistGroups(source, Number.isFinite(perTag) ? perTag : 6))
  } catch (error) {
    if (error instanceof AuthError) {
      return createErrorResponse('UNAUTHORIZED', error.message, 401)
    }
    logger.error('[api/discover/playlists/groups] error:', error instanceof Error ? error.message : error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '获取歌单聚合失败', 500)
  }
}

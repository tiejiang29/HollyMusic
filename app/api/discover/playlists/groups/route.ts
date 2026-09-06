import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getPlaylistGroups } from '@/lib/services/discovery-service'

/**
 * GET /api/discover/playlists/groups?perPlatform=3 —— 推荐歌单按类型聚合（跨平台）
 * 固定类目（流行/经典/儿歌/摇滚/民谣/电子/国风/ACG），每类从五平台各拉 N 张
 * 合并为一个分区（歌单带 source 字段），移动端首页"分区卡片"一次成型。
 */
export async function GET(request: NextRequest) {
  try {
    await requireUser(request) // 未登录 → AuthError → 401

    const perPlatform = parseInt(request.nextUrl.searchParams.get('perPlatform') || '3', 10)
    return createSuccessResponse(await getPlaylistGroups(Number.isFinite(perPlatform) ? perPlatform : 3))
  } catch (error) {
    if (error instanceof AuthError) {
      return createErrorResponse('UNAUTHORIZED', error.message, 401)
    }
    logger.error('[api/discover/playlists/groups] error:', error instanceof Error ? error.message : error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '获取歌单聚合失败', 500)
  }
}

/**
 * Apple 专辑曲目 API
 * GET /api/album/apple/tracks?collectionId=<apple collectionId>
 *
 * Apple 专辑卡片（搜索 platformList）详情：Apple 曲目表（繁→简）→
 * 逐首在线搜曲落歌（tx→kw→kg→mg→wy，三重校验）→ 可播放 Song[]。
 * 需登录；collectionId 无效返回 unsupported: true。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getAppleAlbumDetail } from '@/lib/services/album-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const collectionId = request.nextUrl.searchParams.get('collectionId') || ''
    if (!/^\d+$/.test(collectionId)) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '无效的 collectionId', 400)
    }
    const detail = await getAppleAlbumDetail(collectionId)
    if (!detail) {
      return createSuccessResponse({ album: null, list: [], unsupported: true })
    }
    logger.info(`Apple 专辑详情: ${detail.album.name}（${detail.list.length}/${detail.album.trackCount} 首可播）`)
    return createSuccessResponse(detail)
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    logger.error('Apple 专辑详情失败:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Apple 专辑详情获取失败', 500)
  }
}

/**
 * Apple 歌手详情 API
 * GET /api/artist/apple/detail?artistId=<apple artistId>
 *
 * 歌手搜索（/api/search?type=artist）选中卡片后的详情：
 * - 热门歌曲：Apple 热门度排序 → 本地库 identity 优先 → 在线五源落歌（可播）
 * - 专辑列表：Apple 歌手专辑索引（缓存 24h），点进走 /api/album/apple/tracks
 * - 简介：维基（简体，需配置 WIKI_PROXY_URL，未配置时缺省）
 * 需登录；artistId 无效返回 unsupported: true。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getAppleArtistDetail } from '@/lib/services/album-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const artistId = request.nextUrl.searchParams.get('artistId') || ''
    if (!/^\d+$/.test(artistId)) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '无效的 artistId', 400)
    }
    const detail = await getAppleArtistDetail(artistId)
    if (!detail) {
      return createSuccessResponse({ artist: null, hotSongs: [], albums: [], unsupported: true })
    }
    logger.info(`歌手详情: ${detail.artist.name}（热门歌 ${detail.hotSongs.length}/${detail.artist.bio ? '有简介' : '无简介'}）`)
    return createSuccessResponse(detail)
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    logger.error('歌手详情获取失败:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '歌手详情获取失败', 500)
  }
}

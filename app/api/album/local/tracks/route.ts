/**
 * 本地专辑曲目 API
 * GET /api/album/local/tracks?gid=<uuid>
 *
 * 本地专辑板块点专辑 → 曲目表逐首在线搜曲（tx→kw→kg→mg→wy，歌名+歌手+时长三重校验）
 * → 可播放 Song[]（混合源 uid，播放/下载与搜索结果同构）。
 * 需登录；gid 不在本地库返回 unsupported: true。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { isLocalAlbumDbAvailable } from '@/lib/services/album-local-service'
import { getLocalAlbumDetailByGid } from '@/lib/services/album-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const gid = request.nextUrl.searchParams.get('gid') || ''
    if (!isLocalAlbumDbAvailable()) {
      return createSuccessResponse({ album: null, list: [], unsupported: true })
    }
    const detail = await getLocalAlbumDetailByGid(gid)
    if (!detail) return createSuccessResponse({ album: null, list: [], unsupported: true })
    logger.info(`本地专辑曲目: ${detail.album.name}（${detail.list.length}/${detail.album.trackCount} 首可播）`)
    return createSuccessResponse(detail)
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    logger.error('本地专辑曲目失败:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '本地专辑曲目获取失败', 500)
  }
}

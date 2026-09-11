/**
 * 专辑曲目详情 API
 * GET /api/album/tracks?source=wy&albumId=xxx
 *
 * 需登录（requireUser），未登录返回 401。
 * 曲目走搜索同款入库管道（upsert + uid），播放/下载/收藏/封面/歌词等接口可直接使用。
 * 一期支持 wy / kw；mg 的专辑曲目端点已失效，返回 unsupported: true（专辑卡片仍可搜）。
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getAlbumTracks, isAlbumSource, ALBUM_SOURCES, AlbumTracksUnsupportedError, type AlbumSource } from '@/lib/services/album-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request) // 未登录 → AuthError → 401

    const searchParams = request.nextUrl.searchParams
    const source = searchParams.get('source') as AlbumSource | null
    const albumId = searchParams.get('albumId')

    // 参数验证
    if (!source) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '缺少必填参数: source', 400)
    }
    if (!albumId) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '缺少必填参数: albumId', 400)
    }
    if (!isAlbumSource(source)) {
      return createErrorResponse(
        ErrorCodes.SOURCE_NOT_SUPPORTED,
        `不支持的音源: ${source}，支持: ${ALBUM_SOURCES.join(', ')}`,
        400
      )
    }

    logger.info(`专辑详情请求: ${source} - ${albumId}`)
    const detail = await getAlbumTracks(source, albumId)
    return createSuccessResponse({ album: detail.album, list: detail.list })
  } catch (error) {
    if (error instanceof AuthError) {
      return createErrorResponse('UNAUTHORIZED', error.message, 401)
    }
    // 该源暂不支持专辑曲目：不算错误，客户端按 unsupported 分支提示
    if (error instanceof AlbumTracksUnsupportedError) {
      return createSuccessResponse({ album: null, list: [], unsupported: true })
    }
    logger.error('专辑详情失败:', error)
    return createErrorResponse(
      ErrorCodes.INTERNAL_ERROR,
      error instanceof Error ? error.message : '专辑详情获取失败',
      500
    )
  }
}

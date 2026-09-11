/**
 * 专辑搜索 API
 * GET /api/search/album?source=wy&keyword=xxx&page=1&limit=20
 * GET /api/search/album?source=all&keyword=xxx —— 三源汇聚（wy/kw/mg，按固定源顺序拼接）
 *
 * 需登录（requireUser），未登录返回 401。
 * 一期支持 wy / kw / mg（tx/kg 二期接入）。专辑卡片不入库，
 * 进入专辑详情（/api/album/tracks）时曲目才落库。
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { searchAlbums, isAlbumSource, ALBUM_SOURCES, type AlbumSource } from '@/lib/services/album-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request) // 未登录 → AuthError → 401

    const searchParams = request.nextUrl.searchParams
    const source = searchParams.get('source') as AlbumSource | 'all' | null
    const keyword = searchParams.get('keyword')
    const page = parseInt(searchParams.get('page') || '1')
    const limit = parseInt(searchParams.get('limit') || '20')

    // 参数验证
    if (!source) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '缺少必填参数: source', 400)
    }
    if (!keyword) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '缺少必填参数: keyword', 400)
    }
    if (source !== 'all' && !isAlbumSource(source)) {
      return createErrorResponse(
        ErrorCodes.SOURCE_NOT_SUPPORTED,
        `不支持的音源: ${source}，支持: all, ${ALBUM_SOURCES.join(', ')}`,
        400
      )
    }
    if (page < 1 || limit < 1 || limit > 50) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '参数错误: page >= 1, 1 <= limit <= 50', 400)
    }

    logger.info(`专辑搜索请求: ${source} - ${keyword} (page: ${page})`)
    const result = await searchAlbums(source, keyword, page, limit)
    return createSuccessResponse(result)
  } catch (error) {
    if (error instanceof AuthError) {
      return createErrorResponse('UNAUTHORIZED', error.message, 401)
    }
    logger.error('专辑搜索失败:', error)
    return createErrorResponse(
      ErrorCodes.INTERNAL_ERROR,
      error instanceof Error ? error.message : '专辑搜索失败',
      500
    )
  }
}

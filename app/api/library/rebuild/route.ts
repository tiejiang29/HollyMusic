import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireAdmin, AuthError, ForbiddenError } from '@/lib/services/user-context'
import { rebuildLibraryIndex } from '@/lib/services/music-library'

/**
 * 重建音乐库索引（仅管理员）。
 * POST /api/library/rebuild
 * 扫描 library/ 目录，为未登记的音频文件补登记行（uid 空、时长懒探测）。
 * 用途：DB 丢失或手动放入文件后的修复。
 */
export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request)
    const result = await rebuildLibraryIndex()
    return createSuccessResponse(result)
  } catch (error) {
    if (error instanceof AuthError) {
      return createErrorResponse('UNAUTHORIZED', error.message, 401)
    }
    if (error instanceof ForbiddenError) {
      return createErrorResponse('FORBIDDEN', error.message, 403)
    }
    logger.error('[api/library/rebuild POST] error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '重建索引失败', 500)
  }
}

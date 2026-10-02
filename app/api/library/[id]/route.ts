import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireAdmin, AuthError, ForbiddenError } from '@/lib/services/user-context'
import { deleteLibrarySong } from '@/lib/services/music-library'

/**
 * 删除音乐库条目（仅管理员；删除磁盘文件 + 登记行 + 清空目录）。
 *
 * 门槛必须不低于新增（`app/api/library` POST 是 requireAdmin）：音乐库是全体用户共享的，
 * `LibrarySong` 没有归属列，若只要求登录，任何一个家人都能把别人入库的文件从磁盘上删掉。
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request)
    const { id } = await params
    const songId = parseInt(id, 10)
    if (!Number.isFinite(songId)) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '无效的条目 id', 400)
    }
    const ok = await deleteLibrarySong(songId)
    if (!ok) return createErrorResponse('NOT_FOUND', '条目不存在', 404)
    return createSuccessResponse({ deleted: true })
  } catch (error) {
    if (error instanceof AuthError) {
      return createErrorResponse('UNAUTHORIZED', error.message, 401)
    }
    if (error instanceof ForbiddenError) {
      return createErrorResponse('FORBIDDEN', error.message, 403)
    }
    logger.error('[api/library/[id] DELETE] error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '删除失败', 500)
  }
}

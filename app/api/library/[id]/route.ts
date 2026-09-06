import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { deleteLibrarySong } from '@/lib/services/music-library'

/** 删除音乐库条目（登录用户；删除文件 + 登记行 + 清空目录） */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser(request)
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
    logger.error('[api/library/[id] DELETE] error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '删除失败', 500)
  }
}

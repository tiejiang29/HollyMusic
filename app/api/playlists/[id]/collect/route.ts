/**
 * 收藏歌单 API
 * POST /api/playlists/[id]/collect  复制一份到自己名下
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { collectPlaylist, PlaylistError } from '@/lib/services/playlist-service'
import { logger } from '@/lib/logger'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser(request)
    const { id } = await params
    const playlistId = parseInt(id, 10)
    if (isNaN(playlistId)) return createErrorResponse(ErrorCodes.INVALID_PARAMS, '无效的歌单 id', 400)
    const copy = await collectPlaylist(playlistId, user.username)
    logger.info(`[api/playlists/collect] 用户 ${user.username} 收藏歌单 ${playlistId} → 副本 ${copy.id}`)
    return createSuccessResponse(copy, 201)
  } catch (err) {
    if (err instanceof AuthError) return createErrorResponse('UNAUTHORIZED', err.message, 401)
    if (err instanceof PlaylistError) return createErrorResponse(ErrorCodes.INVALID_PARAMS, err.message, err.statusCode)
    logger.error('[api/playlists/collect] error:', err)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '收藏歌单失败', 500)
  }
}

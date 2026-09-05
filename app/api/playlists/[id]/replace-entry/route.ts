/**
 * 歌单条目换源 API
 * POST /api/playlists/[id]/replace-entry   { position: number, musicInfo: { source, songmid } }
 *
 * 原位替换歌单条目指向的歌曲（position 不变），用于手动换源。
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { replacePlaylistEntrySong, PlaylistError } from '@/lib/services/playlist-service'
import { logger } from '@/lib/logger'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser(request)
    const { id } = await params
    const playlistId = parseInt(id, 10)
    if (isNaN(playlistId)) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '无效的歌单 id', 400)
    }
    const body = await request.json().catch(() => ({}))
    const position = Number(body?.position)
    const musicInfo = body?.musicInfo
    if (!Number.isInteger(position) || position < 0) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '缺少有效 position', 400)
    }
    if (!musicInfo?.source || !musicInfo?.songmid) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '缺少 musicInfo.source / songmid', 400)
    }

    await replacePlaylistEntrySong(playlistId, user.username, position, {
      source: String(musicInfo.source),
      songmid: String(musicInfo.songmid),
    })
    return createSuccessResponse({ replaced: true })
  } catch (err) {
    if (err instanceof AuthError) return createErrorResponse('UNAUTHORIZED', err.message, 401)
    if (err instanceof PlaylistError) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, err.message, err.statusCode)
    }
    logger.error('[api/playlists/[id]/replace-entry POST] error:', err)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '换源失败', 500)
  }
}

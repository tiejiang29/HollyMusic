/**
 * 歌词 API
 * GET /api/lyrics?id={songId}
 *
 * 需登录（requireUser），未登录返回 401。
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import * as dbAPI from '@/lib/db'
import { fetchLyricForMusic } from '@/lib/services/lyrics'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request) // 未登录 → AuthError → 401

    const id = request.nextUrl.searchParams.get('id')
    if (!id) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '缺少必填参数: id', 400)
    }

    const musicInfo = await dbAPI.resolveMusicInfoById(id)
    if (!musicInfo) {
      return createSuccessResponse({ songId: id, lyric: null, tlyric: null, wordLyric: null, hasLyric: false })
    }

    const lyric = await fetchLyricForMusic(musicInfo)
    return createSuccessResponse({
      songId: id,
      lyric: lyric?.lyric ?? null,
      tlyric: lyric?.tlyric ?? null,
      // 逐字（增强 LRC）。为 null 时 lyric 仍是普通整行歌词，客户端按行渲染即可。
      wordLyric: lyric?.wordLyric ?? null,
      hasLyric: !!lyric?.lyric,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return createErrorResponse('UNAUTHORIZED', err.message, 401)
    }
    logger.error('[api/lyrics] error:', err)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '获取歌词失败', 500)
  }
}

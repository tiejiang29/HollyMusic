/**
 * 歌曲播放统计 API（猜你喜欢 v2 数据出口，只读、无界面）
 * GET /api/stats/song-plays?limit=&offset=
 *
 * 返回当前登录用户按歌（songIdentity）合并后的播放统计：同一首歌跨音源/
 * 同源多副本的播放次数合并为一条，totalPlays = Σ 各副本 playCount，
 * lastPlayedAt = 最近一次播放。数据来源是播放历史上报（POST /api/history
 * 或 Subsonic scrobble），没有上报就没有统计。
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getUserSongPlays } from '@/lib/services/play-stats'
import { logger } from '@/lib/logger'

function authGuard(err: unknown) {
  if (err instanceof AuthError) return createErrorResponse('UNAUTHORIZED', err.message, 401)
  return null
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request)
    const rawLimit = parseInt(request.nextUrl.searchParams.get('limit') || '200')
    const rawOffset = parseInt(request.nextUrl.searchParams.get('offset') || '0')
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 200, 1), 500)
    const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0)
    const stats = await getUserSongPlays(user.username)
    const totalPlays = stats.reduce((sum, s) => sum + s.totalPlays, 0)
    return createSuccessResponse({
      // totalSongs / totalPlays 始终是全量口径，list 才做分页切片
      totalSongs: stats.length,
      totalPlays,
      list: stats.slice(offset, offset + limit).map(s => ({
        uid: s.uid,
        name: s.mi.name ?? '',
        singer: s.mi.singer ?? '',
        albumName: s.mi.albumName ?? null,
        img: s.mi.img ?? null,
        totalPlays: s.totalPlays,
        lastPlayedAt: s.lastPlayedAt.toISOString(),
        copies: s.copies,
      })),
    })
  } catch (err) {
    const guard = authGuard(err)
    if (guard) return guard
    logger.error('[api/stats/song-plays GET] error:', err)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '获取播放统计失败', 500)
  }
}

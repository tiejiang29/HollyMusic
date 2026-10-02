/**
 * 播放历史 API
 * GET    /api/history?limit=&offset=   历史列表
 * POST   /api/history  body {musicInfo} 上报播放
 * DELETE /api/history                  清空历史
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { readIntParam } from '@/lib/server/params'
import { reportPlay, listHistory, clearHistory } from '@/lib/services/history-service'
import { updateLastSeenByUsername, getClientIp, getUa } from '@/lib/user'
import { logger } from '@/lib/logger'
import type { MusicInfo } from '@/lib/types/music'

function authGuard(err: unknown) {
  if (err instanceof AuthError) return createErrorResponse('UNAUTHORIZED', err.message, 401)
  return null
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request)
    // 历史上限是每用户 MAX_HISTORY_PER_USER（默认 500），limit 再大也没有意义，收敛掉
    const limit = readIntParam(request.nextUrl.searchParams.get('limit'), { def: 100, min: 1, max: 500 })
    const offset = readIntParam(request.nextUrl.searchParams.get('offset'), { def: 0, min: 0, max: 100000 })
    const data = await listHistory(user.username, { limit, offset })
    return createSuccessResponse(data)
  } catch (err) {
    const guard = authGuard(err)
    if (guard) return guard
    logger.error('[api/history GET] error:', err)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '获取历史失败', 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request)
    const body = await request.json().catch(() => ({}))
    const musicInfo = body?.musicInfo as MusicInfo | undefined
    if (!musicInfo || !musicInfo.source || !musicInfo.songmid) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '缺少 musicInfo', 400)
    }
    await reportPlay(user.username, musicInfo)
    // 手机端不发心跳，播放上报是它唯一的活跃信号，这里顺带记一次最近活跃。
    // updateLastSeenByUsername 内部已吞掉写库异常，不会把上报打成 500。
    await updateLastSeenByUsername(user.username, getClientIp(request), getUa(request))
    return createSuccessResponse({ reported: true })
  } catch (err) {
    const guard = authGuard(err)
    if (guard) return guard
    logger.error('[api/history POST] error:', err)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '上报历史失败', 500)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireUser(request)
    const data = await clearHistory(user.username)
    return createSuccessResponse(data)
  } catch (err) {
    const guard = authGuard(err)
    if (guard) return guard
    logger.error('[api/history DELETE] error:', err)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '清空历史失败', 500)
  }
}

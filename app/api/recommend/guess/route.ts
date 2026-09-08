/**
 * 猜我喜欢 API
 * GET /api/recommend/guess?size=&page=&includePlayed=
 *   基于用户画像（收藏/歌单/播放历史 + 时间衰减）的本地库推荐。
 *   画像为空时回退随机推荐（personalized=false）。
 *   同一用户同一天结果稳定，page 分页切片不重复（服务端每日缓存完整榜单）。
 *
 * GET /api/recommend       管理端推荐任务列表（见 ./route.ts）
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { guessYouLike } from '@/lib/services/guess-service'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request)
    const sp = request.nextUrl.searchParams
    const size = Number.parseInt(sp.get('size') || '30', 10)
    const page = Number.parseInt(sp.get('page') || '1', 10)
    const includePlayed = sp.get('includePlayed') === 'true'
    const data = await guessYouLike(user.username, user.id, { size, page, includePlayed })
    return createSuccessResponse(data)
  } catch (err) {
    if (err instanceof AuthError) {
      return createErrorResponse('UNAUTHORIZED', err.message, 401)
    }
    logger.error('[api/recommend/guess GET] error:', err)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '获取推荐失败', 500)
  }
}

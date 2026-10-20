import { NextRequest } from 'next/server'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { readIntParam } from '@/lib/server/params'
import {
  getRecommendedPlaylists,
  isDiscoverySource,
  PLAYLIST_CAPABILITIES,
  UnsupportedPlaylistFilterError,
  type DiscoveryPlaylistSort,
} from '@/lib/services/discovery-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request) // 未登录 → AuthError → 401

    const limit = readIntParam(request.nextUrl.searchParams.get('limit'), { def: 12, min: 1, max: 100 })
    const page = readIntParam(request.nextUrl.searchParams.get('page'), { def: 1, min: 1, max: 100 })
    const source = request.nextUrl.searchParams.get('source') || 'tx'
    if (!isDiscoverySource(source)) return createErrorResponse(ErrorCodes.INVALID_PARAMS, '不支持的渠道', 400)

    // 档位照服务端能力表来（客户端不必再各记一份）。已经装在用户手机上的旧包还会发"最新/最热"，
    // 这里对不支持的档位**降级成推荐**而不是报错 —— 让 UI 少一档靠 capabilities 收敛，
    // 而不是把一个能用的列表变成 400。
    const sortParam = (request.nextUrl.searchParams.get('sort') || 'recommend') as DiscoveryPlaylistSort
    const sorts: string[] = PLAYLIST_CAPABILITIES[source].sorts
    const sort: DiscoveryPlaylistSort = sorts.includes(sortParam) ? sortParam : 'recommend'
    if (sort !== sortParam) logger.debug(`[api/discover/playlists] ${source} 不支持档位 ${sortParam}，按 ${sort} 处理`)

    return createSuccessResponse(await getRecommendedPlaylists(
      source,
      Number.isFinite(limit) ? limit : 12,
      Number.isFinite(page) ? page : 1,
      {
        tag: request.nextUrl.searchParams.get('tag') || undefined,
        sort,
        keyword: request.nextUrl.searchParams.get('keyword') || undefined,
      },
    ))
  } catch (error) {
    if (error instanceof AuthError) {
      return createErrorResponse('UNAUTHORIZED', error.message, 401)
    }
    // 五个渠道的歌单口都没有关键词能力：明确拒绝，别再"搜了没反应"地返回同一批
    if (error instanceof UnsupportedPlaylistFilterError) {
      return createErrorResponse('UNSUPPORTED_FILTER', `歌单广场不支持按${error.field === 'keyword' ? '关键词' : '条件'}筛选，请改用标签（tag）`, 400)
    }
    logger.error('[api/discover/playlists] error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '获取推荐歌单失败', 500)
  }
}

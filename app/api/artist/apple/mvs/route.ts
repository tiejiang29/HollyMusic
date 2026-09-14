/**
 * 歌手 MV 列表 API（跨链通用增强）
 * GET /api/artist/apple/mvs?name=<歌手名> → { list: MusicVideo[] }
 *
 * 数据源：Apple amp-api（按名搜歌手 → artists 详情的 music-videos）。
 * 任何链（kw/mg/apple）的歌手页都可挂此视频区——MV 是 Apple 独有的展示增强，
 * 不参与三源编排的降级逻辑。每支 MV 带 30 秒预告（video-ssl.itunes.apple.com
 * 渐进 m4v，实测免鉴权，<video> 直播）；完整 MV 需订阅不涉及。缓存 24h。
 * 需登录；无结果返回空列表（客户端隐藏区块）。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getAmpArtistMvsByName } from '@/lib/services/apple-amp-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const name = request.nextUrl.searchParams.get('name') || ''
    if (!name.trim()) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '缺少必填参数: name', 400)
    }
    const list = await getAmpArtistMvsByName(name, 12)
    if (list.length > 0) {
      logger.debug(`歌手MV: ${name}（${list.length} 支）`)
    }
    return createSuccessResponse({ list })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    logger.error('歌手MV获取失败:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'MV获取失败', 500)
  }
}

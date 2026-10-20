import { NextRequest } from 'next/server'
import { createErrorResponse, createSuccessResponse } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { PLAYLIST_CAPABILITIES } from '@/lib/services/discovery-service'

/**
 * GET /api/discover/playlists/capabilities —— 各渠道歌单广场**真实支持的筛选档位**
 *
 * 为什么要服务端说：档位表在 Web 和安卓各硬编过一份，上游能力一变就漂；实测已经漂过两次
 * （tx 的"最新"其实不生效、mg 完全不读 sort）。客户端照这份决定显示哪些档、要不要给关键词入口。
 *
 * 这是个新口子，不动 `/api/discover/playlists` 的响应形状 —— 老客户端解析不受影响。
 */
export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    return createSuccessResponse(PLAYLIST_CAPABILITIES)
  } catch (error) {
    if (error instanceof AuthError) {
      return createErrorResponse('UNAUTHORIZED', error.message, 401)
    }
    return createErrorResponse('INTERNAL_ERROR', '获取歌单能力表失败', 500)
  }
}

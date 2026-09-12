/**
 * 本地专辑封面 API（服务端中转）
 * GET /api/album/local/cover?gid=<uuid> → 图片字节
 *
 * 封面解析：Apple 高清（歌手索引）→ tx 首曲目搜曲推导 gtimg；URL 缓存 24h。
 * 服务端抓取图床字节转发给前端（字节再缓存 24h + 浏览器 Cache-Control 24h）——
 * 前端不再直连图床，重复访问毫秒级。需登录；无封面 404（前端占位兜底）。
 */
import { NextRequest } from 'next/server'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getAlbumCover, fetchCoverImageBytes } from '@/lib/services/album-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const gid = request.nextUrl.searchParams.get('gid') || ''
    if (!/^[0-9a-f-]{36}$/i.test(gid)) {
      return new Response('invalid gid', { status: 400 })
    }
    const url = await getAlbumCover(gid)
    if (!url) return new Response('no cover', { status: 404 })
    const image = await fetchCoverImageBytes(url)
    if (!image) return new Response('cover fetch failed', { status: 404 })
    return new Response(image.bytes, {
      status: 200,
      headers: {
        'Content-Type': image.contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    if (error instanceof AuthError) {
      logger.warn('[api/album/local/cover] 未授权访问')
      return new Response('unauthorized', { status: 401 })
    }
    logger.error('[api/album/local/cover] error:', error)
    return new Response('internal error', { status: 500 })
  }
}

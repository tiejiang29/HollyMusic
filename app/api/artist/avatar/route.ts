/**
 * 歌手头像 API（维基百科，服务端代理转发）
 * GET /api/artist/avatar?name=<歌手名>
 *
 * upload.wikimedia.org 本网络不可直连，前端无法直接 <img>——服务端经
 * WIKI_PROXY_URL 代理取回缩略图字节转发给前端（缓存 24h + 浏览器 Cache-Control）。
 * 无维基头像（条目无图/未配置代理）返回 404，前端回退首专辑封面。
 * 需登录。
 */
import { NextRequest } from 'next/server'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getWikiPageData, fetchWikiImage } from '@/lib/services/wiki-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const name = (request.nextUrl.searchParams.get('name') || '').trim().slice(0, 100)
    if (!name) return new Response('missing name', { status: 400 })

    const page = await getWikiPageData(name, 'artist')
    if (!page?.thumbUrl) return new Response('no wiki avatar', { status: 404 })

    const image = await fetchWikiImage(page.thumbUrl)
    if (!image) return new Response('avatar fetch failed', { status: 404 })

    return new Response(image.bytes, {
      status: 200,
      headers: {
        'Content-Type': image.contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    if (error instanceof AuthError) {
      logger.warn('[api/artist/avatar] 未授权访问')
      return new Response('unauthorized', { status: 401 })
    }
    logger.error('[api/artist/avatar] error:', error)
    return new Response('internal error', { status: 500 })
  }
}

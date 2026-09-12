/**
 * Apple 专辑封面 API（服务端中转）
 * GET /api/album/apple/cover?collectionId=<apple collectionId> → 图片字节
 *
 * resolution：lookup collectionId（缓存 24h，与详情页共享）取 600x600 mzstatic 直链，
 * 服务端抓取字节转发（字节缓存 24h + 浏览器 Cache-Control 24h）。
 * 前端不再直连 mzstatic；需登录；无封面 404（前端占位兜底）。
 */
import { NextRequest } from 'next/server'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getItunesAlbumDetail } from '@/lib/services/itunes-service'
import { fetchCoverImageBytes } from '@/lib/services/album-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const collectionId = request.nextUrl.searchParams.get('collectionId') || ''
    if (!/^\d+$/.test(collectionId)) {
      return new Response('invalid collectionId', { status: 400 })
    }
    const detail = await getItunesAlbumDetail(collectionId)
    if (!detail?.album.img) return new Response('no cover', { status: 404 })
    const image = await fetchCoverImageBytes(detail.album.img)
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
      logger.warn('[api/album/apple/cover] 未授权访问')
      return new Response('unauthorized', { status: 401 })
    }
    logger.error('[api/album/apple/cover] error:', error)
    return new Response('internal error', { status: 500 })
  }
}

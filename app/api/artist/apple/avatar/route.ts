/**
 * Apple Music 官方歌手头像 API（服务端中转）
 * GET /api/artist/apple/avatar?artistId=<apple artistId> → 图片字节
 *
 * 抓国区 Apple Music 页面 og:image（Apple 专职艺人照片，AMCArtistImages），
 * 服务端取 600x600 字节转发。国区直连可达，无需代理；缓存 24h。
 * 需登录；无头像 404（前端回退维基头像 → 首专辑封面）。
 */
import { NextRequest } from 'next/server'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getAppleArtistAvatarUrl } from '@/lib/services/itunes-service'
import { fetchCoverImageBytes } from '@/lib/services/album-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const artistId = request.nextUrl.searchParams.get('artistId') || ''
    if (!/^\d+$/.test(artistId)) {
      return new Response('invalid artistId', { status: 400 })
    }
    const url = await getAppleArtistAvatarUrl(artistId)
    if (!url) return new Response('no avatar', { status: 404 })
    const image = await fetchCoverImageBytes(url)
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
      logger.warn('[api/artist/apple/avatar] 未授权访问')
      return new Response('unauthorized', { status: 401 })
    }
    logger.error('[api/artist/apple/avatar] error:', error)
    return new Response('internal error', { status: 500 })
  }
}

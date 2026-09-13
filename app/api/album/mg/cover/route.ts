/**
 * 咪咕专辑封面 API（服务端中转 + 跨源降级）
 * GET /api/album/mg/cover?albumid=<mg albumId>&name=<专辑名>&singer=<歌手名> → 图片字节
 *
 * 降级链：mg 专辑 imgItems（3 尺寸取最大）→ kw 按名解析（专辑/搜索 pic）→
 * Apple 按名搜索 → 404（前端占位兜底）。
 * 前端 mg 专辑封面两级加载：直链 img 失败/无图时才请求本端点。需登录；字节缓存 24h。
 */
import { NextRequest } from 'next/server'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getMgAlbumDetail } from '@/lib/services/mg-chain-service'
import { resolveKwAlbumCoverUrl } from '@/lib/services/kw-chain-service'
import { searchItunesAlbums } from '@/lib/services/itunes-service'
import { fetchCoverImageBytes } from '@/lib/services/album-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const albumId = request.nextUrl.searchParams.get('albumid') || ''
    const name = request.nextUrl.searchParams.get('name') || ''
    const singer = request.nextUrl.searchParams.get('singer') || ''
    if (!/^\d+$/.test(albumId) && !name.trim()) {
      return new Response('albumid 或 name 至少提供其一', { status: 400 })
    }

    // 咪咕段：专辑详情 imgItems
    let url: string | null = null
    if (/^\d+$/.test(albumId)) {
      const detail = await getMgAlbumDetail(albumId).catch(() => null)
      if (detail?.album.pic) url = detail.album.pic
    }

    // 酷我段：按名解析（专辑详情 pic → 搜索卡片 pic）
    if (!url && name.trim()) {
      url = await resolveKwAlbumCoverUrl(null, name, singer)
    }

    // Apple 段：按名+歌手搜专辑
    if (!url && name.trim()) {
      const keyword = singer.trim() ? `${name.trim()} ${singer.trim()}` : name.trim()
      const appleAlbums = await searchItunesAlbums(keyword, 10).catch(() => [])
      const singerNorm = singer.trim().toLowerCase()
      const hit = appleAlbums.find(a => !singerNorm
        || a.artist.toLowerCase().includes(singerNorm)
        || singerNorm.includes(a.artist.toLowerCase()))
      if (hit?.img) url = hit.img
    }

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
      logger.warn('[api/album/mg/cover] 未授权访问')
      return new Response('unauthorized', { status: 401 })
    }
    logger.error('[api/album/mg/cover] error:', error)
    return new Response('internal error', { status: 500 })
  }
}

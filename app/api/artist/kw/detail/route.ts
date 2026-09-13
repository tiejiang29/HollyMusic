/**
 * 酷我歌手详情 API
 * GET /api/artist/kw/detail?artistId=<kw artistid>&name=<歌手名>
 *
 * 三源架构一期：酷我全链。搜索卡片（/api/search?type=artist）带 kw artistid 进来，
 * 一次返回简介（酷我百科）+ 官方头像 + 热门歌（直接可播 kw-{rid}）+ 专辑全集（kw 卡片）。
 *
 * 降级：酷我链整体不可用时用「名字应急钥匙」回落 Apple 路径
 * （searchItunesArtists → getAppleArtistDetail，响应 source='apple'，
 *  前端按卡片自带 source 字段路由专辑与头像）。
 * 需登录。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getKwArtistDetail } from '@/lib/services/kw-chain-service'
import { searchItunesArtists } from '@/lib/services/itunes-service'
import { getAppleArtistDetail } from '@/lib/services/album-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const artistId = request.nextUrl.searchParams.get('artistId') || ''
    const name = request.nextUrl.searchParams.get('name') || ''
    if (!/^\d+$/.test(artistId)) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '无效的 artistId', 400)
    }

    // 酷我链
    const detail = await getKwArtistDetail(artistId)
    if (detail) {
      logger.info(`酷我歌手详情: ${detail.artist.name}（热门歌 ${detail.hotSongs.length}，专辑 ${detail.albums.length}${detail.artist.bio ? '，有简介' : ''}）`)
      return createSuccessResponse(detail)
    }

    // 降级：名字应急钥匙 → Apple 链
    if (name.trim()) {
      const appleArtists = await searchItunesArtists(name.trim(), 5).catch(() => [])
      const primary = appleArtists.find(a => a.name === name.trim()) ?? appleArtists[0]
      if (primary) {
        const appleDetail = await getAppleArtistDetail(primary.artistId)
        if (appleDetail) {
          logger.info(`酷我歌手详情降级 Apple: ${name} → artistId=${primary.artistId}`)
          return createSuccessResponse({ ...appleDetail, source: 'apple' })
        }
      }
    }

    return createSuccessResponse({ source: 'kw', artist: null, hotSongs: [], albums: [], unsupported: true })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    logger.error('酷我歌手详情获取失败:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '歌手详情获取失败', 500)
  }
}

/**
 * 咪咕歌手详情 API
 * GET /api/artist/mg/detail?artistId=<mg singerId>&name=<歌手名>
 *
 * 三源架构二期：咪咕链。咪咕卡片（/api/search?type=artist 咪咕命中时）进来，
 * 一次返回官方头像 + 热门歌（mg-{songId} 直接可播）+ 专辑全集 + 百科简介。
 *
 * 降级：咪咕链不可用时按「名字应急钥匙」回落酷我链（kw 为主链），再落 Apple；
 * 响应 source 标识实际链，前端按专辑卡片自带 source 路由。
 * 需登录。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getMgArtistDetail } from '@/lib/services/mg-chain-service'
import { getKwArtistDetail, searchKwArtists } from '@/lib/services/kw-chain-service'
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

    // 咪咕链
    const detail = await getMgArtistDetail(artistId, name || undefined)
    if (detail) {
      logger.info(`咪咕歌手详情: ${detail.artist.name}（热门歌 ${detail.hotSongs.length}，专辑 ${detail.albums.length}${detail.artist.bio ? '，有简介' : ''}）`)
      return createSuccessResponse(detail)
    }

    // 降级①：名字应急钥匙 → 酷我链（主链）
    if (name.trim()) {
      const kwArtists = await searchKwArtists(name.trim(), 5).catch(() => [])
      const kwHit = kwArtists.find(a => a.name === name.trim()) ?? kwArtists[0]
      if (kwHit) {
        const kwDetail = await getKwArtistDetail(kwHit.artistId)
        if (kwDetail) {
          logger.info(`咪咕歌手详情降级酷我: ${name} → artistid=${kwHit.artistId}`)
          return createSuccessResponse(kwDetail)
        }
      }
    }

    // 降级②：名字 → Apple 链
    if (name.trim()) {
      const appleArtists = await searchItunesArtists(name.trim(), 5).catch(() => [])
      const primary = appleArtists.find(a => a.name === name.trim()) ?? appleArtists[0]
      if (primary) {
        const appleDetail = await getAppleArtistDetail(primary.artistId)
        if (appleDetail) {
          logger.info(`咪咕歌手详情降级 Apple: ${name} → artistId=${primary.artistId}`)
          return createSuccessResponse({ ...appleDetail, source: 'apple' })
        }
      }
    }

    return createSuccessResponse({ source: 'mg', artist: null, hotSongs: [], albums: [], unsupported: true })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    logger.error('咪咕歌手详情获取失败:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '歌手详情获取失败', 500)
  }
}

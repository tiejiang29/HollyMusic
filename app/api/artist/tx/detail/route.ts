/**
 * QQ音乐歌手详情 API（TX 主链）
 * GET /api/artist/tx/detail?artistId=<singer_mid>&name=<歌手名>
 *
 * v3 TX 主链：smartbox 头像卡 + App 协议热门歌（singer mid 精确过滤，
 * tx-{songmid} 直接可播）+ 专辑聚合（T002 500px 封面公式）+ MV 列表。
 * 简介走维基（TX 模块层登录门，预研结论）。
 *
 * 降级：TX 不可用时名字应急钥匙回落 kw → mg → apple。
 * 需登录。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getTxArtistDetail, getTxArtistMvs } from '@/lib/services/tx-chain-service'
import { getKwArtistDetail, searchKwArtists } from '@/lib/services/kw-chain-service'
import { getMgArtistDetail, searchMgArtists } from '@/lib/services/mg-chain-service'
import { searchItunesArtists } from '@/lib/services/itunes-service'
import { getAppleArtistDetail } from '@/lib/services/album-service'
import { getWikiExtract } from '@/lib/services/wiki-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const artistId = request.nextUrl.searchParams.get('artistId') || ''
    const name = request.nextUrl.searchParams.get('name') || ''
    if (!/^[0-9A-Za-z]{8,20}$/.test(artistId)) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '无效的 artistId', 400)
    }

    // TX 主链
    const detail = await getTxArtistDetail(artistId, name || undefined)
    if (detail) {
      // 简介维基兜底 + MV 列表并行（仅主结果，避免同名歌手错配由前端 name 锚定）
      const [bio, mvs] = await Promise.all([
        name.trim() ? getWikiExtract(name.trim(), 'artist').catch(() => null) : Promise.resolve(null),
        getTxArtistMvs(artistId, 12).catch(() => []),
      ])
      logger.info(`TX歌手详情: ${detail.artist.name}（热门歌 ${detail.hotSongs.length}，专辑 ${detail.albums.length}，MV ${mvs.length}）`)
      return createSuccessResponse({ ...detail, artist: { ...detail.artist, bio }, mvs })
    }

    // 降级①：名字 → 酷我
    if (name.trim()) {
      const kwArtists = await searchKwArtists(name.trim(), 5).catch(() => [])
      const kwHit = kwArtists.find(a => a.name === name.trim()) ?? kwArtists[0]
      if (kwHit) {
        const kwDetail = await getKwArtistDetail(kwHit.artistId)
        if (kwDetail) {
          logger.info(`TX歌手详情降级酷我: ${name} → artistid=${kwHit.artistId}`)
          return createSuccessResponse(kwDetail)
        }
      }
    }
    // 降级②：名字 → 咪咕
    if (name.trim()) {
      const mgArtists = await searchMgArtists(name.trim(), 5).catch(() => [])
      const mgHit = mgArtists.find(a => a.name === name.trim()) ?? mgArtists[0]
      if (mgHit) {
        const mgDetail = await getMgArtistDetail(mgHit.artistId, name)
        if (mgDetail) {
          logger.info(`TX歌手详情降级咪咕: ${name} → singerId=${mgHit.artistId}`)
          return createSuccessResponse(mgDetail)
        }
      }
    }
    // 降级③：名字 → Apple
    if (name.trim()) {
      const appleArtists = await searchItunesArtists(name.trim(), 5).catch(() => [])
      const primary = appleArtists.find(a => a.name === name.trim()) ?? appleArtists[0]
      if (primary) {
        const appleDetail = await getAppleArtistDetail(primary.artistId)
        if (appleDetail) {
          logger.info(`TX歌手详情降级 Apple: ${name} → artistId=${primary.artistId}`)
          return createSuccessResponse({ ...appleDetail, source: 'apple' })
        }
      }
    }

    return createSuccessResponse({ source: 'tx', artist: null, hotSongs: [], albums: [], mvs: [], unsupported: true })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    logger.error('TX歌手详情获取失败:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '歌手详情获取失败', 500)
  }
}

/**
 * QQ音乐专辑曲目 API（TX 主链）
 * GET /api/album/tx/tracks?albumid=<albumMid>&name=<专辑名>&singer=<歌手名>
 *
 * GetAlbumSongList 按 albumMid 一次整张 → 批量入库 → tx-{songmid} 直接可播。
 * 封面 T002R500x500M000{albumMid}.jpg 公式直链。
 *
 * 降级：TX 不可用时名字应急钥匙回落 kw → mg → apple。需登录。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getTxAlbumDetailPlayable } from '@/lib/services/tx-chain-service'
import { getKwAlbumDetailPlayable, findKwAlbumId } from '@/lib/services/kw-chain-service'
import { getMgAlbumDetailPlayable, findMgAlbumId } from '@/lib/services/mg-chain-service'
import { searchItunesAlbums } from '@/lib/services/itunes-service'
import { getAppleAlbumDetail } from '@/lib/services/album-service'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const albumId = request.nextUrl.searchParams.get('albumid')
    || request.nextUrl.searchParams.get('albumId')
    || ''
    const name = request.nextUrl.searchParams.get('name') || ''
    const singer = request.nextUrl.searchParams.get('singer') || ''
    if (!/^[0-9A-Za-z]{8,20}$/.test(albumId)) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '无效的 albumid', 400)
    }

    // TX 主链
    const detail = await getTxAlbumDetailPlayable(albumId)
    if (detail && detail.list.length > 0) {
      logger.info(`TX专辑详情: ${detail.album.name}（${detail.list.length} 首直接可播）`)
      return createSuccessResponse({ source: 'tx', ...detail })
    }

    // 降级：名字应急钥匙 → kw → mg → apple
    if (name.trim()) {
      const kwAlbumId = await findKwAlbumId(name.trim(), singer).catch(() => null)
      if (kwAlbumId) {
        const kwDetail = await getKwAlbumDetailPlayable(kwAlbumId)
        if (kwDetail) {
          logger.info(`TX专辑详情降级酷我: ${name} → albumid=${kwAlbumId}`)
          return createSuccessResponse({ source: 'kw', ...kwDetail })
        }
      }
      const mgAlbumId = await findMgAlbumId(name.trim(), singer).catch(() => null)
      if (mgAlbumId) {
        const mgDetail = await getMgAlbumDetailPlayable(mgAlbumId)
        if (mgDetail) {
          logger.info(`TX专辑详情降级咪咕: ${name} → albumid=${mgAlbumId}`)
          return createSuccessResponse({ source: 'mg', ...mgDetail, album: { ...mgDetail.album, bio: mgDetail.album.summary ?? null } })
        }
      }
      const keyword = singer.trim() ? `${name.trim()} ${singer.trim()}` : name.trim()
      const appleAlbums = await searchItunesAlbums(keyword, 10).catch(() => [])
      const singerNorm = singer.trim().toLowerCase()
      const hit = appleAlbums.find(a => !singerNorm || a.artist.toLowerCase().includes(singerNorm)
        || singerNorm.includes(a.artist.toLowerCase()))
      if (hit) {
        const appleDetail = await getAppleAlbumDetail(hit.collectionId)
        if (appleDetail) {
          logger.info(`TX专辑详情降级 Apple: ${name} → collectionId=${hit.collectionId}`)
          return createSuccessResponse({ source: 'apple', ...appleDetail, album: { ...appleDetail.album, albumId: hit.collectionId } })
        }
      }
    }

    return createSuccessResponse({ source: 'tx', album: null, list: [], unsupported: true })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    logger.error('TX专辑详情失败:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '专辑详情获取失败', 500)
  }
}

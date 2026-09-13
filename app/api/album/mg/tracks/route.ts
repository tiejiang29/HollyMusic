/**
 * 咪咕专辑曲目 API
 * GET /api/album/mg/tracks?albumid=<mg albumId>&name=<专辑名>&singer=<歌手名>
 *
 * 三源架构二期：咪咕链。mg 专辑卡片详情：album/v2.0 + album/song/v2.0（pageSize=200
 * 一次整张）→ 批量入库 → mg-{songId} 直接可播；附带 summary 简介 + 唱片公司档案。
 *
 * 降级：咪咕不可用时按「名字应急钥匙」回落酷我（专辑名+歌手 → kw albumid），
 * 再落 Apple（searchItunesAlbums）。需登录。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getMgAlbumDetailPlayable, findMgAlbumId } from '@/lib/services/mg-chain-service'
import { getKwAlbumDetailPlayable, findKwAlbumId } from '@/lib/services/kw-chain-service'
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
    if (!/^\d+$/.test(albumId)) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '无效的 albumid', 400)
    }

    // 咪咕链
    const detail = await getMgAlbumDetailPlayable(albumId)
    if (detail) {
      logger.info(`咪咕专辑详情: ${detail.album.name}（${detail.list.length} 首直接可播）`)
      return createSuccessResponse({
        source: 'mg',
        ...detail,
        album: {
          ...detail.album,
          bio: detail.album.summary ?? null,
        },
      })
    }

    // 降级①：column id 假成功/卡片失效 → 按名重搜咪咕（mg 原生数字专辑多为 column 形态）
    if (name.trim()) {
      const mgId = await findMgAlbumId(name.trim(), singer).catch(() => null)
      if (mgId && mgId !== albumId) {
        const retry = await getMgAlbumDetailPlayable(mgId)
        if (retry) {
          logger.info(`咪咕专辑详情按名重搜: ${name} → albumid=${mgId}`)
          return createSuccessResponse({ source: 'mg', ...retry, album: { ...retry.album, bio: retry.album.summary ?? null } })
        }
      }
    }

    // 降级②：名字应急钥匙 → 酷我链
    if (name.trim()) {
      const kwAlbumId = await findKwAlbumId(name.trim(), singer).catch(() => null)
      if (kwAlbumId) {
        const kwDetail = await getKwAlbumDetailPlayable(kwAlbumId)
        if (kwDetail) {
          logger.info(`咪咕专辑详情降级酷我: ${name} → albumid=${kwAlbumId}`)
          return createSuccessResponse({ source: 'kw', ...kwDetail })
        }
      }
    }

    // 降级③：名字 → Apple 链
    if (name.trim()) {
      const keyword = singer.trim() ? `${name.trim()} ${singer.trim()}` : name.trim()
      const appleAlbums = await searchItunesAlbums(keyword, 10).catch(() => [])
      const singerNorm = singer.trim().toLowerCase()
      const hit = appleAlbums.find(a => !singerNorm || a.artist.toLowerCase().includes(singerNorm)
        || singerNorm.includes(a.artist.toLowerCase()))
      if (hit) {
        const appleDetail = await getAppleAlbumDetail(hit.collectionId)
        if (appleDetail) {
          logger.info(`咪咕专辑详情降级 Apple: ${name} → collectionId=${hit.collectionId}`)
          return createSuccessResponse({ source: 'apple', ...appleDetail, album: { ...appleDetail.album, albumId: hit.collectionId } })
        }
      }
    }

    return createSuccessResponse({ source: 'mg', album: null, list: [], unsupported: true })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    logger.error('咪咕专辑详情失败:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '专辑详情获取失败', 500)
  }
}

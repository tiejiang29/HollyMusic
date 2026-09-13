/**
 * 酷我专辑曲目 API
 * GET /api/album/kw/tracks?albumid=<kw albumid>&name=<专辑名>&singer=<歌手名>
 *
 * 三源架构一期：酷我全链。kw 专辑卡片（搜索 platformList / 歌手详情专辑网格）详情：
 * r.s albuminfo 一次拿整张专辑曲目（全带 rid）→ 批量入库 → 直接可播。
 *
 * 降级：酷我链不可用时用「名字应急钥匙」回落 Apple（searchItunesAlbums →
 * getAppleAlbumDetail，响应 source='apple'，前端按 source 选封面渲染方式）。
 * 需登录。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getKwAlbumDetailPlayable } from '@/lib/services/kw-chain-service'
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

    // 酷我链
    const detail = await getKwAlbumDetailPlayable(albumId)
    if (detail) {
      logger.info(`酷我专辑详情: ${detail.album.name}（${detail.list.length} 首直接可播）`)
      return createSuccessResponse({ source: 'kw', ...detail })
    }

    // 降级：名字应急钥匙 → Apple 链（专辑名+歌手名搜索，首张歌手匹配的专辑）
    if (name.trim()) {
      const keyword = singer.trim() ? `${name.trim()} ${singer.trim()}` : name.trim()
      const appleAlbums = await searchItunesAlbums(keyword, 10).catch(() => [])
      const singerNorm = singer.trim().toLowerCase()
      const hit = appleAlbums.find(a => !singerNorm || a.artist.toLowerCase().includes(singerNorm)
        || singerNorm.includes(a.artist.toLowerCase()))
      if (hit) {
        const appleDetail = await getAppleAlbumDetail(hit.collectionId)
        if (appleDetail) {
          logger.info(`酷我专辑详情降级 Apple: ${name} → collectionId=${hit.collectionId}`)
          return createSuccessResponse({ source: 'apple', ...appleDetail, album: { ...appleDetail.album, albumId: hit.collectionId } })
        }
      }
    }

    return createSuccessResponse({ source: 'kw', album: null, list: [], unsupported: true })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    logger.error('酷我专辑详情失败:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '专辑详情获取失败', 500)
  }
}

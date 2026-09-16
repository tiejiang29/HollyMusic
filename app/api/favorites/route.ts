/**
 * 收藏 API
 * GET    /api/favorites?type=song|album&limit=&offset=   收藏列表（type 缺省 song，旧客户端零改动）
 * POST   /api/favorites  body {id, type?, source?, name?, singer?, img?}  收藏
 * DELETE /api/favorites?id=&type=&source=               取消收藏
 *
 * 专辑收藏（type=album）与歌曲收藏共用同一张 Favorite 表：id 是平台专辑 id
 * （tx/kw/mg 的 albumId、Apple 的 collectionId），source 是平台名，另带一份展示快照
 * （name/singer/img）—— 专辑不在本站曲库里，列表时无法像歌曲那样靠 id 回查富化。
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import {
  listFavoriteSongs,
  starSong,
  unstarSong,
  listFavoriteAlbums,
  starAlbum,
  unstarAlbum,
} from '@/lib/services/favorites-service'
import { logger } from '@/lib/logger'

function authGuard(err: unknown) {
  if (err instanceof AuthError) return createErrorResponse('UNAUTHORIZED', err.message, 401)
  return null
}

/** 收藏类型：只认 'album'，其余（含缺省）一律当歌曲，保证旧客户端行为不变 */
function readType(value: string | null | undefined): 'song' | 'album' {
  return value === 'album' ? 'album' : 'song'
}

/** 取字符串参数，空串视同未传 */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request)
    const params = request.nextUrl.searchParams
    const type = readType(params.get('type'))
    const limit = parseInt(params.get('limit') || '200')
    const offset = parseInt(params.get('offset') || '0')
    const data = type === 'album'
      ? await listFavoriteAlbums(user.id, { limit, offset })
      : await listFavoriteSongs(user.id, { limit, offset })
    return createSuccessResponse(data)
  } catch (err) {
    const guard = authGuard(err)
    if (guard) return guard
    logger.error('[api/favorites GET] error:', err)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '获取收藏失败', 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request)
    const body = await request.json().catch(() => ({}))
    const id = body?.id
    if (!id) return createErrorResponse(ErrorCodes.INVALID_PARAMS, '缺少必填参数: id', 400)

    if (readType(str(body?.type)) === 'album') {
      const data = await starAlbum(user.id, {
        albumId: String(id),
        source: str(body?.source),
        name: str(body?.name),
        singer: str(body?.singer),
        img: str(body?.img),
      })
      return createSuccessResponse(data)
    }

    const data = await starSong(user.id, String(id))
    return createSuccessResponse(data)
  } catch (err) {
    const guard = authGuard(err)
    if (guard) return guard
    logger.error('[api/favorites POST] error:', err)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '收藏失败', 500)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireUser(request)
    const params = request.nextUrl.searchParams
    const id = params.get('id')
    if (!id) return createErrorResponse(ErrorCodes.INVALID_PARAMS, '缺少必填参数: id', 400)
    const data = readType(params.get('type')) === 'album'
      ? await unstarAlbum(user.id, id, params.get('source'))
      : await unstarSong(user.id, id)
    return createSuccessResponse(data)
  } catch (err) {
    const guard = authGuard(err)
    if (guard) return guard
    logger.error('[api/favorites DELETE] error:', err)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '取消收藏失败', 500)
  }
}

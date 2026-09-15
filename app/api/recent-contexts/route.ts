/**
 * 最近播放的歌单/专辑 API
 * POST  /api/recent-contexts {itemType, itemId, name, img?, owner?}  记录播放上下文
 * GET   /api/recent-contexts?type=playlist|album|all&limit=10        查最近记录（歌单/专辑分开）
 *
 * itemType: 'playlist'（自建+收藏歌单）| 'album'
 * 同一用户同一歌单/专辑只保留最新时间戳（upsert）。
 * 需登录。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { prisma } from '@/lib/db'

const VALID_TYPES = ['playlist', 'album']
const MAX_LIMIT = 30

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request)
    const type = request.nextUrl.searchParams.get('type') || 'all'
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '10') || 10, MAX_LIMIT)

    const where = type === 'all'
      ? { username: user.username }
      : { username: user.username, itemType: type }

    const list = await prisma.recentContext.findMany({
      where,
      orderBy: { playedAt: 'desc' },
      take: limit,
    })

    return createSuccessResponse({
      list: list.map(r => ({
        itemType: r.itemType,
        itemId: r.itemId,
        name: r.name,
        img: r.img,
        owner: r.owner,
        playedAt: r.playedAt.toISOString(),
      })),
    })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    logger.error('[api/recent-contexts GET] error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '获取最近播放失败', 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request)
    const body = await request.json().catch(() => ({}))
    const itemType = typeof body?.itemType === 'string' ? body.itemType : ''
    const itemId = typeof body?.itemId === 'string' ? body.itemId.trim() : ''
    const name = typeof body?.name === 'string' ? body.name.trim() : ''

    if (!VALID_TYPES.includes(itemType)) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, `itemType 必须为 ${VALID_TYPES.join('|')}`, 400)
    }
    if (!itemId || !name) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '缺少必填参数: itemId, name', 400)
    }

    await prisma.recentContext.upsert({
      where: {
        username_itemType_itemId: {
          username: user.username,
          itemType,
          itemId,
        },
      },
      update: {
        name,
        img: typeof body?.img === 'string' ? body.img : null,
        owner: typeof body?.owner === 'string' ? body.owner : null,
        playedAt: new Date(),
      },
      create: {
        username: user.username,
        itemType,
        itemId,
        name,
        img: typeof body?.img === 'string' ? body.img : null,
        owner: typeof body?.owner === 'string' ? body.owner : null,
      },
    })

    return createSuccessResponse({ recorded: true })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    logger.error('[api/recent-contexts POST] error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '记录最近播放失败', 500)
  }
}

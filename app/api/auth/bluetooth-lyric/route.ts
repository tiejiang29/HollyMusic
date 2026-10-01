/**
 * 蓝牙歌词开关 API
 * PUT /api/auth/bluetooth-lyric  body {enabled: boolean}
 *
 * 账号级偏好：开启后服务端把当前歌词行覆写进媒体 session 的 title，供车机/蓝牙设备显示
 * （代价是手机通知栏/锁屏第一行也变成歌词）。默认 true = 历史行为，家人零配置。
 * 只影响 title 覆写那一条通路，extras 里的 LYRICS/lyricInfo 始终照常发布。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { logger } from '@/lib/logger'
import { prisma } from '@/lib/db'

export async function PUT(request: NextRequest) {
  try {
    const user = await requireUser(request)
    const body = await request.json().catch(() => ({}))
    const enabled = body?.enabled
    if (typeof enabled !== 'boolean') {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, 'enabled 必须为布尔值', 400)
    }
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { bluetoothLyric: enabled },
      select: { bluetoothLyric: true },
    })
    // 回显服务端实际值，客户端据此校正 UI
    return createSuccessResponse({ enabled: updated.bluetoothLyric })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    logger.error('[api/auth/bluetooth-lyric PUT] error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '蓝牙歌词设置失败', 500)
  }
}

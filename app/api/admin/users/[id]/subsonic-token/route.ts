/**
 * Subsonic 令牌发放 API（仅管理员）
 * POST /api/admin/users/[id]/subsonic-token
 *
 * 轮换并返回该用户的 Subsonic 令牌（User.subsonicSecret），用于外部 Subsonic
 * 客户端的 t=md5(token+s) 校验。令牌只在本次响应里返回一次，之后库内不可读；
 * 轮换后旧令牌立即失效。
 *
 * 说明：密码改存 scrypt 哈希后（SEC-1），Subsonic 凭据与登录密码解耦，
 * 这里是获取它的唯一入口。
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse } from '@/lib/api-response'
import { requireAdmin, AuthError, ForbiddenError } from '@/lib/services/user-context'
import { issueSubsonicToken, NotFoundError } from '@/lib/services/user-service'
import { logger } from '@/lib/logger'

function parseId(idStr: string | undefined): number | null {
  const id = Number(idStr)
  return Number.isInteger(id) && id > 0 ? id : null
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const me = await requireAdmin(request)
    const { id: idStr } = await props.params
    const id = parseId(idStr)
    if (id == null) return createErrorResponse('INVALID_PARAMS', '无效的用户 id', 400)

    const subsonicToken = await issueSubsonicToken(id)
    logger.info(`[api/admin/users/[id]/subsonic-token] 已由 ${me.username} 轮换用户 id=${id} 的 Subsonic 令牌`)
    return createSuccessResponse({
      subsonicToken,
      hint: 'Subsonic 客户端填：用户名 + 本令牌作为密码（服务端按 t=md5(令牌+s) 校验），请立即保存，此值仅显示一次',
    })
  } catch (err) {
    if (err instanceof AuthError) return createErrorResponse('UNAUTHORIZED', err.message, 401)
    if (err instanceof ForbiddenError) return createErrorResponse('FORBIDDEN', err.message, 403)
    if (err instanceof NotFoundError) return createErrorResponse('NOT_FOUND', err.message, 404)
    logger.error('[api/admin/users/[id]/subsonic-token POST] error:', err)
    return createErrorResponse('INTERNAL_ERROR', '发放 Subsonic 令牌失败', 500)
  }
}

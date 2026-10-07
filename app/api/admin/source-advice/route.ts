/**
 * GET  /api/admin/source-advice            当前建议（纯读：配置 + 最近四批周测）
 * POST /api/admin/source-advice  { action:'apply', ids }   固化勾选的那几条（写前拍配置快照）
 * POST /api/admin/source-advice  { action:'undo' }         还原上次固化
 *
 * 全部 `requireAdmin`。**没有任何定时器会自己调用 apply** —— 按设计，改生产配置必须是
 * 管理员在面板上的一次点击（见 `lib/services/source-advice.ts` 顶部那段）。
 * `ids` 之外的值一概不信：固化时服务端重算一遍建议，只挑这些 id 对应的那几份补丁。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse } from '@/lib/api-response'
import { requireAdmin, AuthError, ForbiddenError } from '@/lib/services/user-context'
import { SourceSubscriptionError } from '@/lib/services/source-manager-service'
import { applyAdvice, buildAdvice, undoAdvice } from '@/lib/services/source-advice'
import { logger } from '@/lib/logger'

function guard(err: unknown) {
  if (err instanceof AuthError) return createErrorResponse('UNAUTHORIZED', err.message, 401)
  if (err instanceof ForbiddenError) return createErrorResponse('FORBIDDEN', err.message, 403)
  if (err instanceof SourceSubscriptionError) return createErrorResponse('INVALID_PARAMS', err.message, err.status)
  return null
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request)
    return createSuccessResponse(await buildAdvice())
  } catch (err) {
    const g = guard(err)
    if (g) return g
    logger.error('[api/admin/source-advice GET] error:', err)
    return createErrorResponse('INTERNAL_ERROR', '读取周测建议失败', 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request)
    const body = await request.json().catch(() => ({}))
    const action = typeof body?.action === 'string' ? body.action : ''

    if (action === 'apply') {
      const ids = Array.isArray(body?.ids) ? body.ids.filter((id: unknown): id is string => typeof id === 'string') : []
      if (!ids.length) return createErrorResponse('INVALID_PARAMS', '没有勾选要固化的建议', 400)
      return createSuccessResponse(await applyAdvice(ids))
    }

    if (action === 'undo') return createSuccessResponse(await undoAdvice())

    return createErrorResponse('INVALID_PARAMS', `未知操作：${action || '(空)'}`, 400)
  } catch (err) {
    const g = guard(err)
    if (g) return g
    logger.error('[api/admin/source-advice POST] error:', err)
    return createErrorResponse('INTERNAL_ERROR', '处理周测建议失败', 500)
  }
}

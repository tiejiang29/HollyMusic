import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse } from '@/lib/api-response'
import { requireAdmin, AuthError, ForbiddenError } from '@/lib/services/user-context'
import { logger } from '@/lib/logger'
import {
  CompositeSourceError,
  getCompositeView,
  saveCompositeSettings,
} from '@/lib/services/composite-source'

function guard(error: unknown) {
  if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
  if (error instanceof ForbiddenError) return createErrorResponse('FORBIDDEN', error.message, 403)
  if (error instanceof CompositeSourceError) return createErrorResponse('INVALID_PARAMS', error.message, error.status)
  return null
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request)
    return createSuccessResponse(await getCompositeView())
  } catch (error) {
    const response = guard(error)
    if (response) return response
    logger.error('[api/admin/composite-source GET] error:', error)
    return createErrorResponse('INTERNAL_ERROR', '读取复合源配置失败', 500)
  }
}

export async function PUT(request: NextRequest) {
  try {
    await requireAdmin(request)
    const body = await request.json().catch(() => ({}))
    const settings = await saveCompositeSettings({
      enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
      members: Array.isArray(body?.members) ? body.members : undefined,
      crossPlatformMode: body?.crossPlatformMode === 'parallel' || body?.crossPlatformMode === 'fallback'
        ? body.crossPlatformMode
        : undefined,
      width: body?.width,
      holdMs: body?.holdMs,
      resolveMs: body?.resolveMs,
      headerMs: body?.headerMs,
      chainMs: body?.chainMs,
    })
    return createSuccessResponse(await getCompositeView(settings))
  } catch (error) {
    const response = guard(error)
    if (response) return response
    logger.error('[api/admin/composite-source PUT] error:', error)
    return createErrorResponse('INTERNAL_ERROR', '保存复合源配置失败', 500)
  }
}

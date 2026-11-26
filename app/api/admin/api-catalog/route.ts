import { NextRequest } from 'next/server'
import { createErrorResponse, createSuccessResponse } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { AuthError, ForbiddenError, requireAdmin } from '@/lib/services/user-context'
import { getApiCatalog, setApiInterfaceSelection } from '@/lib/services/api-catalog'

function guard(error: unknown) {
  if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
  if (error instanceof ForbiddenError) return createErrorResponse('FORBIDDEN', error.message, 403)
  return null
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request)
    return createSuccessResponse(await getApiCatalog())
  } catch (error) {
    const response = guard(error)
    if (response) return response
    logger.error('[api/admin/api-catalog GET] error:', error)
    return createErrorResponse('INTERNAL_ERROR', '读取接口目录失败', 500)
  }
}

export async function PUT(request: NextRequest) {
  try {
    await requireAdmin(request)
    const body = await request.json().catch(() => null)
    const updates = body?.updates
    if (!Array.isArray(updates) || updates.length === 0 || updates.length > 500) {
      return createErrorResponse('INVALID_PARAMS', '请提供 1～500 条接口启停修改', 400)
    }
    const normalized = updates.map((item: unknown) => {
      if (!item || typeof item !== 'object') return null
      const { id, enabled } = item as { id?: unknown; enabled?: unknown }
      if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id) || typeof enabled !== 'boolean') return null
      return { id, enabled }
    })
    if (normalized.some(item => item === null)) {
      return createErrorResponse('INVALID_PARAMS', '接口 ID 或启用状态不合法', 400)
    }
    const valid = normalized as Array<{ id: string; enabled: boolean }>
    const updated = await setApiInterfaceSelection(valid)
    return createSuccessResponse({ ...(await getApiCatalog()), updated })
  } catch (error) {
    const response = guard(error)
    if (response) return response
    logger.error('[api/admin/api-catalog PUT] error:', error)
    return createErrorResponse('INTERNAL_ERROR', '保存接口启停失败', 500)
  }
}

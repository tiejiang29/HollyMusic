/**
 * 用户头像 API
 * PUT /api/auth/avatar  body {avatar: 1~10}  设置内置头像索引
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { prisma } from '@/lib/db'

export async function PUT(request: NextRequest) {
  try {
    const user = await requireUser(request)
    const body = await request.json().catch(() => ({}))
    const avatar = body?.avatar
    if (avatar != null && (typeof avatar !== 'number' || !Number.isInteger(avatar) || avatar < 1 || avatar > 10)) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, 'avatar 必须为 1~10 的整数', 400)
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { avatar: avatar ?? null },
    })
    return createSuccessResponse({ avatar: avatar ?? null })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '头像设置失败', 500)
  }
}

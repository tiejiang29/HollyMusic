import { NextRequest } from 'next/server'
import { createErrorResponse, createSuccessResponse } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { AuthError, ForbiddenError, requireAdmin } from '@/lib/services/user-context'
import { ApiInterfaceProbeError, probeApiInterface } from '@/lib/services/api-interface-probe'
import { pickProbeSamples } from '@/lib/services/source-probe'
import type { MusicInfo, QualityType } from '@/lib/types/music'

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request)
    return createSuccessResponse({ samples: await pickProbeSamples(2) })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    if (error instanceof ForbiddenError) return createErrorResponse('FORBIDDEN', error.message, 403)
    logger.error('[api/admin/api-catalog/probe GET] error:', error)
    return createErrorResponse('INTERNAL_ERROR', '读取单测样本失败', 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request)
    const body = await request.json().catch(() => null)
    const interfaceId = typeof body?.interfaceId === 'string' ? body.interfaceId : ''
    const source = typeof body?.source === 'string' ? body.source.trim().slice(0, 200) : ''
    const quality = body?.quality || '320k'
    if (!/^[a-f0-9]{24}$/.test(interfaceId) || !source) {
      return createErrorResponse('INVALID_PARAMS', '接口 ID 与来源音源不能为空', 400)
    }
    if (!['128k', '320k', 'flac', 'flac24bit'].includes(quality)) {
      return createErrorResponse('INVALID_PARAMS', '音质不合法', 400)
    }
    let musicInfo: MusicInfo | undefined
    if (body?.musicInfo !== undefined) {
      if (!body.musicInfo || typeof body.musicInfo !== 'object' || typeof body.musicInfo.source !== 'string' || body.musicInfo.songmid == null) {
        return createErrorResponse('INVALID_PARAMS', '样本格式不合法', 400)
      }
      musicInfo = body.musicInfo as MusicInfo
    }
    return createSuccessResponse(await probeApiInterface({
      interfaceId,
      source,
      quality: quality as QualityType,
      musicInfo,
    }))
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    if (error instanceof ForbiddenError) return createErrorResponse('FORBIDDEN', error.message, 403)
    if (error instanceof ApiInterfaceProbeError) return createErrorResponse(error.status === 409 ? 'PROBE_RUNNING' : 'INVALID_PARAMS', error.message, error.status)
    logger.error('[api/admin/api-catalog/probe POST] error:', error)
    return createErrorResponse('INTERNAL_ERROR', '单接口测试失败', 500)
  }
}

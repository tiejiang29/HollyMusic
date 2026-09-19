/**
 * 音源周测（主动全矩阵探测）触发与状态查询（仅管理员）
 * POST /api/admin/sources/probe  立即跑一批（异步：立刻返回 202，面板轮询 GET）
 * GET  /api/admin/sources/probe  最近一批的状态
 *
 * 为什么不同步等：一批是「启用源 × pt × 每平台 2 首基准曲」的串行探测（实测 62 格），
 * 最坏要几分钟，同步返回会被中间层的请求超时掐断，还会让面板按钮转圈到怀疑人生。
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse } from '@/lib/api-response'
import { requireAdmin, AuthError, ForbiddenError } from '@/lib/services/user-context'
import { isProbeRunning, probeEnabled, probeStatus, runSourceProbe } from '@/lib/services/source-probe'
import { logger } from '@/lib/logger'

function guard(err: unknown) {
  if (err instanceof AuthError) return createErrorResponse('UNAUTHORIZED', err.message, 401)
  if (err instanceof ForbiddenError) return createErrorResponse('FORBIDDEN', err.message, 403)
  return null
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request)
    if (!probeEnabled()) {
      return createSuccessResponse({ running: false, last: null, disabled: true })
    }
    return createSuccessResponse(await probeStatus())
  } catch (err) {
    const g = guard(err)
    if (g) return g
    logger.error('[api/admin/sources/probe GET] error:', err)
    return createErrorResponse('INTERNAL_ERROR', '获取周测状态失败', 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request)
    if (!probeEnabled()) {
      return createErrorResponse('CONFLICT', '周测已被 SOURCE_PROBE_ENABLED=0 关闭', 409)
    }
    if (isProbeRunning()) {
      return createErrorResponse('CONFLICT', '已有一批周测在跑，等它结束', 409)
    }
    // 后台跑：单飞守卫在服务层，这里重复调用也不会起两批
    void runSourceProbe('manual').catch(err => logger.warn('[source-probe] 手动周测失败:', err))
    return createSuccessResponse({ started: true }, 202)
  } catch (err) {
    const g = guard(err)
    if (g) return g
    logger.error('[api/admin/sources/probe POST] error:', err)
    return createErrorResponse('INTERNAL_ERROR', '启动周测失败', 500)
  }
}

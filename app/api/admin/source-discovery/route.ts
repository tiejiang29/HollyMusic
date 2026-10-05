/**
 * 音源发现 API（仅管理员）
 *
 * GET  /api/admin/source-discovery  配置视图（token 只回脱敏尾巴）+ 候选列表 + 本轮进度
 * POST /api/admin/source-discovery  { action: 'crawl' } 起一轮发现；{ action:'dismiss', id } 剔除一条
 * PUT  /api/admin/source-discovery  改配置：{ enabled, repos, maxCandidatesPerRepo, maxDownloadsPerRound, githubToken?, clearToken? }
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse } from '@/lib/api-response'
import { requireAdmin, AuthError, ForbiddenError } from '@/lib/services/user-context'
import { maskSecret } from '@/lib/services/app-setting'
import {
  SourceDiscoveryError,
  clearDiscoveryToken,
  countCandidates,
  discoveryStatus,
  dismissCandidate,
  getDiscoverySettings,
  listCandidates,
  runDiscoveryCrawl,
  saveDiscoverySettings,
  type DiscoverySettings,
} from '@/lib/services/source-discovery'
import { logger } from '@/lib/logger'

function guard(err: unknown) {
  if (err instanceof AuthError) return createErrorResponse('UNAUTHORIZED', err.message, 401)
  if (err instanceof ForbiddenError) return createErrorResponse('FORBIDDEN', err.message, 403)
  if (err instanceof SourceDiscoveryError) return createErrorResponse('INVALID_PARAMS', err.message, err.status)
  return null
}

/** 出网前把 token 换掉：面板只需要知道"配没配、是哪一枚" */
function toSettingsView(settings: DiscoverySettings) {
  return {
    enabled: settings.enabled,
    repos: settings.repos,
    maxCandidatesPerRepo: settings.maxCandidatesPerRepo,
    maxDownloadsPerRound: settings.maxDownloadsPerRound,
    hasToken: Boolean(settings.githubToken),
    tokenTail: settings.githubToken ? maskSecret(settings.githubToken) : '',
  }
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request)
    const params = request.nextUrl.searchParams
    const [settings, candidates, counts] = await Promise.all([
      getDiscoverySettings(),
      listCandidates({
        verdict: params.get('verdict') || undefined,
        state: params.get('state') || undefined,
        take: Number(params.get('take')) || undefined,
      }),
      countCandidates(),
    ])
    return createSuccessResponse({
      settings: toSettingsView(settings),
      status: discoveryStatus(),
      counts,
      candidates,
    })
  } catch (err) {
    const g = guard(err)
    if (g) return g
    logger.error('[api/admin/source-discovery GET] error:', err)
    return createErrorResponse('INTERNAL_ERROR', '读取音源发现状态失败', 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request)
    const body = await request.json().catch(() => ({}))
    const action = typeof body?.action === 'string' ? body.action : ''

    if (action === 'dismiss') {
      const id = Number(body?.id)
      if (!Number.isFinite(id) || id <= 0) return createErrorResponse('INVALID_PARAMS', '缺少合法的候选 id', 400)
      await dismissCandidate(id)
      return createSuccessResponse({ dismissed: id })
    }

    if (action === 'crawl') {
      if (discoveryStatus().running) return createSuccessResponse({ started: false, reason: '已有一轮在跑' })
      // 异步跑：一轮要几分钟，不能让请求挂着；进度靠 GET 轮询
      void runDiscoveryCrawl().catch(err => {
        logger.warn('[discovery] 本轮失败:', err instanceof Error ? err.message : err)
      })
      return createSuccessResponse({ started: true }, 202)
    }

    return createErrorResponse('INVALID_PARAMS', `不支持的动作: ${action || '(空)'}`, 400)
  } catch (err) {
    const g = guard(err)
    if (g) return g
    logger.error('[api/admin/source-discovery POST] error:', err)
    return createErrorResponse('INTERNAL_ERROR', '音源发现操作失败', 500)
  }
}

export async function PUT(request: NextRequest) {
  try {
    await requireAdmin(request)
    const body = await request.json().catch(() => ({}))

    const patch: Partial<DiscoverySettings> = {}
    if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled
    if (Array.isArray(body?.repos)) patch.repos = body.repos
    if (typeof body?.maxCandidatesPerRepo === 'number') patch.maxCandidatesPerRepo = body.maxCandidatesPerRepo
    if (typeof body?.maxDownloadsPerRound === 'number') patch.maxDownloadsPerRound = body.maxDownloadsPerRound
    if (typeof body?.githubToken === 'string') patch.githubToken = body.githubToken

    const saved = await saveDiscoverySettings(patch)
    const settings = body?.clearToken === true ? await clearDiscoveryToken() : saved.settings

    return createSuccessResponse({ settings: toSettingsView(settings), rejected: saved.rejected })
  } catch (err) {
    const g = guard(err)
    if (g) return g
    logger.error('[api/admin/source-discovery PUT] error:', err)
    return createErrorResponse('INTERNAL_ERROR', '保存音源发现配置失败', 500)
  }
}

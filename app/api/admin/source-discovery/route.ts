/**
 * 音源发现 API（仅管理员）
 *
 * GET  /api/admin/source-discovery  配置视图（token 只回脱敏尾巴）+ 候选列表 + 本轮进度
 * POST /api/admin/source-discovery  { action: 'crawl', repos? } 起一轮发现（repos 给了就只扫这些仓）；
 *                                   { action:'drain' } 连轮清完待判定；
 *                                   { action:'search', query, page?, sort? } 按关键词搜 GitHub 仓库（只返回元数据，不入清单）；
 *                                   { action:'freshness', maxAgeDays? } 体检扫描清单里的仓多久没动（只读，剔不剔由 PUT 决定）；
 *                                   { action:'probe', id } 起一次判级；{ action:'probe-batch' } 批量判级（一批≤50）；
 *                                   { action:'stop' } 请求停止；
 *                                   { action:'prune' } 清理已移除仓的候选；
 *                                   { action:'dismiss'|'import', id, force? } 剔除 / 导入成音源
 * PUT  /api/admin/source-discovery  改配置：{ enabled, repos, maxCandidatesPerRepo, maxDownloadsPerRound, preferLatestRelease, githubToken?, clearToken? }
 *
 * 导入只认 candidateId：地址与 blob sha 都取自服务端那行记录，客户端传 URL 或正文都没有入口。
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse } from '@/lib/api-response'
import { requireAdmin, AuthError, ForbiddenError } from '@/lib/services/user-context'
import { maskSecret } from '@/lib/services/app-setting'
import {
  SourceDiscoveryError,
  auditRepoFreshness,
  clearDiscoveryToken,
  countCandidates,
  discoveryStatus,
  dismissCandidate,
  getDiscoverySettings,
  importCandidate,
  listCandidates,
  pruneOrphanCandidates,
  requestDiscoveryStop,
  runDiscoveryCrawl,
  runDiscoveryDrain,
  saveDiscoverySettings,
  searchGitHubRepos,
  startCandidateProbe,
  startCandidateProbeBatch,
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
    preferLatestRelease: settings.preferLatestRelease,
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

    if (action === 'prune') {
      // 清掉"已从扫描列表里移除的仓"留下的候选行（已导入的保留），删多少由服务层算
      return createSuccessResponse(await pruneOrphanCandidates())
    }

    if (action === 'probe') {
      const id = Number(body?.id)
      if (!Number.isFinite(id) || id <= 0) return createErrorResponse('INVALID_PARAMS', '缺少合法的候选 id', 400)
      const result = startCandidateProbe(id)
      // 判级会真执行脚本（数秒到数十秒），所以只回 202，结果靠 GET 轮询
      return result.started
        ? createSuccessResponse(result, 202)
        : createSuccessResponse(result)
    }

    if (action === 'import') {
      const id = Number(body?.id)
      if (!Number.isFinite(id) || id <= 0) return createErrorResponse('INVALID_PARAMS', '缺少合法的候选 id', 400)
      // 导入要重下载 + 一次性进程校验，最坏十几秒，但必须等它出结果才知道源名，所以同步返回
      const source = await importCandidate(id, { force: body?.force === true })
      return createSuccessResponse({ imported: { id, path: source.path, name: source.name ?? source.path } })
    }

    if (action === 'probe-batch') {
      // 一批最多 50 条、串行逐条判（真打第三方取址），进度与停止都靠 GET 轮询
      const result = startCandidateProbeBatch()
      return result.started
        ? createSuccessResponse(result, 202)
        : createSuccessResponse(result)
    }

    if (action === 'drain') {
      const status = discoveryStatus()
      if (status.running || status.draining) return createSuccessResponse({ started: false, reason: '已有任务在跑' })
      // 连轮可能跑几十分钟，一样只回 202，进度靠 GET 轮询
      void runDiscoveryDrain().catch(err => {
        logger.warn('[discovery] 连轮失败:', err instanceof Error ? err.message : err)
      })
      return createSuccessResponse({ started: true }, 202)
    }

    if (action === 'stop') {
      return createSuccessResponse(requestDiscoveryStop())
    }

    if (action === 'search') {
      // 同步返回：一次搜索就一个接口调用（约 1 秒），而且搜完就得看到结果
      const result = await searchGitHubRepos(body?.query, body?.page, body?.sort, body?.pageSize)
      return createSuccessResponse(result)
    }

    if (action === 'freshness') {
      // 只读：逐个查 pushed_at，把"该不该剔"的材料摆给面板；剔除是面板另一次显式保存
      const report = await auditRepoFreshness(body?.maxAgeDays)
      return createSuccessResponse(report)
    }

    if (action === 'crawl') {
      if (discoveryStatus().running) return createSuccessResponse({ started: false, reason: '已有一轮在跑' })
      // 异步跑：一轮要几分钟，不能让请求挂着；进度靠 GET 轮询
      // repos 只当"缩小子集"用：清单外的仓传进来会被丢掉，扫什么仍以库里的清单为准
      void runDiscoveryCrawl({ onlyRepos: body?.repos }).catch(err => {
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
    if (typeof body?.preferLatestRelease === 'boolean') patch.preferLatestRelease = body.preferLatestRelease
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

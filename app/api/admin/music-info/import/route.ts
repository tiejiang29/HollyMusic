/**
 * 批量导入歌曲元数据 API（仅管理员）
 * POST /api/admin/music-info/import  body { items: MusicInfo[], recommend?: boolean }
 *
 * 配套本机采集流程：scripts/harvest-playlists.mjs 在本机采出 JSON，
 * scripts/push-music-info.mjs 分批推送到本接口写库（本机 IP 打上游更稳，
 * 服务器不承担采集流量）。
 *
 * 直接复用 upsertMusicInfosInTransaction 的 checksum 去重与 source_songmid
 * 复合唯一键，天然幂等：重复推送同一批数据，第二次全部 noop。
 *
 * 单请求上限 MAX_BATCH 条（脚本按此分批），防止事务过大。
 * 返回 { received, skipped, inserted, updated, noop, recommended }：
 * - received: body.items 数量
 * - skipped: 校验不通过被跳过的数量（缺 name/source/songmid、source 非法）
 * - inserted/updated/noop: upsert 实际动作计数（noop = 已存在且 checksum 相同）
 * - recommended: recommend=true 时实际标记为推荐的条数，未开启则为 0
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse } from '@/lib/api-response'
import { requireAdmin, AuthError, ForbiddenError } from '@/lib/services/user-context'
import {
  upsertMusicInfosInTransaction,
  setRecommendedBatch,
  getStorageSongmidForMusicInfo,
} from '@/lib/db'
import { logger } from '@/lib/logger'
import type { MusicInfo } from '@/lib/types/music'

const VALID_SOURCES = ['tx', 'wy', 'kw', 'kg', 'mg']
const MAX_BATCH = 500

function guard(err: unknown) {
  if (err instanceof AuthError) return createErrorResponse('UNAUTHORIZED', err.message, 401)
  if (err instanceof ForbiddenError) return createErrorResponse('FORBIDDEN', err.message, 403)
  return null
}

/** 逐条结构校验：缺关键字段或 source 非法的条目跳过，不拖垮整批 */
function validateItems(raw: unknown): { valid: MusicInfo[]; skipped: number } {
  if (!Array.isArray(raw)) return { valid: [], skipped: 0 }
  const valid: MusicInfo[] = []
  let skipped = 0
  for (const item of raw) {
    const ok =
      item !== null
      && typeof item === 'object'
      && typeof (item as MusicInfo).name === 'string'
      && (item as MusicInfo).name.trim() !== ''
      && typeof (item as MusicInfo).songmid === 'string'
      && (item as MusicInfo).songmid !== ''
      && VALID_SOURCES.includes((item as MusicInfo).source)
    if (ok) {
      valid.push(item as MusicInfo)
    } else {
      skipped++
    }
  }
  return { valid, skipped }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request)
    const body = await request.json().catch(() => ({}))
    const recommend = body?.recommend === true
    const { valid, skipped } = validateItems(body?.items)
    const received = Array.isArray(body?.items) ? body.items.length : 0

    if (received === 0) {
      return createErrorResponse('INVALID_PARAMS', '缺少必填字段: items (非空数组)', 400)
    }
    if (valid.length > MAX_BATCH) {
      return createErrorResponse('INVALID_PARAMS', `单次最多导入 ${MAX_BATCH} 条，请分批推送`, 400)
    }
    if (valid.length === 0) {
      return createErrorResponse('INVALID_PARAMS', `items 全部校验失败（共 ${received} 条）`, 400)
    }

    const actions = await upsertMusicInfosInTransaction(valid)
    // UpsertMusicInfoAction.action 取值为 insert/update/noop，映射到响应计数键
    const counts = { inserted: 0, updated: 0, noop: 0 }
    for (const a of actions) {
      if (a.action === 'insert') counts.inserted++
      else if (a.action === 'update') counts.updated++
      else counts.noop++
    }

    let recommended = 0
    if (recommend) {
      // noop 条目也要标记：已存在且未变化的歌同样可能需要进白名单
      const uids = [...new Set(valid.map(mi => `${mi.source}-${getStorageSongmidForMusicInfo(mi)}`))]
      const r = await setRecommendedBatch(uids, true)
      recommended = r.updated
    }

    return createSuccessResponse({ received, skipped, ...counts, recommended })
  } catch (err) {
    const g = guard(err)
    if (g) return g
    logger.error('[api/admin/music-info/import POST] error:', err)
    return createErrorResponse('INTERNAL_ERROR', '批量导入失败', 500)
  }
}

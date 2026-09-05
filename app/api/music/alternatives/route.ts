/**
 * 换源候选 API
 * GET /api/music/alternatives?name=晴天&singer=周杰伦&interval=04:29&source=kw
 *
 * 在「除 source 外」的其他平台按歌名+歌手+时长容差搜索同款歌曲，
 * 返回候选列表（含平台标记），供前端手动换源弹窗使用。
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { upsertMusicInfosInTransaction, getStorageSongmidForMusicInfo } from '@/lib/db'
import { findAlternatives } from '@/lib/services/source-toggle'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import type { SourceType } from '@/lib/types/music'

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)

    const p = request.nextUrl.searchParams
    const name = p.get('name')
    const singer = p.get('singer') ?? ''
    const interval = p.get('interval') ?? ''
    const source = p.get('source') as SourceType | null

    if (!name) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '缺少必填参数: name', 400)
    }

    // 构造一个"虚拟"musicInfo 驱动匹配逻辑（只需匹配字段）
    const probe = {
      name,
      singer,
      interval,
      source: source ?? 'kw',
      songmid: '__toggle_probe__',
      types: [],
      _types: {},
      typeUrl: {},
    } as unknown as Parameters<typeof findAlternatives>[0]

    const candidates = await findAlternatives(probe)

    // 候选入库（复用搜索入库链路），保证前端可直接调封面/歌词/播放
    if (candidates.length > 0) {
      try {
        await upsertMusicInfosInTransaction(candidates.map(c => c.musicInfo))
      } catch (err) {
        logger.warn('[api/music/alternatives] 候选入库失败（不影响返回）:', err)
      }
    }

    return createSuccessResponse({
      list: candidates.map(c => ({
        source: c.source,
        intervalMatched: c.intervalMatched,
        musicInfo: {
          ...c.musicInfo,
          uid: `${c.musicInfo.source}-${getStorageSongmidForMusicInfo(c.musicInfo)}`,
        },
      })),
    })
  } catch (err) {
    if (err instanceof AuthError) return createErrorResponse('UNAUTHORIZED', err.message, 401)
    logger.error('[api/music/alternatives GET] error:', err)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '获取换源候选失败', 500)
  }
}

/**
 * 歌单导入 API
 * POST /api/playlists/import   { name?: string, songs: Song[] }
 *
 * 用于从洛雪音乐（LX Music）等外部工具迁移歌单。兼容两种歌曲格式：
 *
 * 1. 旧格式（洛雪桌面版「导出歌单」/ 本站搜索结果结构）：
 *    { name, singer, source, songmid, hash?, interval, albumId?, albumName?, types?, _types?, typeUrl?, img? }
 *
 * 2. 新格式（洛雪移动端 / 桌面版本地数据库 musicInfo）：
 *    { name, singer, source, interval, meta: { songId?, hash?, albumId?, albumName?, picUrl?, qualitys?, _qualitys? } }
 *
 * 同时接受洛雪导出文件的原始包裹结构 { type: 'playList', data: [...] }。
 *
 * 流程：normalize → upsert MusicInfo（复用搜索入库链路）→ 建歌单 → 批量加入。
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { createPlaylist, addSongsToPlaylist } from '@/lib/services/playlist-service'
import { upsertMusicInfosInTransaction, getStorageSongmidForMusicInfo } from '@/lib/db'
import type { MusicInfo } from '@/lib/types/music'
import { logger } from '@/lib/logger'

const VALID_SOURCES = ['kw', 'kg', 'tx', 'wy', 'mg']

// 导入的歌曲若缺少音质信息，默认补全四档，
// 让播放时的音质回退链（flac24bit→flac→320k→128k）可以完整尝试
const DEFAULT_TYPES = [
  { type: '128k', size: '' },
  { type: '320k', size: '' },
  { type: 'flac', size: '' },
  { type: 'flac24bit', size: '' },
] as unknown as MusicInfo['types']
const DEFAULT_TYPES_MAP = {
  '128k': {},
  '320k': {},
  flac: {},
  flac24bit: {},
} as unknown as MusicInfo['_types']

function normalizeSong(raw: unknown): MusicInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const meta = (r.meta as Record<string, unknown>) || {}

  const source = String(r.source || '')
  if (!VALID_SOURCES.includes(source)) return null

  const hash = String(r.hash || meta.hash || '')
  let songmid = String(r.songmid || meta.songId || '')
  // kg 旧格式以 hash 为主键；其他平台没有 songmid 时也允许 hash 兜底
  if (!songmid && hash) songmid = hash
  if (!songmid) return null

  const rawTypes = (r.types || meta.qualitys) as unknown
  const rawTypesMap = (r._types || meta._qualitys) as unknown
  const types =
    Array.isArray(rawTypes) && rawTypes.length > 0
      ? (rawTypes as MusicInfo['types'])
      : DEFAULT_TYPES
  const _types =
    rawTypesMap && typeof rawTypesMap === 'object' && Object.keys(rawTypesMap).length > 0
      ? (rawTypesMap as MusicInfo['_types'])
      : DEFAULT_TYPES_MAP

  return {
    name: String(r.name || ''),
    singer: String(r.singer || ''),
    source: source as MusicInfo['source'],
    songmid,
    hash: hash || undefined,
    interval: String(r.interval || ''),
    albumId: String(r.albumId || meta.albumId || '') || undefined,
    albumName: String(r.albumName || meta.albumName || '') || undefined,
    img: String(r.img || meta.picUrl || '') || undefined,
    types,
    _types,
    typeUrl: (r.typeUrl as MusicInfo['typeUrl']) || {},
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request)
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '请求体必须是 JSON 对象', 400)
    }

    // 歌曲列表：优先 songs 字段；兼容洛雪导出 {type:'playList', data:[...]} 与裸数组
    const raw = body as Record<string, unknown>
    let rawSongs: unknown = raw.songs
    if (!Array.isArray(rawSongs) && Array.isArray(raw.data)) rawSongs = raw.data
    if (!Array.isArray(rawSongs) && Array.isArray(body)) rawSongs = body
    if (!Array.isArray(rawSongs)) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '缺少歌曲列表: songs', 400)
    }

    const name =
      (typeof raw.name === 'string' && raw.name.trim()) ||
      `导入歌单 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`

    const songs = (rawSongs as unknown[])
      .map(normalizeSong)
      .filter((s): s is MusicInfo => s !== null)

    if (songs.length === 0) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '没有可导入的有效歌曲（需包含 source 与 songmid）', 400)
    }

    // 与搜索结果同链路入库（含 checksum 去重）
    await upsertMusicInfosInTransaction(songs)

    // 条目 uid 用存储键（kg 以 hash 为主键），保证与 MusicInfo 行精确关联
    const uids = songs.map(s => `${s.source}-${getStorageSongmidForMusicInfo(s)}`)

    const playlist = await createPlaylist(user.username, name.trim())
    await addSongsToPlaylist(playlist.id, user.username, uids)

    logger.info(
      '[api/playlists/import] 用户 %s 导入歌单「%s」：%d/%d 首',
      user.username, name, songs.length, rawSongs.length,
    )
    return createSuccessResponse(
      { playlistId: playlist.id, name: playlist.name, imported: songs.length, skipped: rawSongs.length - songs.length },
      201,
    )
  } catch (err) {
    if (err instanceof AuthError) return createErrorResponse('UNAUTHORIZED', err.message, 401)
    logger.error('[api/playlists/import POST] error:', err)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '导入歌单失败', 500)
  }
}

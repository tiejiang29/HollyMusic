/**
 * 收藏 API
 *
 * 歌曲与专辑共用 /api/favorites，靠 type 区分（缺省 song）：
 * - 歌曲：id 是 uid（source-songmid），服务端回查 MusicInfo 富化
 * - 专辑：id 是平台专辑 id，收藏时随行提交 name/singer/img 快照（专辑不在本站曲库，
 *   服务端无法在列表时回查富化）
 */

import { apiGet, apiPost, apiDelete } from './client'
import type { MusicInfo } from '@/lib/types/music'

export interface FavoriteSong {
  songId: string
  source: string | null
  starredAt: string
  musicInfo: MusicInfo | null
}

/** 收藏的专辑（快照形态，够渲染一张专辑卡） */
export interface FavoriteAlbum {
  albumId: string
  /** 平台名：tx / kw / mg / apple */
  source: string | null
  name: string
  singer: string | null
  img: string | null
  starredAt: string
}

export function listFavorites(
  limit = 200,
  offset = 0
): Promise<{ list: FavoriteSong[]; total: number }> {
  return apiGet('favorites', { limit, offset })
}

export function starSong(uid: string): Promise<{ starred: boolean }> {
  return apiPost('favorites', { id: uid })
}

export function unstarSong(uid: string): Promise<{ starred: boolean }> {
  return apiDelete('favorites', { id: uid })
}

export function checkStarred(uid: string): Promise<{ starred: boolean }> {
  return apiGet('favorites/check', { id: uid })
}

export function listFavoriteAlbums(
  limit = 200,
  offset = 0
): Promise<{ list: FavoriteAlbum[]; total: number }> {
  return apiGet('favorites', { type: 'album', limit, offset })
}

/** 收藏专辑：name/singer/img 是展示快照，服务端存下来供收藏列表直接渲染 */
export function starAlbum(input: {
  albumId: string
  source?: string | null
  name?: string | null
  singer?: string | null
  img?: string | null
}): Promise<{ starred: boolean }> {
  return apiPost('favorites', { id: input.albumId, type: 'album', ...input })
}

export function unstarAlbum(albumId: string, source?: string | null): Promise<{ starred: boolean }> {
  return apiDelete('favorites', { id: albumId, type: 'album', ...(source ? { source } : {}) })
}

export function checkAlbumStarred(
  albumId: string,
  source?: string | null
): Promise<{ starred: boolean }> {
  return apiGet('favorites/check', { id: albumId, type: 'album', ...(source ? { source } : {}) })
}

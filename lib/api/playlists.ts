/**
 * 歌单 API
 */

import { apiGet, apiPost, apiPatch, apiDelete } from './client'
import type { MusicInfo } from '@/lib/types/music'

export interface PlaylistSummary {
  id: number
  name: string
  comment: string | null
  owner: string | null
  username: string
  isPublic: boolean
  /** 收藏歌单标记：由 collect（他人歌单副本）/ 平台导入生成，区别于自建 */
  collected: boolean
  songCount: number
  duration: number | null
  coverArt: string | null
  createdAt: string
}

export interface PlaylistEntryItem {
  position: number
  songId: string
  musicInfo: MusicInfo | null
  addedAt: string
  addedBy: string | null
}

export interface PlaylistDetail extends PlaylistSummary {
  entries: PlaylistEntryItem[]
  allowedUsers: string[]
}

export function listPlaylists(): Promise<{ list: PlaylistSummary[] }> {
  return apiGet('playlists')
}

export function getPlaylist(id: number): Promise<PlaylistDetail> {
  return apiGet(`playlists/${id}`)
}

/** collected=true 用于「收藏」类快照（如榜单收藏），后端据此归入「收藏歌单」分组 */
export function createPlaylist(name: string, opts: { collected?: boolean } = {}): Promise<PlaylistSummary> {
  return apiPost('playlists', { name, ...opts })
}

export interface ImportPlaylistResult {
  playlistId: number
  name: string
  imported: number
  skipped: number
}

/**
 * 导入歌单（兼容洛雪新旧歌曲格式，后端统一归一化）
 */
export function importPlaylist(
  name: string,
  songs: unknown[]
): Promise<ImportPlaylistResult> {
  return apiPost('playlists/import', { name, songs })
}

export interface ImportRemoteResult {
  playlistId: number
  name: string
  source: string
  sourcePlaylistId: string
  author: string
  imported: number
}

/**
 * 从平台歌单链接导入（kw/wy/tx/kg/mg 歌单）
 * urlOrId：歌单分享链接（自动识别平台）或纯歌单 ID（需同时给 source）
 * cookie：可选，平台网页登录 Cookie（导入私有歌单用，目前支持 wy/tx）
 */
export function importPlaylistFromLink(
  urlOrId: string,
  source?: string,
  name?: string,
  cookie?: string
): Promise<ImportRemoteResult> {
  const isUrl = /^https?:\/\//i.test(urlOrId.trim())
  return apiPost('playlists/import-remote', {
    ...(isUrl ? { url: urlOrId.trim() } : { id: urlOrId.trim(), source }),
    ...(name ? { name } : {}),
    ...(cookie ? { cookie } : {}),
  })
}

export function updatePlaylist(
  id: number,
  updates: { name?: string; comment?: string; public?: boolean }
): Promise<{ updated: boolean }> {
  return apiPatch(`playlists/${id}`, updates)
}

export function deletePlaylist(id: number): Promise<{ deleted: boolean }> {
  return apiDelete(`playlists/${id}`)
}

export function addSongsToPlaylist(
  id: number,
  songIds: string[]
): Promise<{ added: boolean }> {
  return apiPost(`playlists/${id}/songs`, { songIds })
}

export function removeSongsFromPlaylist(
  id: number,
  positions: number[]
): Promise<{ removed: boolean }> {
  return apiDelete(`playlists/${id}/songs`, { positions: positions.join(',') })
}

/** 收藏歌单：复制一份到自己名下 */
export function collectPlaylist(id: number): Promise<{ id: number; name: string }> {
  return apiPost(`playlists/${id}/collect`, {})
}
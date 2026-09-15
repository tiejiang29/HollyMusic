/**
 * 最近播放的歌单/专辑 API
 */

import { apiGet, apiPost } from './client'

export interface RecentContextItem {
  itemType: 'playlist' | 'album'
  itemId: string
  name: string
  img?: string | null
  owner?: string | null
  playedAt: string
}

/** 记录播放上下文（歌单页/专辑页播放时调用） */
export function recordRecentContext(data: {
  itemType: 'playlist' | 'album'
  itemId: string
  name: string
  img?: string | null
  owner?: string | null
}): Promise<{ recorded: boolean }> {
  return apiPost('recent-contexts', data)
}

/** 查最近播放（type=playlist|album|all，默认 all） */
export function getRecentContexts(type: string = 'all', limit: number = 10): Promise<{ list: RecentContextItem[] }> {
  return apiGet('recent-contexts', { type, limit: String(limit) })
}

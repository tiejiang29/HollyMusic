import { apiGet } from './client'
import type { DiscoveryCollectionDetail, DiscoveryPlaylist, DiscoveryPlaylistFilter, DiscoverySource, DiscoveryToplist, PlaylistCapabilities, PlaylistTagsResult } from '@/lib/services/discovery-service'

/** 各渠道歌单广场真实支持的档位与筛选能力（服务端声明，客户端照它显示） */
export function getPlaylistCapabilities(): Promise<Record<DiscoverySource, PlaylistCapabilities>> {
  return apiGet('discover/playlists/capabilities')
}

export function getToplists(source: DiscoverySource = 'tx', scope: 'common' | 'full' = 'common'): Promise<DiscoveryToplist[]> {
  return apiGet('discover/toplists', { source, scope })
}

export function getToplistDetail(source: DiscoverySource, id: string): Promise<DiscoveryCollectionDetail> {
  return apiGet(`discover/toplists/${encodeURIComponent(id)}`, { source })
}

export function getRecommendedPlaylists(source: DiscoverySource = 'tx', limit = 12, page = 1, filter: DiscoveryPlaylistFilter = {}): Promise<DiscoveryPlaylist[]> {
  return apiGet('discover/playlists', { source, limit, page, ...filter })
}

export function getPlaylistTags(source: DiscoverySource = 'tx'): Promise<PlaylistTagsResult> {
  return apiGet('discover/playlists/tags', { source })
}

export function getRecommendedPlaylistDetail(source: DiscoverySource, id: string): Promise<DiscoveryCollectionDetail> {
  return apiGet(`discover/playlists/${encodeURIComponent(id)}`, { source })
}

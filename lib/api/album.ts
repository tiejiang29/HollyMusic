/**
 * 专辑板块 API（本地中文专辑库）
 *
 * 搜索/联想/详情倒查走 /api/album/local/*，专辑卡片以 MB release-group UUID（gid）为稳定 id；
 * 本地未命中时搜索接口自动附带平台兜底结果（platformList，wy 专辑卡片）。
 */

import { apiGet } from './client'
import type { Song } from '@/lib/types/music'

export interface LocalAlbumSummary {
  /** MB release-group UUID（带横杠） */
  gid: string
  title: string
  artist: string
  /** 曲目数（有曲目表时回填） */
  trackCount?: number
  /** 封面 URL（懒加载回填，本地库本身无封面数据） */
  img?: string | null
}

export interface LocalAlbumDetailData {
  album: { gid: string; name: string; singer: string; trackCount: number; img: string | null }
  list: Song[]
  /** gid 不在本地库（或库文件未部署）时为 true */
  unsupported?: boolean
}

/** 平台专辑详情（兜底）：本地优先尝试（name/singer），未命中走平台原生详情 */
export interface PlatformAlbumDetailData {
  album: { source: 'wy' | 'kw' | 'mg'; albumId: string; name: string; singer: string; img?: string | null; publishTime?: string; trackCount?: number }
  list: Song[]
  /** 该源无可用详情端点（mg） */
  unsupported?: boolean
}

export type AlbumSource = 'wy' | 'kw' | 'mg'

export function getPlatformAlbumTracks(
  source: AlbumSource,
  albumId: string,
  opts: { name?: string; singer?: string } = {}
): Promise<PlatformAlbumDetailData> {
  return apiGet('album/tracks', { source, albumId, ...opts })
}

export interface PlatformAlbumSummary {
  source: 'wy'
  albumId: string
  name: string
  singer: string
  img?: string | null
  publishTime?: string
  trackCount?: number
}

export interface AlbumSearchResult {
  /** 本地专辑库命中（gid 卡片，详情走本地倒查） */
  list: LocalAlbumSummary[]
  /** 本地未命中时自动回退的平台搜索结果（卡片走平台详情兜底） */
  platformList: PlatformAlbumSummary[]
}

/** 专辑搜索：本地专辑库优先，本地未命中自动去网易平台搜专辑 */
export function searchAlbums(keyword: string, limit = 30): Promise<AlbumSearchResult> {
  return apiGet('album/local/search', { keyword, limit })
}

/** 专辑名前缀联想（毫秒级，搜索框输入联想用） */
export function suggestLocalAlbums(keyword: string, limit = 10): Promise<{ list: LocalAlbumSummary[] }> {
  return apiGet('album/local/suggest', { keyword, limit })
}

/** 专辑详情：本地曲目表 → 逐首在线搜曲 → 可播放 Song[] */
export function getLocalAlbumTracks(gid: string): Promise<LocalAlbumDetailData> {
  return apiGet('album/local/tracks', { gid })
}

/** 专辑封面（懒加载）：服务端取首曲目在 tx 搜一曲推导 QQ 专辑封面直链，结果缓存 24h */
export function getAlbumCover(gid: string): Promise<{ img: string | null }> {
  return apiGet('album/local/cover', { gid })
}

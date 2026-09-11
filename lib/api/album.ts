/**
 * 专辑搜索/详情 API
 * 一期支持 wy / kw / mg（mg 只出卡片，详情 unsupported）。
 */

import { apiGet } from './client'
import type { Song } from '@/lib/types/music'

export type AlbumSource = 'wy' | 'kw' | 'mg'

export interface AlbumSummary {
  source: AlbumSource
  albumId: string
  name: string
  singer: string
  img?: string | null
  /** 发行日期（YYYY-MM-DD，取不到时缺省） */
  publishTime?: string
  /** 曲目数（kw 聚合来源为参考值） */
  trackCount?: number
}

export interface AlbumSearchResultData {
  list: AlbumSummary[]
  total: number
  page: number
  allPage: number
  limit: number
  source: AlbumSource | 'all'
  /** all 模式下失败的源 */
  failedSources?: AlbumSource[]
}

export interface AlbumDetailData {
  album: AlbumSummary | null
  list: Song[]
  /** 该源暂不支持专辑曲目（一期 mg） */
  unsupported?: boolean
}

export function searchAlbums(
  source: AlbumSource | 'all',
  keyword: string,
  page = 1,
  limit = 30
): Promise<AlbumSearchResultData> {
  return apiGet<AlbumSearchResultData>('search/album', { source, keyword, page, limit })
}

export function getAlbumTracks(source: AlbumSource, albumId: string): Promise<AlbumDetailData> {
  return apiGet<AlbumDetailData>('album/tracks', { source, albumId })
}

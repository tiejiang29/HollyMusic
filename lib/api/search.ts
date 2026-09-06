/**
 * 搜索 API
 */

import { apiGet } from './client'
import type { Song, SourceType } from '@/lib/types/music'

export interface SearchResultData {
  list: Song[]
  total: number
  page: number
  allPage: number
  limit: number
  source: SourceType | 'all' | 'local'
  /** 平台搜索附带的前几条本地音乐库匹配（source=local 时无此字段） */
  localList?: Song[]
}

export function search(
  source: SourceType | 'all' | 'local',
  keyword: string,
  page = 1,
  limit = 30
): Promise<SearchResultData> {
  return apiGet<SearchResultData>('search', { source, keyword, page, limit })
}

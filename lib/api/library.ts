import { apiGet, apiPost, apiDelete } from './client'

export interface LibrarySongItem {
  id: number
  dedupeKey: string
  uid: string
  name: string
  singer: string
  album: string
  quality: string
  filePath: string
  fileSize: number
  durationSec: number
  createdAt: string
}

export interface LibraryStats {
  count: number
  totalBytes: number
  quotaBytes: number
  full: boolean
}

export interface LibraryListResult {
  list: LibrarySongItem[]
  total: number
  page: number
  pageSize: number
  stats: LibraryStats
  singerGroups: Array<{ singer: string; count: number }>
}

export function getLibraryList(params: { keyword?: string; singer?: string; page?: number; pageSize?: number } = {}): Promise<LibraryListResult> {
  const qs = new URLSearchParams()
  if (params.keyword) qs.set('keyword', params.keyword)
  if (params.singer) qs.set('singer', params.singer)
  if (params.page) qs.set('page', String(params.page))
  if (params.pageSize) qs.set('pageSize', String(params.pageSize))
  const query = qs.toString()
  return apiGet(`library${query ? `?${query}` : ''}`)
}

export function deleteLibrarySong(id: number): Promise<{ deleted: boolean }> {
  return apiDelete(`library/${id}`)
}

export function rebuildLibraryIndex(): Promise<{ scanned: number; added: number }> {
  return apiPost('library/rebuild')
}

/**
 * 专辑板块 API（平台链）
 *
 * 专辑搜索走 /api/search?type=album（后端编排链 TX → 酷我 → 咪咕 → Apple），
 * 详情按卡片的 source 走 /api/album/{tx,kw,mg,apple}/tracks。
 * 原本地 MusicBrainz 专辑库（/api/album/local/*，gid 卡片）已下线。
 */

import { apiGet } from './client'
import type { Song } from '@/lib/types/music'

/** Apple 专辑详情：Apple 曲目表（繁→简）→ 逐首在线搜曲落歌 → 可播放 Song[] */
export interface AppleAlbumDetailData {
  album: { collectionId: string; name: string; singer: string; year?: string; img: string | null; trackCount: number }
  list: Song[]
  /** collectionId 无效时为 true */
  unsupported?: boolean
}

export function getAppleAlbumTracks(collectionId: string): Promise<AppleAlbumDetailData> {
  return apiGet('album/apple/tracks', { collectionId })
}

/** 链专辑详情（kw/mg）：一次拿全曲目（全带可播 id）；apple 为降级形态 */
export interface KwAlbumDetailData {
  source: 'kw' | 'mg' | 'tx' | 'apple'
  album: {
    albumId?: string
    name: string
    singer: string
    img?: string | null
    year?: string
    company?: string
    trackCount: number
    profile?: { releaseDate?: string; genres?: string[]; recordLabels?: string[] } | null
  }
  list: Song[]
  /** 酷我与 Apple 均不可用时为 true */
  unsupported?: boolean
}

/** 酷我专辑曲目（name/singer=应急钥匙：kw 链不可用时服务端回落 Apple） */
export function getTxAlbumTracks(albumId: string, name?: string, singer?: string): Promise<KwAlbumDetailData> {
  const params: Record<string, string> = { albumid: albumId }
  if (name) params.name = name
  if (singer) params.singer = singer
  return apiGet('album/tx/tracks', params)
}

export function getMgAlbumTracks(albumId: string, name?: string, singer?: string): Promise<KwAlbumDetailData> {
  const params: Record<string, string> = { albumid: albumId }
  if (name) params.name = name
  if (singer) params.singer = singer
  return apiGet('album/mg/tracks', params)
}

export function getKwAlbumTracks(albumId: string, name?: string, singer?: string): Promise<KwAlbumDetailData> {
  const params: Record<string, string> = { albumid: albumId }
  if (name) params.name = name
  if (singer) params.singer = singer
  return apiGet('album/kw/tracks', params)
}

export interface PlatformAlbumSummary {
  source: 'kw' | 'mg' | 'tx' | 'apple'
  /** kw albumid 或 Apple collectionId（按 source） */
  albumId: string
  name: string
  singer: string
  img?: string | null
  year?: string
  trackCount?: number
}

export interface AlbumSearchResult {
  /** 平台专辑卡片（链首命中平台的结果，卡片走对应平台详情链） */
  platformList: PlatformAlbumSummary[]
}

/** 专辑搜索：后端编排链 TX → 酷我 → 咪咕 → Apple */
export function searchAlbums(keyword: string, limit = 30): Promise<AlbumSearchResult> {
  return apiGet('search', { type: 'album', keyword, limit })
}


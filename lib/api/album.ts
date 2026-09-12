/**
 * 专辑板块 API（本地中文专辑库）
 *
 * 搜索/联想/随机/画像推荐/详情倒查全部走 /api/album/local/*，
 * 专辑卡片以 MB release-group UUID（gid）为稳定 id，详情可播。
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
}

export interface LocalAlbumDetailData {
  album: { gid: string; name: string; singer: string; trackCount: number; img: string | null }
  list: Song[]
  /** gid 不在本地库（或库文件未部署）时为 true */
  unsupported?: boolean
}

export interface AlbumRecommendResult {
  list: LocalAlbumSummary[]
  /** false = 画像不足回退随机 */
  personalized: boolean
}

/** 专辑搜索：专辑名包含 + 歌手包含，gid 去重 */
export function searchLocalAlbums(keyword: string, limit = 30): Promise<{ list: LocalAlbumSummary[] }> {
  return apiGet('album/local/search', { keyword, limit })
}

/** 专辑名前缀联想（毫秒级，搜索框输入联想用） */
export function suggestLocalAlbums(keyword: string, limit = 10): Promise<{ list: LocalAlbumSummary[] }> {
  return apiGet('album/local/suggest', { keyword, limit })
}

/** 随机专辑（"随便听听"） */
export function getRandomAlbums(size = 20): Promise<{ list: LocalAlbumSummary[] }> {
  return apiGet('album/local/random', { size })
}

/** 画像推荐专辑（用户画像 top 歌手 → 本地库专辑；画像不足回退随机） */
export function getRecommendedAlbums(size = 20): Promise<AlbumRecommendResult> {
  return apiGet('album/local/recommend', { size })
}

/** 专辑详情：本地曲目表 → 逐首在线搜曲 → 可播放 Song[] */
export function getLocalAlbumTracks(gid: string): Promise<LocalAlbumDetailData> {
  return apiGet('album/local/tracks', { gid })
}

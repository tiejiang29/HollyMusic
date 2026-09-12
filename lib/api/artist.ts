/**
 * 歌手板块 API（Apple 数据源）
 */

import { apiGet } from './client'
import type { Song } from '@/lib/types/music'

export interface ArtistSummary {
  artistId: string
  name: string
  genre?: string
}

export interface ArtistProfile {
  qid: string
  birthDate?: string
  occupations?: string[]
  genres?: string[]
  recordLabels?: string[]
  nationality?: string
}

export interface AlbumProfile {
  qid: string
  verified?: boolean
  releaseDate?: string
  genres?: string[]
  recordLabels?: string[]
}

export interface ArtistDetailData {
  artist: {
    artistId: string
    name: string
    genre?: string
    /** 维基简介（简体，未配置代理或条目不存在时缺省） */
    bio?: string | null
    /** Wikidata 结构化档案（best-effort） */
    profile?: ArtistProfile | null
    /** 头像（首张专辑封面，Apple 歌手实体无照片） */
    img: string | null
  }
  hotSongs: Song[]
  albums: Array<{ source: 'apple'; albumId: string; name: string; artist: string; year?: string; img: string | null }>
  unsupported?: boolean
}

export function searchArtists(keyword: string): Promise<{ type: string; list: ArtistSummary[] }> {
  return apiGet('search', { type: 'artist', keyword })
}

export function getArtistDetail(artistId: string): Promise<ArtistDetailData> {
  return apiGet('artist/apple/detail', { artistId })
}

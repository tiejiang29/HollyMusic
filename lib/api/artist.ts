/**
 * 歌手板块 API（三源架构：酷我全链优先，Apple 兜底）
 */

import { apiGet } from './client'
import type { Song } from '@/lib/types/music'

export interface ArtistSummary {
  artistId: string
  name: string
  genre?: string
  /** 卡片来源（kw=酷我链详情 / apple=Apple 链详情），决定前端路由 */
  source?: 'kw' | 'apple'
  /** 酷我官方头像（star.kuwo.cn，卡片可直显） */
  pic?: string | null
  musicNum?: number
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

export type ArtistAlbumCard = {
  source: 'kw' | 'apple'
  albumId: string
  name: string
  artist: string
  year?: string
  img: string | null
}

export interface ArtistDetailData {
  /** 本次详情实际用的链（kw 失败降级时为 'apple'，头像/专辑路由随之切换） */
  source?: 'kw' | 'apple'
  artist: {
    artistId: string
    name: string
    genre?: string
    /** 简介（酷我链=酷我百科；Apple 链=维基） */
    bio?: string | null
    /** 结构化档案（Apple 链 Wikidata；酷我链生日/国籍） */
    profile?: ArtistProfile | null
    /** 头像（kw=starheads 官方照；apple=首专辑封面） */
    img: string | null
    birthDate?: string
    country?: string
  }
  hotSongs: Song[]
  albums: ArtistAlbumCard[]
  unsupported?: boolean
}

export function searchArtists(keyword: string): Promise<{ type: string; source?: string; list: ArtistSummary[] }> {
  return apiGet('search', { type: 'artist', keyword })
}

export function getArtistDetail(artistId: string): Promise<ArtistDetailData> {
  return apiGet('artist/apple/detail', { artistId })
}

/** 酷我歌手详情（name=应急钥匙：kw 链不可用时服务端回落 Apple） */
export function getKwArtistDetail(artistId: string, name?: string): Promise<ArtistDetailData> {
  return apiGet('artist/kw/detail', name ? { artistId, name } : { artistId })
}

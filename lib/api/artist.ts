/**
 * 歌手板块 API（三源架构：酷我全链优先，Apple 兜底）
 */

import { apiGet } from './client'
import type { Song } from '@/lib/types/music'

export interface ArtistSummary {
  artistId: string
  name: string
  genre?: string
  /** 卡片来源（kw=酷我 / mg=咪咕 / apple=Apple），决定前端路由 */
  source?: 'kw' | 'mg' | 'apple'
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
  source: 'kw' | 'mg' | 'apple'
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

export interface ArtistMv {
  id: string
  name: string
  artist: string
  artwork: string | null
  durationSec: number
  releaseDate?: string
  /** 30 秒预告（m4v 直链，免鉴权） */
  previewUrl: string | null
}

/** 歌手 MV 列表（Apple amp 数据，跨链通用增强；无结果返回空） */
export function getArtistMvs(name: string): Promise<{ list: ArtistMv[] }> {
  return apiGet('artist/apple/mvs', { name })
}

export function searchArtists(keyword: string): Promise<{ type: string; source?: string; list: ArtistSummary[] }> {
  return apiGet('search', { type: 'artist', keyword })
}

export function getArtistDetail(artistId: string): Promise<ArtistDetailData> {
  return apiGet('artist/apple/detail', { artistId })
}

/** 酷我歌手详情（name=应急钥匙：kw 链不可用时服务端回落 Apple） */
export function getMgArtistDetail(artistId: string, name?: string): Promise<ArtistDetailData> {
  return apiGet('artist/mg/detail', name ? { artistId, name } : { artistId })
}

export function getKwArtistDetail(artistId: string, name?: string): Promise<ArtistDetailData> {
  return apiGet('artist/kw/detail', name ? { artistId, name } : { artistId })
}

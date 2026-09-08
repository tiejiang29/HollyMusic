/**
 * 猜我喜欢 API
 */

import { apiGet } from './client'
import type { Song } from '@/lib/types/music'

export interface GuessSong extends Song {
  /** 推荐理由，如 "因为你常听 周杰伦"；冷启动兜底时为 "为你随机推荐" */
  reason: string
}

export interface GuessResult {
  list: GuessSong[]
  page: number
  size: number
  /** 结果稳定日期键（同一天同结果，第二天自动换血） */
  date: string
  /** false = 冷启动随机兜底 */
  personalized: boolean
}

export function getGuessYouLike(size = 12, page = 1): Promise<GuessResult> {
  return apiGet('recommend/guess', { size, page })
}

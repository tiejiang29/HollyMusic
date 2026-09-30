/**
 * 歌词 API
 */

import { apiGet } from './client'

export interface LyricsData {
  songId: string
  lyric: string | null
  tlyric: string | null
  /** 逐字（增强 LRC：行首 [mm:ss.xxx] + 每块文本前一个绝对起始）；无逐字时为 null */
  wordLyric: string | null
  hasLyric: boolean
}

export function getLyrics(uid: string): Promise<LyricsData> {
  return apiGet<LyricsData>('lyrics', { id: uid })
}

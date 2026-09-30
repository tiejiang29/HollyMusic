
import { useEffect, useMemo, useRef, useState } from 'react'
import { getLyrics } from '@/lib/api/lyrics'
import { parseLrc, parseEnhancedLrc, parsePlainText, findActiveLineIndex, type LrcLine } from '@/lib/utils/lrc'

export function useLyrics(uid: string | undefined, currentTime: number) {
  const [raw, setRaw] = useState<{ lyric: string | null; tlyric: string | null; wordLyric: string | null } | null>(null)
  const [loading, setLoading] = useState(false)
  // 请求序号：快速切歌时丢弃旧歌词的晚到响应（与 search-store 同款防护）
  const reqIdRef = useRef(0)

  useEffect(() => {
    const reqId = ++reqIdRef.current
    if (!uid) {
      setRaw(null)
      return
    }
    setLoading(true)
    getLyrics(uid)
      .then(d => {
        if (reqId !== reqIdRef.current) return
        setRaw({ lyric: d.lyric, tlyric: d.tlyric, wordLyric: d.wordLyric ?? null })
      })
      .catch(() => {
        if (reqId !== reqIdRef.current) return
        setRaw(null)
      })
      .finally(() => {
        if (reqId !== reqIdRef.current) return
        setLoading(false)
      })
  }, [uid])

  const lines = useMemo<LrcLine[]>(() => {
    const timed = parseLrc(raw?.lyric)
    const wordLines = parseEnhancedLrc(raw?.wordLyric)
    // 服务端承诺逐字与整行出自同一次解析；这里仍然核对，对不上就退回整行渲染
    if (wordLines.length && sameTimes(wordLines, timed)) return wordLines
    if (timed.length > 0) return timed
    // 回退：无时间轴纯文本歌词（tx/kw/mg 常见），按行展示、不参与高亮/跳转
    return parsePlainText(raw?.lyric)
  }, [raw?.lyric, raw?.wordLyric])
  const translated = useMemo<LrcLine[]>(() => parseLrc(raw?.tlyric), [raw?.tlyric])
  const activeIndex = useMemo(
    () => findActiveLineIndex(lines, currentTime),
    [lines, currentTime]
  )

  return { lines, translated, activeIndex, hasLyric: lines.length > 0, loading }
}

/** 行数与每行时间戳完全一致才认为逐字可用（时间单位都是秒） */
function sameTimes(wordLines: LrcLine[], timed: LrcLine[]): boolean {
  if (!timed.length || wordLines.length !== timed.length) return false
  return wordLines.every((line, index) => line.time === timed[index].time)
}

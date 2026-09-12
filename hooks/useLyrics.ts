
import { useEffect, useMemo, useRef, useState } from 'react'
import { getLyrics } from '@/lib/api/lyrics'
import { parseLrc, parsePlainText, findActiveLineIndex, type LrcLine } from '@/lib/utils/lrc'

export function useLyrics(uid: string | undefined, currentTime: number) {
  const [raw, setRaw] = useState<{ lyric: string | null; tlyric: string | null } | null>(null)
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
        setRaw({ lyric: d.lyric, tlyric: d.tlyric })
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
    if (timed.length > 0) return timed
    // 回退：无时间轴纯文本歌词（tx/kw/mg 常见），按行展示、不参与高亮/跳转
    return parsePlainText(raw?.lyric)
  }, [raw?.lyric])
  const translated = useMemo<LrcLine[]>(() => parseLrc(raw?.tlyric), [raw?.tlyric])
  const activeIndex = useMemo(
    () => findActiveLineIndex(lines, currentTime),
    [lines, currentTime]
  )

  return { lines, translated, activeIndex, hasLyric: lines.length > 0, loading }
}

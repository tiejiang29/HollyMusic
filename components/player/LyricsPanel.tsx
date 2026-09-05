
import { useEffect, useRef } from 'react'
import { usePlayerStore } from '@/lib/store/player-store'
import { useLyrics } from '@/hooks/useLyrics'
import { CoverImage } from '@/components/shared/CoverImage'
import { AudioSpectrum } from './AudioSpectrum'
import { ChevronDown, Play, Pause, SkipBack, SkipForward, Loader2 } from 'lucide-react'

interface LyricsPanelProps {
  audio: HTMLAudioElement | null
}

/**
 * 全屏歌词页（桌面：左侧大封面+歌曲信息，右侧滚动歌词；
 * 移动端：保留居中歌词 + 底部信息条）。
 */
export function LyricsPanel({ audio }: LyricsPanelProps) {
  const isOpen = usePlayerStore(s => s.isLyricsOpen)
  const setLyricsOpen = usePlayerStore(s => s.setLyricsOpen)
  const track = usePlayerStore(s => s.currentTrack)
  const currentTime = usePlayerStore(s => s.currentTime)
  const duration = usePlayerStore(s => s.duration)
  const isPlaying = usePlayerStore(s => s.isPlaying)
  const bufferProgress = usePlayerStore(s => s.bufferProgress)
  const togglePlay = usePlayerStore(s => s.togglePlay)
  const next = usePlayerStore(s => s.next)
  const previous = usePlayerStore(s => s.previous)
  const seek = usePlayerStore(s => s.seek)
  const { lines, activeIndex, hasLyric, loading } = useLyrics(track?.uid, currentTime)

  const activeRef = useRef<HTMLDivElement>(null)
  const buffering = bufferProgress !== null

  // WAI-ARIA 对话框模式：Esc 关闭（歌词面板为全屏页，键盘用户需要退出路径）
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const t = e.target
      if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      setLyricsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, setLyricsOpen])

  // 当前行变化 → 平滑滚动到中央
  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeIndex])

  if (!isOpen || !track) return null

  const progress = buffering
    ? bufferProgress
    : duration > 0
      ? (currentTime / duration) * 100
      : 0

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      role="dialog"
      aria-modal="true"
      aria-label="歌词面板"
    >
      {/* 顶部：极简返回箭头（safe-area 保护，避开状态栏/刘海） */}
      <div className="safe-area-top flex h-14 shrink-0 items-center px-2">
        <button
          onClick={() => setLyricsOpen(false)}
          className="touch-target flex items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground"
          aria-label="收起歌词"
        >
          <ChevronDown className="h-6 w-6" />
        </button>
      </div>

      {/* 主体：桌面左侧大封面+信息，右侧歌词；移动端仅居中歌词 */}
      <div className="flex min-h-0 flex-1 items-stretch justify-center gap-8 px-6 pb-6 md:gap-12 lg:px-16">
        {/* 左列（md+）：封面、歌名/歌手/专辑、频谱 */}
        <div className="hidden w-full max-w-sm flex-col items-center justify-center gap-7 md:flex">
          <CoverImage
            uid={track.uid}
            cacheKey={track.musicInfo.img}
            className="aspect-square w-full rounded-2xl shadow-2xl shadow-black/30"
          />
          <div className="w-full text-center">
            <div className="truncate text-2xl font-bold leading-snug">{track.name}</div>
            <div className="mt-2 truncate text-sm text-muted-foreground">{track.artist}</div>
            {track.album && (
              <div className="mt-1 truncate text-xs text-muted-foreground/60">{track.album}</div>
            )}
          </div>
          <AudioSpectrum
            audio={audio}
            isPlaying={isPlaying}
            className="h-8 w-full"
          />
        </div>

        {/* 右列：滚动歌词（上下渐隐遮罩，上下留白保证首尾行可居中） */}
        <div className="min-h-0 w-full md:max-w-2xl">
          <div className="h-full overflow-y-auto py-[30vh] [mask-image:linear-gradient(to_bottom,transparent,black_18%,black_82%,transparent)]">
            {loading ? (
              <div className="text-center text-muted-foreground">加载歌词...</div>
            ) : hasLyric ? (
              <div className="mx-auto max-w-lg space-y-6">
                {lines.map((line, i) => {
                  // 纯文本回退行 time 为 NaN：不可点击跳转，样式退化为普通文本
                  const seekable = Number.isFinite(line.time)
                  return (
                    <div
                      key={i}
                      ref={i === activeIndex ? activeRef : undefined}
                      onClick={seekable ? () => seek(line.time) : undefined}
                      className={`text-center transition-all duration-300 ${
                        seekable ? 'cursor-pointer ' : ''
                      }${
                        i === activeIndex
                          ? 'scale-105 text-xl font-bold text-primary md:text-2xl'
                          : 'text-base text-muted-foreground/70 hover:text-foreground md:text-lg'
                      }`}
                    >
                      {line.text}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="text-center text-muted-foreground">暂无歌词</div>
            )}
          </div>
        </div>
      </div>

      {/* 底部：进度条 + 播放控制（safe-area-bottom 避开手势条） */}
      <div className="safe-area-bottom shrink-0 border-t border-border bg-card px-4 pb-3 pt-2 md:px-8 md:pb-4">
        {/* 移动端：封面+歌曲信息行（桌面信息已在左列展示） */}
        <div className="mb-2 flex min-w-0 items-center gap-3 md:hidden">
          <CoverImage uid={track.uid} cacheKey={track.musicInfo.img} className="h-10 w-10 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{track.name}</div>
            <div className="truncate text-xs text-muted-foreground">{track.artist}</div>
          </div>
          <AudioSpectrum audio={audio} isPlaying={isPlaying} className="h-7 w-24 shrink-0" />
        </div>

        {/* 进度条 + 时间 */}
        <div className="mx-auto mb-3 flex w-full max-w-2xl items-center gap-3 text-xs tabular-nums text-muted-foreground">
          <span className="w-10 text-right">
            {buffering ? `${bufferProgress}%` : formatTimeShort(currentTime)}
          </span>
          <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="w-10">
            {buffering ? '加载' : formatTimeShort(duration)}
          </span>
        </div>

        {/* 控制按钮（居中，播放键加大） */}
        <div className="flex items-center justify-center gap-10">
          <button
            onClick={previous}
            className="touch-target flex items-center justify-center rounded-full text-foreground/80 transition hover:bg-accent hover:text-foreground"
            aria-label="上一首"
          >
            <SkipBack className="h-6 w-6 fill-current" />
          </button>
          <button
            onClick={togglePlay}
            disabled={buffering}
            className="touch-target flex h-12 w-12 items-center justify-center rounded-full bg-foreground text-background transition hover:scale-105 disabled:opacity-60 disabled:hover:scale-100"
            aria-label="播放/暂停"
          >
            {buffering ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : isPlaying ? (
              <Pause className="h-6 w-6 fill-current" />
            ) : (
              <Play className="h-6 w-6 fill-current" />
            )}
          </button>
          <button
            onClick={next}
            className="touch-target flex items-center justify-center rounded-full text-foreground/80 transition hover:bg-accent hover:text-foreground"
            aria-label="下一首"
          >
            <SkipForward className="h-6 w-6 fill-current" />
          </button>
        </div>
      </div>
    </div>
  )
}

/** 紧凑时间格式：mm:ss */
function formatTimeShort(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return '0:00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

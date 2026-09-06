
import type { CSSProperties } from 'react'
import { usePlayerStore } from '@/lib/store/player-store'
import { useLyrics } from '@/hooks/useLyrics'

/**
 * 底栏当前歌词行（渲染于 PlayerControls 顶部，替代原频谱位）。
 *
 * 性能约束：本组件是底栏唯一订阅 currentTime 的节点（每 ~250ms 重渲染），
 * 因此刻意做小——只渲染当前行，不渲染歌词列表；其余底栏区域不受时间
 * 跳动影响（卡顿修复后底栏是渲染热区，别扩散订阅）。
 * 点击打开歌词全屏页（与「歌词」按钮等效入口）。
 *
 * 卡拉OK填充：LRC 只有行级时间戳，行内按「行起始 → 下一行起始」区间
 * 匀速插值出 --fill 百分比，CSS 侧用渐变裁字实现（含半个字的硬边界）。
 * 跨度封顶 8s——句尾长音/间奏不会把填充拖成 30s 爬坡。纯文本歌词
 * （time=NaN，永不高亮）与无歌词走 ♪ 占位，不做填充。
 */
export function NowLyricLine() {
  const uid = usePlayerStore(s => s.currentTrack?.uid)
  const currentTime = usePlayerStore(s => s.currentTime)
  const toggleLyrics = usePlayerStore(s => s.toggleLyrics)
  const { lines, activeIndex, hasLyric } = useLyrics(uid, currentTime)

  const current = hasLyric && activeIndex >= 0 ? lines[activeIndex] : null
  const lineText = current?.text ?? ''
  const text = lineText || '♪ ♪ ♪'

  let fill = 100
  if (current && lineText) {
    const start = current.time
    const next = lines[activeIndex + 1]?.time
    const span = Math.min(Math.max((next ?? start + 5) - start, 1), 8)
    fill = Math.min(1, Math.max(0, (currentTime - start) / span)) * 100
  }

  return (
    <div className="w-full max-w-xl px-1">
      <button
        onClick={toggleLyrics}
        className="group flex h-7 w-full items-center justify-center overflow-hidden md:h-9"
        aria-label="查看歌词"
        title="点击打开歌词"
      >
        {/* key=activeIndex：行切换时重挂载触发淡入上浮动画。
            有时间轴 → 卡拉OK渐变填充；否则灰色占位，投影保证叠频谱可读 */}
        <span
          key={activeIndex}
          style={lineText ? ({ '--fill': `${fill}%` } as CSSProperties) : undefined}
          className={`now-lyric-line max-w-full truncate text-base drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)] md:text-lg ${
            lineText ? 'now-lyric-karaoke' : 'text-foreground/60 transition-colors group-hover:text-foreground'
          }`}
        >
          {text}
        </span>
      </button>
    </div>
  )
}

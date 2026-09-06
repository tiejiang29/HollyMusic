
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
 * 有歌词 → 加粗主题绿（叠频谱背景仍可读，保留投影）；无时间轴的
 * 纯文本歌词（time=NaN 永不高亮）与无歌词走灰色 ♪ 占位。
 * （曾做过行内匀速插值的卡拉OK填充，但 LRC 只有行级时间戳，停顿
 * 也被计入导致填充明显滞后于演唱，已回退。）
 */
export function NowLyricLine() {
  const uid = usePlayerStore(s => s.currentTrack?.uid)
  const currentTime = usePlayerStore(s => s.currentTime)
  const toggleLyrics = usePlayerStore(s => s.toggleLyrics)
  const { lines, activeIndex, hasLyric } = useLyrics(uid, currentTime)

  const lineText = hasLyric && activeIndex >= 0 ? (lines[activeIndex]?.text ?? '') : ''
  const text = lineText || '♪ ♪ ♪'

  return (
    <div className="w-full max-w-xl px-1">
      <button
        onClick={toggleLyrics}
        className="group flex h-7 w-full items-center justify-center overflow-hidden md:h-9"
        aria-label="查看歌词"
        title="点击打开歌词"
      >
        {/* key=activeIndex：行切换时重挂载触发淡入上浮动画 */}
        <span
          key={activeIndex}
          className={`now-lyric-line max-w-full truncate text-base font-bold drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)] md:text-lg ${
            lineText ? 'text-primary' : 'text-foreground/60'
          }`}
        >
          {text}
        </span>
      </button>
    </div>
  )
}

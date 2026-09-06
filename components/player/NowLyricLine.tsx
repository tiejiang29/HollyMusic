
import { usePlayerStore } from '@/lib/store/player-store'
import { useLyrics } from '@/hooks/useLyrics'

/**
 * 底栏当前歌词行（渲染于 PlayerControls 顶部，替代原频谱位）。
 *
 * 性能约束：本组件是底栏唯一订阅 currentTime 的节点（每 ~250ms 重渲染），
 * 因此刻意做小——只取 activeIndex 对应行文本，不渲染歌词列表；
 * 其余底栏区域不受时间跳动影响（卡顿修复后底栏是渲染热区，别扩散订阅）。
 * 点击打开歌词全屏页（与「歌词」按钮等效入口）。
 */
export function NowLyricLine() {
  const uid = usePlayerStore(s => s.currentTrack?.uid)
  const currentTime = usePlayerStore(s => s.currentTime)
  const toggleLyrics = usePlayerStore(s => s.toggleLyrics)
  const { lines, activeIndex, hasLyric } = useLyrics(uid, currentTime)

  const line = hasLyric && activeIndex >= 0 ? lines[activeIndex]?.text : ''
  const text = line || '♪ ♪ ♪'

  return (
    <div className="w-full max-w-xl px-1">
      <button
        onClick={toggleLyrics}
        className="group flex h-7 w-full items-center justify-center overflow-hidden md:h-9"
        aria-label="查看歌词"
        title="点击打开歌词"
      >
        {/* key=activeIndex：行切换时重挂载触发淡入上浮动画。
            text-foreground/85 + 投影：叠在频谱背景层上仍保持可读 */}
        <span
          key={activeIndex}
          className="now-lyric-line max-w-full truncate text-xs text-foreground/85 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)] transition-colors group-hover:text-foreground md:text-sm"
        >
          {text}
        </span>
      </button>
    </div>
  )
}

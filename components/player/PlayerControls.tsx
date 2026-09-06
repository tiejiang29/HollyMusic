
import { TransportButtons } from './TransportButtons'
import { SeekBar } from './SeekBar'
import { QualityPopover } from './QualityPopover'
import { PlaybackModePopover } from './PlaybackModePopover'
import { NowLyricLine } from './NowLyricLine'

/**
 * 桌面端播放控制（仅渲染于桌面 footer 分支）。
 * 自上而下：当前歌词行、进度条、播放控制（频谱已降级为整条底栏的背景层）。
 */
export function PlayerControls() {
  return (
    <div className="flex flex-1 flex-col items-center gap-2">
      <NowLyricLine />
      <div className="flex w-full max-w-xl items-center gap-2">
        <SeekBar />
      </div>
      <div className="hidden items-center gap-2 md:flex">
        <PlaybackModePopover />
        <TransportButtons />
        <QualityPopover />
      </div>
      <div className="flex justify-center py-0.5 md:hidden">
        <TransportButtons size="sm" />
      </div>
    </div>
  )
}


import { TransportButtons } from './TransportButtons'
import { SeekBar } from './SeekBar'
import { QualityPopover } from './QualityPopover'
import { PlaybackModePopover } from './PlaybackModePopover'
import { AudioSpectrum } from './AudioSpectrum'

/**
 * 桌面端播放控制（仅渲染于桌面 footer 分支）。
 * 自上而下：频谱、进度条、播放控制。
 */
export function PlayerControls({ audio, isPlaying }: { audio: HTMLAudioElement | null; isPlaying: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-2">
      <div className="w-full max-w-xl px-1">
        <AudioSpectrum audio={audio} isPlaying={isPlaying} className="h-7 md:h-9" />
      </div>
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

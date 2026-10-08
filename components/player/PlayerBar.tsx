
import { useEffect, useRef } from 'react'
import { usePlayerStore } from '@/lib/store/player-store'
import { useAudioPlayer } from '@/hooks/useAudioPlayer'
import { useMediaSession } from '@/hooks/useMediaSession'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { NowPlaying } from './NowPlaying'
import { PlayerControls } from './PlayerControls'
import { PlayerTools } from './PlayerTools'
import { PlayerButton } from './PlayerButton'
import { AudioSpectrum } from './AudioSpectrum'
import { MobilePlayerMenu } from './MobilePlayerMenu'
import { useSpeakerCast } from '@/hooks/useSpeakerCast'
import { Mic2, ListMusic } from 'lucide-react'

interface PlayerBarProps {
  audio: HTMLAudioElement | null
  onAudioElement: (audio: HTMLAudioElement | null) => void
}

export function PlayerBar({ audio, onAudioElement }: PlayerBarProps) {
  const streamUrl = usePlayerStore(s => s.streamUrl)
  const isPlaying = usePlayerStore(s => s.isPlaying)
  const volume = usePlayerStore(s => s.volume)
  const isMuted = usePlayerStore(s => s.isMuted)
  const seekNonce = usePlayerStore(s => s.seekNonce)
  /** 投放态：本地引擎完全不参与（声音在音箱那边），分工见 player-store 顶部说明 */
  const casting = usePlayerStore(s => s.cast !== null)
  const toggleLyrics = usePlayerStore(s => s.toggleLyrics)
  const toggleQueue = usePlayerStore(s => s.toggleQueue)

  /**
   * loadSeq：每次 streamUrl 变化自增。
   * play/pause effect 用它判断 isPlaying 变化是否由「切歌」引起——
   * 若是，跳过本次 play()，由 load(autoplay=true) 接管，避免 Howler 叠加双实例。
   */
  const loadSeqRef = useRef(0)
  const skipNextPlayPauseRef = useRef(false)

  const { isReady, load, play, pause, seek, setVolume, setMuted } = useAudioPlayer({
    onAudioElement,
    // 投放态一律丢弃本地引擎的回调：本地那份 `<audio>` 还挂着上一首的 src，
    // 起投时它的 pause 事件会晚于 store 写入到达，把 isPlaying 按回 false，
    // 于是"音箱在放、按钮显示播放中"这种假状态就出来了（真机验证时看到过）。
    onTimeUpdate: t => {
      const s = usePlayerStore.getState()
      if (!s.cast) s.setCurrentTime(t)
    },
    onDuration: d => {
      const s = usePlayerStore.getState()
      if (!s.cast) s.setDuration(d)
    },
    onPlayState: p => {
      const s = usePlayerStore.getState()
      if (!s.cast) s.setIsPlaying(p)
    },
    onEnd: () => {
      const s = usePlayerStore.getState()
      if (!s.cast) s.handleTrackEnd()
    },
    onLoading: pct => {
      const s = usePlayerStore.getState()
      if (!s.cast) s.setBufferProgress(pct)
    },
    onError: (msg, errCode) => {
      const s = usePlayerStore.getState()
      if (!s.cast) s.handleTrackError(msg, errCode)
    },
  })

  // 投放态下轮询服务端会话，把进度与播放状态喂回 store
  useSpeakerCast()
  // 同步当前曲目到 MediaSession（锁屏/通知/耳机控制）
  useMediaSession()
  // PC 端全局键盘快捷键
  useKeyboardShortcuts()

  // streamUrl 变化 → 加载音频（load 内部决定是否 autoplay）
  useEffect(() => {
    if (!streamUrl || casting) return
    loadSeqRef.current++
    skipNextPlayPauseRef.current = true // 切歌引起的 isPlaying 变化由 load 接管
    void load(streamUrl, usePlayerStore.getState().isPlaying).then(() => {
      // 退出投放回来时带着"从这一秒接着放"的意图：必须等 load 完再跳，
      // 否则 readyState=0 时设 currentTime 会被浏览器拒绝，位置就丢了
      const resume = usePlayerStore.getState().pendingResumeSec
      if (resume != null && resume > 1) {
        usePlayerStore.setState({ pendingResumeSec: null })
        seek(resume)
      }
    })
  }, [streamUrl, casting, load, seek])

  // isPlaying 变化 → 播放/暂停
  useEffect(() => {
    // 暂停这一侧**任何时候都要落地**，而且必须排在 casting 闸门之前：
    // 进投放态就是靠 isPlaying=false 走到这里把本地声音收掉的（真机验证时我把闸门写在最前面，
    // 结果本地那首照旧播到 0:47，变成两边同时出声）。播放需等待就绪；暂停不能等待。
    if (!isPlaying) {
      skipNextPlayPauseRef.current = false
      void pause()
      return
    }
    // 投放态下 isPlaying 报的是**音箱**的状态，绝不能拿它去启动本地 <audio>：
    // 本地那份还挂着上一首的 src，一 play 就又是两边同时出声。
    if (casting) return
    // 切歌引起的那一次由 load(autoplay) 接管，别在这儿再 play 一遍叠成双实例
    if (skipNextPlayPauseRef.current) {
      skipNextPlayPauseRef.current = false
      return
    }
    if (isReady) void play()
  }, [isPlaying, isReady, play, pause, casting])

  useEffect(() => {
    setVolume(volume)
  }, [volume, setVolume])

  useEffect(() => {
    setMuted(isMuted)
  }, [isMuted, setMuted])

  // seek 指令 → 跳转（投放态的 seek 走服务端带偏移重推，本地没有可跳的对象）
  useEffect(() => {
    if (casting) return
    const t = usePlayerStore.getState().seekTarget
    if (t != null) seek(t)
  }, [seekNonce, seek, casting])

  return (
    <footer className="safe-area-bottom relative isolate flex flex-col gap-2 overflow-hidden border-t border-border bg-card px-3 py-3 md:min-h-[136px] md:flex-row md:items-center md:justify-between md:gap-4 md:px-4">
      {/* 频谱背景层：整条底栏底层淡显（歌词行占据了原频谱位，频谱降级为氛围背景）。
          -z-10 压到内容之下、父背景之上；pointer-events-none 不挡交互。 */}
      <div className="pointer-events-none absolute inset-0 -z-10 opacity-50" aria-hidden="true">
        <AudioSpectrum audio={audio} isPlaying={isPlaying} className="h-full w-full" />
      </div>
      {/* 单一 DOM 布局：桌面端横排三栏，移动端纵向排列。 */}
      <div className="flex items-center gap-1 md:contents">
        <NowPlaying />
        <div className="flex items-center md:hidden">
          <PlayerButton icon={Mic2} label="歌词" onClick={toggleLyrics} size="sm" />
          <PlayerButton icon={ListMusic} label="队列" onClick={toggleQueue} size="sm" />
          <MobilePlayerMenu />
        </div>
      </div>
      <PlayerControls />
      <PlayerTools />
    </footer>
  )
}

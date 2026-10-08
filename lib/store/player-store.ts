/**
 * 播放器全局状态（zustand）
 * 管理播放队列、当前曲目、播放状态、播放模式、UI 面板。
 * 音频引擎（原生 Audio）在 useAudioPlayer 中，由 PlayerBar 编排 store 与音频。
 *
 * 投放态（cast）的分工：**执行者从本地 <audio> 换成「音箱 + 服务端会话」**，store 的字段和
 * 动作一个不改 —— 播放栏、歌词、队列、锁屏 MediaSession 读写的还是 isPlaying/currentTime/
 * duration/seek/next()，所以组件几乎不用动。差别只有两处：
 * - `loadStreamUrl` 在投放态直接返回（不加载本地音频 ⇒ 本地不出声，也不占带宽）；
 * - `togglePlay / seek / next / previous / playTrack` 落到 `/api/speaker` 而不是音频引擎。
 * 连续播放（放完自动下一首）由**服务端看门狗**管：网页一隐藏，浏览器把计时器夹成一分钟
 * 才醒一次，那种亚分钟判据放不进标签页里（2026-10-08 实测）。
 */

import { create } from 'zustand'
import { toTrack, type Track, type PlaybackMode } from '@/lib/types/player'
import type { QualityType } from '@/lib/types/music'
import { buildAudioUrl, getTrackByUid } from '@/lib/api/music'
import { resolveQuality, nextLowerQuality } from '@/lib/quality-options'
import { detectCodecCap, capQuality } from '@/lib/codec-support'
import { reportPlay } from '@/lib/api/history'
import { useAuthStore } from '@/hooks/useAuth'
import { buildCastOrder, clampSpeakerVolume, syncCursorToUid, volumeSendDelayMs } from '@/lib/cast-queue'
import {
  controlSpeaker as castControl, seekCast as castSeekApi, skipCast as castSkipApi,
  setSpeakerPlaybackVolume, startCast as speakerStartCast, stopCast as speakerStopCast, updateCastRest,
  type CastView,
} from '@/lib/api/speaker'

/** 仅在已登录时上报播放历史，匿名跳过（/api/history 受保护） */
function reportPlayIfAuthed(musicInfo: Track['musicInfo']) {
  if (useAuthStore.getState().authenticated) {
    reportPlay(musicInfo).catch(() => {})
  }
}

// ---- 音质偏好持久化（项目无 zustand persist，直接读写 localStorage）----
const QUALITY_KEY = 'player:quality'
const VALID_QUALITIES: QualityType[] = ['128k', '320k', 'flac', 'flac24bit']
/** 默认音质（320k 平衡音质与带宽/缓存）；用户手动切换后以 localStorage 记忆为准 */
const DEFAULT_QUALITY: QualityType = '320k'

/** 可降级重试的浏览器 audio 错误码（MediaError）：3=DECODE 4=SRC_NOT_SUPPORTED。
 *  这两种通常是「浏览器解不了该格式」（典型：手机 WebView 解不了 FLAC），降一档换 MP3 即可播。
 *  用数字而非 MediaError 常量：store 模块 SSR 也会加载，Node 端无 MediaError 全局。 */
const DEGRADABLE_ERR_CODES = new Set([3, 4])
function loadStoredQuality(): QualityType {
  if (typeof window === 'undefined') return DEFAULT_QUALITY
  const q = window.localStorage.getItem(QUALITY_KEY) as QualityType | null
  return q && VALID_QUALITIES.includes(q) ? q : DEFAULT_QUALITY
}

// ---- 投放（cast）：音量发送节流（句柄同样放模块级，不进 store）----
// 一次 ubus 往返实测 0.34~0.46 秒，拖一格产生的中间值全发会排队并撞小米限流（70022）
let castVolumeLastSentAt = 0
let castVolumeTimer: ReturnType<typeof setTimeout> | null = null

const errMessageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** 投放要交给服务端的"播放顺序"就从现在的 store 状态里取，别的都不带 */
type QueueSnapshot = Pick<PlayerStore, 'queue' | 'playNextQueue' | 'currentIndex' | 'currentTrack' | 'playbackMode'>
const snapshotOf = (s: QueueSnapshot) => ({
  queue: s.queue, playNextQueue: s.playNextQueue, currentIndex: s.currentIndex,
  currentTrack: s.currentTrack, playbackMode: s.playbackMode,
})

/**
 * "下一首/上一首要落到哪一首"——与 next()/previous() 的消费规则一致：
 * 插播队列优先，主队列按游标前后挪。随机/循环由调用方决定怎么解释。
 */
function pickAdjacent(s: QueueSnapshot, delta: number): { track: Track; index: number; temp: boolean } | null {
  if (s.playNextQueue.length > 0) return { track: s.playNextQueue[0], index: s.currentIndex, temp: true }
  const len = s.queue.length
  if (len === 0 || s.currentIndex < 0) return null
  const i = delta > 0 ? (s.currentIndex + 1) % len : (s.currentIndex - 1 + len) % len
  return { track: s.queue[i], index: i, temp: false }
}

// ---- 睡眠定时器（句柄放模块级，避免进 store 触发重渲染）----
let sleepTimerHandle: ReturnType<typeof setTimeout> | null = null
const SLEEP_STEPS = [15, 30, 45, 60] // 分钟

interface PlayerStore {
  // 队列与当前
  queue: Track[]
  /** 手动插播队列（"下一首播放"插队头 / "加入队列"排队尾）。
   *  独立于主队列、优先于一切播放模式（对齐 Spotify "Next in queue" 与 LX tempPlayList）：
   *  随机/单曲循环都会先消费插播；播完即出队、不回流主队列；换列表播放时保留。 */
  playNextQueue: Track[]
  /** 当前曲是否来自插播队列（插播期间主队列 currentIndex 冻结，消费完毕回到冻结处继续） */
  isCurrentTempPlay: boolean
  currentIndex: number
  currentTrack: Track | null
  streamUrl: string | null
  isFetchingUrl: boolean
  urlFetchError: string | null
  /** 连续播放失败计数（自动跳歌防死循环） */
  errorRetryCount: number

  // 播放状态
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  isMuted: boolean
  playbackMode: PlaybackMode
  /** 当前播放音质（持久化到 localStorage） */
  quality: QualityType
  /** 当前歌曲实际播放音质（loadStreamUrl 时由 resolveQuality 算出，不持久化；无曲目时 null） */
  effectiveQuality: QualityType | null
  /** 浏览器原生解码能力上限（启动 canPlayType 探测得出）。
   *  loadStreamUrl 会用它再压一遍音质，避免请求已知解不了的高音质格式。仅内存，不持久化：
   *  浏览器更新后下次启动重新探测即可恢复。 */
  codecCap: QualityType
  /** 音频 blob 下载进度：0-100 表示下载中，null 表示未在下载 */
  bufferProgress: number | null
  /** 睡眠定时器：到点自动暂停；null 表示未启用 */
  sleepTimer: { minutes: number; expiresAt: number } | null
  /** 投放会话（服务端那份的镜像）；null = 没在投。投放态下进度/状态都以它为准 */
  cast: CastView | null
  /** 退出投放时让本地从这一秒接着放；由 PlayerBar 在本地 load 完成后消费一次 */
  pendingResumeSec: number | null

  // seek 指令（通过 nonce 触发音频 seek）
  seekTarget: number | null
  seekNonce: number

  // UI 面板
  isQueueOpen: boolean
  isLyricsOpen: boolean

  // 核心动作
  playTrack: (track: Track, queue?: Track[]) => Promise<void>
  loadStreamUrl: (track: Track, forceQuality?: QualityType) => Promise<void>
  /** 通过 uid 反查并播放（分享链接 ?uid= 自动播放用） */
  playByUid: (uid: string) => Promise<void>
  togglePlay: () => void
  setIsPlaying: (v: boolean) => void
  setCurrentTime: (t: number) => void
  setDuration: (d: number) => void
  setBufferProgress: (v: number | null) => void
  handleTrackError: (msg: string, errCode?: number) => void
  seek: (t: number) => void
  setVolume: (v: number) => void
  toggleMute: () => void
  cyclePlaybackMode: () => void
  setPlaybackMode: (m: PlaybackMode) => void
  setQuality: (q: QualityType) => void

  next: () => void
  previous: () => void
  handleTrackEnd: () => void

  // 队列操作
  addToQueue: (track: Track) => void
  addNext: (track: Track) => void
  removeFromPlayNext: (index: number) => void
  clearPlayNext: () => void
  /** 消费插播队列第 index 首并立即播放（next/handleTrackEnd 优先调 index 0；队列面板点击用） */
  playFromPlayNext: (index: number) => void
  removeFromQueue: (index: number) => void
  clearQueue: () => void

  // UI
  toggleQueue: () => void
  setQueueOpen: (v: boolean) => void
  toggleLyrics: () => void
  setLyricsOpen: (v: boolean) => void

  // 睡眠定时器
  cycleSleepTimer: () => void
  clearSleepTimer: () => void

  // 投放到音箱
  startCast: (deviceID?: string) => Promise<void>
  exitCast: (resumeLocal?: boolean) => Promise<void>
  /** 服务端会话报回来的状态落进 store（含"现在播的是哪首"的游标回写） */
  applyCastView: (view: CastView) => void
  applyCastSnapshot: (view: CastView | null) => void
  clearCast: () => void
  /** 两次轮询之间把进度往前推（隐藏页拿不到帧，本来也不需要进度条） */
  tickCastClock: (deltaSec: number) => void
  /** 音箱音量 0-100：按节流发送，界面值先乐观跟上 */
  setCastVolume: (raw: number | string) => void
  /** 队列变了就交出去（服务端等当前这首放完才生效，不打断正在播的） */
  syncCastOrder: () => void
  castMove: (delta: 1 | -1) => Promise<void>
}

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  queue: [],
  playNextQueue: [],
  isCurrentTempPlay: false,
  currentIndex: -1,
  currentTrack: null,
  streamUrl: null,
  isFetchingUrl: false,
  urlFetchError: null,
  errorRetryCount: 0,

  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 0.8,
  isMuted: false,
  playbackMode: 'sequence',
  quality: loadStoredQuality(),
  effectiveQuality: null,
  codecCap: detectCodecCap(),
  bufferProgress: null,
  sleepTimer: null,
  cast: null,
  pendingResumeSec: null,

  seekTarget: null,
  seekNonce: 0,

  isQueueOpen: false,
  isLyricsOpen: false,

  playTrack: async (track, newQueue) => {
    if (newQueue && newQueue.length > 0) {
      const idx = newQueue.findIndex(t => t.uid === track.uid)
      set({ queue: newQueue, currentIndex: idx >= 0 ? idx : 0 })
    } else {
      const existing = get().queue.findIndex(t => t.uid === track.uid)
      if (existing >= 0) {
        set({ currentIndex: existing })
      } else {
        set(s => ({ queue: [...s.queue, track], currentIndex: s.queue.length }))
      }
    }
    set({ currentTrack: track, isCurrentTempPlay: false, currentTime: 0, duration: 0, urlFetchError: null })
    if (get().cast) {
      // 投放中点了别的歌 = 换投这一首（服务端重推一窗，本地照旧不出声）
      await get().startCast(get().cast?.deviceID)
      return
    }
    await get().loadStreamUrl(track)
    reportPlayIfAuthed(track.musicInfo)
  },

  loadStreamUrl: async (track, forceQuality?) => {
    // 投放态：声音在音箱那边，本地引擎一个字节都不拉
    // （这一条护栏同时让"换曲/切音质就 load"的所有路径自动静音，不必逐个改调用方）
    if (get().cast) return
    // 前端按歌曲支持范围就近降级，URL 带准确音质 → 缓存键准确、UI 如实显示。
    // 服务端 getMusicUrl 仍保留降级作音源级兜底。
    // forceQuality：解码失败降级重试时强制指定（绕过用户偏好），见 handleTrackError。
    // codecCap：浏览器能力上限（启动 canPlayType 探测），把已知解不了的格式压掉，
    //          避免对不支持 FLAC 的浏览器反复请求 FLAC。
    const resolved = forceQuality ?? resolveQuality(get().quality, track.musicInfo.types)
    const eff = capQuality(resolved, get().codecCap)
    set({
      streamUrl: buildAudioUrl(track.uid, eff),
      effectiveQuality: eff,
      isFetchingUrl: false,
      isPlaying: true,
      bufferProgress: null,
    })
  },
  playByUid: async (uid) => {
    const { musicInfo } = await getTrackByUid(uid)
    await get().playTrack(toTrack({ uid, musicInfo }))
  },

  togglePlay: () => {
    const s = get()
    if (s.cast) {
      // 投放态的播/停是遥控音箱：命令回回来的会话状态才是真值，不做乐观翻转
      void castControl(s.cast.playing ? 'pause' : 'resume', s.cast.deviceID)
        .then(r => { if (r.casting) get().applyCastView(r.casting) })
        .catch(err => set({ urlFetchError: errMessageOf(err) }))
      return
    }
    console.log('[diag] togglePlay, isPlaying=', get().isPlaying)
    set(cur => (cur.currentTrack ? { isPlaying: !cur.isPlaying } : {}))
  },
  // 不在此处重置 errorRetryCount：解码失败常是「播一瞬间就挂」，play 事件已触发会把计数清零，
  // 导致连续失败上限永远达不到 → 无限循环跳歌。改由 setCurrentTime 在播放稳定(>5s)时重置。
  setIsPlaying: (v) => set(v ? { isPlaying: true } : { isPlaying: false }),
  setCurrentTime: (t) => set(s => {
    // 播放超过 5 秒视为「播放稳定」，重置连续失败计数（区分「真失败」与「稳定播放」）
    if (t > 5 && s.errorRetryCount > 0) return { currentTime: t, errorRetryCount: 0 }
    return { currentTime: t }
  }),
  setDuration: (d) => set({ duration: d }),
  setBufferProgress: (v) => set({ bufferProgress: v }),
  handleTrackError: (msg, errCode?) => {
    // 解码/格式不支持 → 仅对当前这首歌降一档重试（手机 WebView 常解不了 FLAC，降到 MP3 即可播）。
    // 降到最低档仍失败，才走下面的跳歌逻辑。网络错误(2)不降级（换格式无意义）。
    if (errCode !== undefined && DEGRADABLE_ERR_CODES.has(errCode)) {
      const { currentTrack, effectiveQuality } = get()
      const lower = effectiveQuality ? nextLowerQuality(effectiveQuality) : null
      if (currentTrack && lower) {
        // ponytail: 只对当前歌曲降级重试，不再全局下调 codecCap。
        // errCode 3/4 多是单首音源坏数据 / 网络截断 / 服务端返回非音频，而非浏览器能力不足；
        // 旧实现把瞬时失败误判为能力上限并只降不升，一次失败就把整会话压到 128k（即使用户 flac 优先）。
        // 浏览器能力探测交给启动时的 canPlayType（detectCodecCap），已足够覆盖真不支持 FLAC 的设备。
        console.warn(
          `[player] 解码失败(err=${errCode})，${effectiveQuality} → ${lower} 降级重试：${currentTrack.name}`
        )
        get().loadStreamUrl(currentTrack, lower)
        return
      }
    }

    const { queue, errorRetryCount } = get()
    // 连续失败上限：min(3, 队列长度)；队列只有 1 首时失败 1 次即停止，避免对同一首无限重试
    const limit = Math.max(1, Math.min(3, queue.length))
    if (errorRetryCount + 1 >= limit) {
      set({
        urlFetchError: `连续 ${limit} 首播放失败，已停止：${msg}`,
        isPlaying: false,
        isFetchingUrl: false,
        streamUrl: null,
        errorRetryCount: 0,
        bufferProgress: null,
      })
      return
    }
    set({ errorRetryCount: errorRetryCount + 1, isFetchingUrl: false })
    get().next()
  },
  seek: (t) => {
    const s = get()
    if (s.cast) {
      // 本地没有 <audio> 可跳：进度先乐观跟上，服务端带偏移重推完会用真实位置纠回来
      set({ currentTime: t, cast: { ...s.cast, posSec: t }, urlFetchError: null })
      void castSeekApi(t, s.cast.deviceID)
        .then(view => get().applyCastView(view))
        .catch(err => set({ urlFetchError: errMessageOf(err) }))
      return
    }
    set(cur => ({ currentTime: t, seekTarget: t, seekNonce: cur.seekNonce + 1 }))
  },
  setVolume: (v) => set({ volume: Math.max(0, Math.min(1, v)), isMuted: false }),
  toggleMute: () => set(s => ({ isMuted: !s.isMuted })),
  cyclePlaybackMode: () =>
    set(s => {
      const modes: PlaybackMode[] = ['sequence', 'loop', 'random']
      const i = modes.indexOf(s.playbackMode)
      return { playbackMode: modes[(i + 1) % modes.length] }
    }),
  setPlaybackMode: (m) => set({ playbackMode: m }),
  setQuality: (q) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(QUALITY_KEY, q)
    set({ quality: q })
    // 切音质需重建 streamUrl（不同音质独立缓存键）
    const { currentTrack } = get()
    if (currentTrack) get().loadStreamUrl(currentTrack)
  },

  next: () => {
    if (get().cast) { void get().castMove(1); return }
    // 插播队列优先：手动点"下一首"也先播"下一首播放"插进来的歌（Spotify 同款）
    if (get().playNextQueue.length > 0) {
      get().playFromPlayNext(0)
      return
    }
    const { queue, currentIndex, playbackMode } = get()
    if (queue.length === 0) return
    let nextIndex: number
    if (playbackMode === 'random' && queue.length > 1) {
      nextIndex = Math.floor(Math.random() * queue.length)
      if (nextIndex === currentIndex) nextIndex = (nextIndex + 1) % queue.length
    } else {
      nextIndex = (currentIndex + 1) % queue.length
    }
    const track = queue[nextIndex]
    set({ currentIndex: nextIndex, currentTrack: track, isCurrentTempPlay: false, currentTime: 0, duration: 0 })
    get().loadStreamUrl(track)
    reportPlayIfAuthed(track.musicInfo)
  },

  previous: () => {
    const { queue, currentIndex, currentTime, isCurrentTempPlay, cast } = get()
    if (cast) {
      // 与本地一致：已经播过 3 秒的"上一首"是回到当前这首的开头，不是换歌
      if (currentTime > 3) { get().seek(0); return }
      void get().castMove(-1)
      return
    }
    if (queue.length === 0) return
    if (currentTime > 3) {
      get().seek(0)
      return
    }
    // 插播中按上一首：回到主队列冻结游标处（插播前刚播的那首，LX 同款）
    const prevIndex = isCurrentTempPlay
      ? currentIndex
      : (currentIndex - 1 + queue.length) % queue.length
    if (prevIndex < 0 || prevIndex >= queue.length) return
    const track = queue[prevIndex]
    set({ currentIndex: prevIndex, currentTrack: track, isCurrentTempPlay: false, currentTime: 0, duration: 0 })
    get().loadStreamUrl(track)
    reportPlayIfAuthed(track.musicInfo)
  },

  handleTrackEnd: () => {
    // 投放态的续播归服务端看门狗（本地引擎根本没在播；真触发了也不该抢它的活）
    if (get().cast) return
    // 插播队列优先于一切模式：随机不跳过、单曲循环被打断、顺序播到队尾也不提前停止
    if (get().playNextQueue.length > 0) {
      get().playFromPlayNext(0)
      return
    }
    const { playbackMode, queue, currentIndex } = get()
    if (queue.length === 0) return
    if (playbackMode === 'loop') {
      // 单曲循环：回到开头重新播放（onEnd 已将 isPlaying 置 false，此处 true 触发播放）
      set({ currentTime: 0, seekTarget: 0, seekNonce: get().seekNonce + 1, isPlaying: true })
      return
    }
    if (playbackMode === 'sequence' && currentIndex >= queue.length - 1) {
      // 顺序播放到末尾：停止
      set({ isPlaying: false, currentTime: 0 })
      return
    }
    get().next()
  },

  /** 加入队列（Play Later 语义）：排到插播队列末尾，整体优先于主队列剩余歌曲。
   *  允许重复入队（Spotify/Apple/LX 一致），不做 uid 去重——去重会让列表内已存在的歌静默失效。 */
  addToQueue: (track) => {
    set(s => ({ playNextQueue: [...s.playNextQueue, track] }))
    get().syncCastOrder()
    // 播放器空闲时直接开播用户刚操作的这首（LX addTempPlayList 同款）
    if (!get().currentTrack) get().playFromPlayNext(get().playNextQueue.length - 1)
  },
  /** 下一首播放（Play Next 语义）：插到插播队列最前，后点的先播（Apple 同款） */
  addNext: (track) => {
    set(s => ({ playNextQueue: [track, ...s.playNextQueue] }))
    get().syncCastOrder()
    if (!get().currentTrack) get().playFromPlayNext(0)
  },
  removeFromPlayNext: (index) => {
    set(s => ({ playNextQueue: s.playNextQueue.filter((_, i) => i !== index) }))
    get().syncCastOrder()
  },
  clearPlayNext: () => {
    set({ playNextQueue: [] })
    get().syncCastOrder()
  },
  playFromPlayNext: (index) => {
    const { playNextQueue } = get()
    const track = playNextQueue[index]
    if (!track) return
    // 主队列 currentIndex 冻结不动：插播消费完毕后 next() 从冻结位置继续主队列
    set({
      playNextQueue: playNextQueue.filter((_, i) => i !== index),
      currentTrack: track,
      isCurrentTempPlay: true,
      currentTime: 0,
      duration: 0,
    })
    get().loadStreamUrl(track)
    reportPlayIfAuthed(track.musicInfo)
    get().syncCastOrder()
  },
  removeFromQueue: (index) =>
    set(s => {
      if (index < 0 || index >= s.queue.length) return {}
      const newQueue = s.queue.filter((_, i) => i !== index)
      if (index < s.currentIndex) {
        return { queue: newQueue, currentIndex: s.currentIndex - 1 }
      }
      if (index === s.currentIndex) {
        // 插播期间移除的是主队列冻结游标处的歌（并非正在播的曲）：只回退游标，不打断插播
        if (s.isCurrentTempPlay) {
          return { queue: newQueue, currentIndex: s.currentIndex - 1 }
        }
        // 移除当前曲目：清空播放状态（顺带修预存 bug——原实现留下指向已移除曲目的 streamUrl）
        return {
          queue: newQueue,
          currentIndex: -1,
          currentTrack: null,
          effectiveQuality: null,
          streamUrl: null,
          isPlaying: false,
          bufferProgress: null,
        }
      }
      return { queue: newQueue }
    }),
  clearQueue: () => {
    // 清空队列 = 投放也该退出（不接着放本地，因为用户本意就是"都别播了"）
    if (get().cast) void get().exitCast(false)
    set({
      queue: [],
      playNextQueue: [],
      isCurrentTempPlay: false,
      currentIndex: -1,
      currentTrack: null,
      streamUrl: null,
      isFetchingUrl: false,
      urlFetchError: null,
      errorRetryCount: 0,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      effectiveQuality: null,
      bufferProgress: null,
    })
  },

  startCast: async (deviceID) => {
    const s = get()
    const order = buildCastOrder(snapshotOf(s))
    if (!order) { set({ urlFetchError: '先选一首歌再投到音箱' }); return }
    // 先收掉本地声音：streamUrl 置空让引擎不再加载，isPlaying=false 让 PlayerBar 去 pause 当前这首
    set({ streamUrl: null, isPlaying: false, bufferProgress: null, urlFetchError: null, pendingResumeSec: null })
    try {
      const view = await speakerStartCast({ ...order, deviceID: deviceID ?? s.cast?.deviceID })
      // 在播与否一律照服务端会话说的走：它已经处理了"刚推完还没读到状态"那一段（见 cast-session 的 buildView），
      // 在这里再乐观一次只会两边打架
      set(st => ({
        cast: view,
        isPlaying: view.playing,
        currentTime: view.posSec,
        duration: view.durSec > 0 ? view.durSec : st.duration,
      }))
    } catch (err) {
      set({ urlFetchError: errMessageOf(err) })
      throw err
    }
  },

  exitCast: async (resumeLocal = true) => {
    const s = get()
    const pos = s.cast?.posSec ?? 0
    const track = s.currentTrack
    const deviceID = s.cast?.deviceID
    set({ cast: null, urlFetchError: null })
    try {
      await speakerStopCast(deviceID)
    } catch (err) {
      // 停不掉就当它已经停了：别让一条失败的 stop 把用户关在投放态里出不来
      console.warn('[player] 退出投放时停音箱失败:', errMessageOf(err))
    }
    if (resumeLocal && track) {
      set({ pendingResumeSec: pos })
      await get().loadStreamUrl(track)
    }
  },

  applyCastView: (view) => {
    const s = get()
    const patch: Record<string, unknown> = {
      cast: view,
      isPlaying: view.playing,
      currentTime: view.posSec,
      duration: view.durSec > 0 ? view.durSec : s.duration,
    }
    // 设备自己播到下一首了：把界面游标挪过去（封面/歌词/队列高亮都跟着走）
    if (s.currentTrack?.uid !== view.uid) {
      const synced = syncCursorToUid(snapshotOf(s), view.uid)
      if (synced) Object.assign(patch, synced)
    }
    set(patch as never)
  },

  applyCastSnapshot: (view) => {
    if (!view) {
      get().clearCast()
      return
    }
    get().applyCastView(view)
  },

  clearCast: () => set({ cast: null, isPlaying: false }),

  tickCastClock: (deltaSec) => set(s => {
    // 只在投放且真在播时推进：轮询间隔里靠它把进度条走顺，下一次轮询再 snap 回真值
    if (!s.cast?.playing || !s.isPlaying) return {}
    const limit = s.duration > 0 ? s.duration : Number.POSITIVE_INFINITY
    return { currentTime: Math.min(limit, s.currentTime + deltaSec) }
  }),

  setCastVolume: (raw) => {
    const s = get()
    if (!s.cast) return
    const v = clampSpeakerVolume(raw, s.cast.volume)
    if (v === s.cast.volume) return
    const deviceID = s.cast.deviceID
    set({ cast: { ...s.cast, volume: v } })
    if (castVolumeTimer) {
      clearTimeout(castVolumeTimer)
      castVolumeTimer = null
    }
    const push = (value: number) => {
      castVolumeLastSentAt = Date.now()
      void setSpeakerPlaybackVolume(value, deviceID).catch(err => set({ urlFetchError: errMessageOf(err) }))
    }
    const delay = volumeSendDelayMs(Date.now(), castVolumeLastSentAt)
    if (delay === null) push(v)
    else castVolumeTimer = setTimeout(() => { castVolumeTimer = null; push(v) }, delay)
  },

  syncCastOrder: () => {
    const s = get()
    if (!s.cast) return
    const order = buildCastOrder(snapshotOf(s))
    // 单曲循环本来就只播这一首，队列改动不影响它；没有当前曲也无需同步
    if (!order || order.loopOne) return
    void updateCastRest(order.rest, s.cast.deviceID)
      .then(view => set({ cast: view }))
      .catch(err => set({ urlFetchError: errMessageOf(err) }))
  },

  castMove: async (delta) => {
    const s = get()
    if (!s.cast) return
    if (s.playbackMode === 'loop') {
      // 单曲循环下点下一首 = 换一首继续循环：会话里只有这一首，服务端 skip 无处可走，直接重投
      const target = pickAdjacent(snapshotOf(s), delta)
      if (!target) return
      if (target.temp) {
        set(st => ({
          playNextQueue: st.playNextQueue.filter(t => t.uid !== target.track.uid),
          currentTrack: target.track,
          isCurrentTempPlay: true,
          currentTime: 0,
        }))
      } else {
        set({ currentTrack: target.track, currentIndex: target.index, currentTime: 0, isCurrentTempPlay: false })
      }
      await get().startCast(s.cast.deviceID)
      return
    }
    try {
      get().applyCastView(await castSkipApi(delta, s.cast.deviceID))
    } catch (err) {
      const msg = errMessageOf(err)
      set({ urlFetchError: msg })
      // 服务端说"放完了/会话没了"，界面就不该再装作在投
      if (/放完|没有投放会话/.test(msg)) get().clearCast()
    }
  },

  toggleQueue: () => set(s => ({ isQueueOpen: !s.isQueueOpen })),
  setQueueOpen: (v) => set({ isQueueOpen: v }),
  toggleLyrics: () => set(s => ({ isLyricsOpen: !s.isLyricsOpen })),
  setLyricsOpen: (v) => set({ isLyricsOpen: v }),

  cycleSleepTimer: () => {
    const cur = get().sleepTimer
    const nextMinutes = !cur
      ? SLEEP_STEPS[0]
      : SLEEP_STEPS.indexOf(cur.minutes) >= SLEEP_STEPS.length - 1
        ? null
        : SLEEP_STEPS[SLEEP_STEPS.indexOf(cur.minutes) + 1]
    if (sleepTimerHandle) { clearTimeout(sleepTimerHandle); sleepTimerHandle = null }
    if (nextMinutes === null) {
      set({ sleepTimer: null })
      return
    }
    const ms = nextMinutes * 60_000
    sleepTimerHandle = setTimeout(() => {
      // 走 togglePlay 而不是直接翻 isPlaying：投放态下那才会真的把音箱暂停
      const st = usePlayerStore.getState()
      if (st.isPlaying) st.togglePlay()
      usePlayerStore.setState({ sleepTimer: null })
      sleepTimerHandle = null
    }, ms)
    set({ sleepTimer: { minutes: nextMinutes, expiresAt: Date.now() + ms } })
  },
  clearSleepTimer: () => {
    if (sleepTimerHandle) { clearTimeout(sleepTimerHandle); sleepTimerHandle = null }
    set({ sleepTimer: null })
  },
}))

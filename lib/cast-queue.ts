/**
 * 投放顺序的算法（纯函数，不放 React 里）：把播放器的队列状态换算成"交给服务端的那份播放顺序"。
 *
 * 为什么单独拆出来：这份逻辑要和 `player-store` 里 `next()`/`handleTrackEnd()` 的判断**保持一致**
 * （插播优先、单曲循环、随机、顺序播到队尾就停），但它一旦混在 store 的 action 里就没法测。
 * 服务端拿到的是**结果顺序**，它自己不需要知道播放模式 —— 亚分钟的续播判据也因此在服务端，
 * 不受浏览器隐藏标签页"一分钟才醒一次"的限制。
 */

import type { PlaybackMode, Track } from '@/lib/types/player'

export interface CastItem {
  uid: string
  /** 秒；0 = 不知道（服务端会用设备报上来的时长兜） */
  durSec: number
}

export interface CastOrder {
  /** 现在就要播的这一首 */
  current: CastItem
  /** 之后依次播的顺序（随机模式在这里已经被冻结成一份确定列表） */
  rest: CastItem[]
  /** 单曲循环：只推这一首，让设备自己循环（服务端不许在窗尾补推或收口） */
  loopOne: boolean
}

export interface QueueSnapshot {
  queue: Track[]
  playNextQueue: Track[]
  currentIndex: number
  currentTrack: Track | null
  playbackMode: PlaybackMode
}

const toCastItem = (t: Track): CastItem => ({
  uid: t.uid,
  durSec: Number.isFinite(t.duration) && t.duration > 0 ? Math.round(t.duration) : 0,
})

/**
 * Fisher-Yates：rng 可注入（默认 Math.random），否则"随机顺序"这条没法写断言。
 * 交出去的是一份**确定列表** —— 服务端只会照着往下播，不会每次自己重新摇。
 */
export function shuffled<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/**
 * 算出"从当前这首起，接下来该播什么"。
 *
 * 与 `player-store` 的消费顺序对齐：
 * - **插播队列优先于一切模式**（`next()`/`handleTrackEnd()` 都是先吃它），所以它整个排在前面；
 * - 单曲循环不交 rest —— 只剩当前这首，靠设备对这一窗的从头循环来实现"循环"；
 * - 随机把剩下的摇一次定下来（不是每首播完再摇：那样服务端要重新拿顺序，也就丢了"关掉页面也照播"）；
 * - 顺序模式播到队尾就交空表 —— 服务端据此收口停掉音箱，而不是从头再来。
 */
export function buildCastOrder(
  snap: QueueSnapshot,
  opts: { random?: () => number } = {},
): CastOrder | null {
  const current = snap.currentTrack
  if (!current) return null
  const temp = snap.playNextQueue.filter(t => t.uid !== current.uid).map(toCastItem)
  if (snap.playbackMode === 'loop') {
    return { current: toCastItem(current), rest: [], loopOne: true }
  }
  const main = snap.queue.map(toCastItem).filter(t => t.uid !== current.uid)
  const tail = snap.playbackMode === 'random'
    ? shuffled(main, opts.random ?? Math.random)
    // 顺序播放：从当前游标往后，播到队尾就没了（服务端会在队尾 stop，不会从头循环）
    : main.slice(Math.max(0, cursorAfterCurrent(snap)))
  return { current: toCastItem(current), rest: [...temp, ...tail], loopOne: false }
}

/**
 * "当前这首之后的第一首"在去掉当前曲后的队列里排第几。
 * currentIndex 指的是原队列的下标；剔掉当前曲之后，它后面的那些整体往前挪一格。
 */
function cursorAfterCurrent(snap: QueueSnapshot): number {
  const idx = snap.currentIndex
  if (idx < 0) return 0
  return snap.queue.slice(0, idx).filter(t => t.uid !== snap.currentTrack?.uid).length
}

/**
 * 音箱报回来的游标（现在播哪首）落回前端队列：找到就挪游标，插播队列里那份消费掉。
 * 返回要写进 store 的补丁；认不出来（服务端播的头一次被前端改掉的歌）就返回 null，什么都不动。
 */
export function syncCursorToUid(
  snap: QueueSnapshot, uid: string,
): { currentIndex: number; currentTrack: Track; playNextQueue?: Track[] } | null {
  const inQueue = snap.queue.findIndex(t => t.uid === uid)
  if (inQueue >= 0) return { currentIndex: inQueue, currentTrack: snap.queue[inQueue] }
  const tempIdx = snap.playNextQueue.findIndex(t => t.uid === uid)
  if (tempIdx >= 0) {
    // 插播的那首开始播了 = 消费掉它（与本地播放器 playFromPlayNext 同一语义）
    return {
      currentIndex: snap.currentIndex,
      currentTrack: snap.playNextQueue[tempIdx],
      playNextQueue: snap.playNextQueue.slice(tempIdx + 1),
    }
  }
  return null
}

/**
 * 拖动音量条时的最小发送间隔（毫秒）。
 * 一次 ubus 往返实测 0.34~0.46 秒，拖一格会产生几十个中间值，
 * 全发既排队又容易撞小米限流（70022），所以按间隔发、松手那下必发。
 */
export const VOLUME_SEND_INTERVAL_MS = 250

/** 距上次发出还要等多久（null = 现在就发）。 */
export function volumeSendDelayMs(
  now: number, lastSentAt: number, interval: number = VOLUME_SEND_INTERVAL_MS,
): number | null {
  const left = interval - (now - lastSentAt)
  return left > 0 ? left : null
}

/** 音箱音量 0-100：夹档并取整（非数字保持原值，别把 NaN 发给小米） */
export function clampSpeakerVolume(raw: unknown, previous: number): number {
  // 空值/空串当"这次没给"：JS 里 Number('') === 0，不挡掉就会把音量误设成 0（等于静音）
  if (raw === null || raw === undefined || raw === '') return previous
  const n = Number(raw)
  if (!Number.isFinite(n)) return previous
  return Math.min(100, Math.max(0, Math.round(n)))
}

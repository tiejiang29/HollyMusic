/**
 * 投放会话（G2 第一块）：一台音箱一份，内存态，由路由侧持有。
 *
 * 为什么要它：网页标签页一隐藏，浏览器就把计时器夹成**一分钟只醒一次**（2026-10-08 实测），
 * "提前 3 秒推下一首"这种亚分钟判据放不进前端。而真机实测两件事凑成了另一条路：
 * 1. `player_play_music` 的 `audio_items` 是数组，**设备会按顺序自己播完**（推 10 项时边界处新项已经跑到 pos=3s）；
 * 2. 但一批放完它会**从头循环**（`player_set_loop` 只有单曲/列表/随机三档，没有"不循环"）。
 *
 * 于是分工：**连播交给设备，尾巴交给我们**。一次推一窗（10 首），看门狗只在这窗最后一项快放完时动手 ——
 * 补推下一窗，或者整条队列见底就 stop。
 *
 * 四条实测口径决定了实现的形状：
 * - **重推会让那一项从 0 起播** ⇒ 补推只能卡边界；拖动位置靠"带 `seek` 偏移重推"，
 *   而且**剩余项必须一起重排**，否则重推一次就把连播丢了。
 * - `play_song_detail.audio_id` **原样回显我们填的值** ⇒ 它就是"播到窗里第几项"的游标。
 * - 设备报的 `duration` 是**当前项**的时长，不是整窗的。
 * - **动手那 0.5 秒靠"定点睡到边界"命中，不靠快轮询去撞**（2026-10-09 真机：接管那一首放完
 *   从头循环 —— 只投一首时没有下一窗来盖它，错过一次边界就等于多响一整首）。
 *
 * 会话是内存态：进程一重启就没了（音箱会一直循环最后一窗）。这是有意接受的代价 ——
 * 持久化会引出"重启后该从哪首接上"的更难问题，而这台 NAS 只有单容器。
 */
import { logger } from '@/lib/logger'
import { ensureFreshCredentials, readSpeakerConfig, type SpeakerConfig } from '@/lib/services/xiaomi/token-store'
import { buildStreamBase, buildStreamUrl, pickDevice, SpeakerError } from '@/lib/services/xiaomi/speaker-play'
import {
  getPlayStatus, playItems, playerOperation, PLAY_STATUS_PLAYING,
  type PlayItem, type PlayStatus,
} from '@/lib/services/xiaomi/mina-client'

/** 一窗推多少首：够放约 40 分钟，报文才 4KB，且都落在 `st` 令牌 2 小时时效之内 */
export const CAST_WINDOW_SIZE = 10
/** 一次投放最多带多少首（1200 首的歌单取前 300，够放十几个小时） */
export const CAST_MAX_TRACKS = 300
/** 常规轮询间隔 */
const POLL_MS = 5000
/** 只剩窗里最后一项且快到时，加密到这个间隔（服务端不受浏览器后台节流限制） */
const TAIL_POLL_MS = 1000
/** 剩余不足这么多秒就动手：宁可让下一首前奏多重一点，也不掐掉当前这首的尾巴 */
const TAIL_GUARD_SEC = 0.5
/**
 * 还剩这么多秒以上照常轮询，进了这一段就**一次睡到边界前**（不再用固定间隔去撞）。
 * 治的是真机看到的"接管那一首放完从头循环"：`remaining` 是外推的，所以每一拍算出的数都准，
 * 坏在**两拍之间**设备已经放完转回头、下一读位置变成小值 ⇒ 剩余重新涨回去，从此再也撞不中，
 * 而只投一首时没有下一窗来盖它 —— 一首 4 分钟的歌要多响 4 分钟。
 */
const TAIL_ARM_SEC = 8
/**
 * "位置回跳"至少要已经播了这么久才算"从头循环"。定在 30 秒的依据是那条 5.1 秒挂断重拉：
 * 设备在**起播那阵子**拉不到字节会自己重拉、位置同样归零，可那时候绝不可能已经播了 30 秒。
 */
const LOOP_MIN_PLAYED_MS = 30_000
/** 刚推完的宽限期：设备起播有延迟，这期间读到"停了"不算停 */
const PUSH_GRACE_MS = 8000
/**
 * 收口要**复核**，不能发完 stop 就算完（2026-10-10 真机）。
 *
 * 原来 `advance()` 见底就是「stop + 清会话」一气呵成，结果那一次 stop 打在
 * "批放完 ⇒ 设备自己重拉开新一轮"的缝里：日志发了 stop，**0.26 秒后它又来拉了一次流**，
 * 之后每约 4.8 分钟一次 —— 而我们已经把会话清了，看门狗连同"位置回跳"那条兜底一起消失，
 * 再没人回头看一眼，用户听到的就是"一直重播"。
 *
 * 现在收口是个小状态机：发一声 stop，隔 `CLOSE_GAP_MS` 读一次状态，**还在播就补发**，
 * 最多 `CLOSE_MAX_TRIES` 次；确认停了（或次数用尽）才清会话。
 */
const CLOSE_GAP_MS = 2000
const CLOSE_MAX_TRIES = 3
/** 连续推失败这么多次就收手（设备拉不到流时无限重推只会把小米打爆） */
const MAX_PUSH_FAILS = 3
/** 元数据和设备都没给时长时的兜底（只影响"何时算到边界"，不影响听感） */
const UNKNOWN_DUR_SEC = 240
/** 上一首要靠它；记这么多条够了 */
const HISTORY_MAX = 50

export interface CastTrack {
  uid: string
  /** 秒；0 = 不知道 */
  durSec: number
}

/** 窗里的一格。`audioId` 是我们编的，设备回显它 ⇒ 它同时是游标 */
interface WindowSlot extends CastTrack {
  audioId: string
  url: string
  /** 这一格是从第几秒开始推的（只有带 seek 重推时第一项才非 0） */
  seekSec: number
  /** 设备报过的这一项时长，元数据缺时用它 */
  deviceDurSec?: number
}

export interface CastView {
  deviceID: string
  deviceName: string
  hardware: string
  /** 正在播的这一首 */
  uid: string
  /** 这一项内的位置（秒，含重推时的起始偏移） */
  posSec: number
  /** 这一项的总长（秒） */
  durSec: number
  playing: boolean
  /** 设备状态码：1=在播 2=暂停 0=停了 -1=读不到 */
  status: number
  /** 0-100，-1 = 没读到 */
  volume: number
  /** 已经推给设备的那一窗有几首 */
  windowSize: number
  /** 队列里还有几首没推给设备（不含当前窗） */
  pendingTracks: number
  lastError: string | null
}

interface Session {
  deviceID: string
  deviceName: string
  hardware: string
  window: WindowSlot[]
  /** 设备当前在播窗里的第几格 */
  playingIdx: number
  /** 之后的播放顺序（由调用方按播放模式算好，随机已被冻结成一份列表） */
  rest: CastTrack[]
  /** rest 里已经推给设备的部分 */
  cursor: number
  /** 播过的（倒序，[0] 是"上一首"） */
  history: CastTrack[]
  /** 当前窗里已经记进 history 的边界（同一批只记一次，别把 tick 记过的再记一遍） */
  recordedIdx: number
  /** 投放期间用户改了队列：当前这首放完生效 */
  pendingRest: CastTrack[] | null
  /** 单曲循环：窗里只有这一首，**让它自己循环**，我们既不补窗也不收口 */
  loopOne: boolean
  /**
   * 收口中：已经发过 stop，正在"回读确认它真的停了"这几拍里。
   * 这期间不补窗、不判边界，只做"还在播就补发 stop / 确认停了就清会话"。
   */
  closing: boolean
  /** 这次收口一共发过几声 stop（含第一声） */
  stopTries: number
  pushedAt: number
  lastStatus: PlayStatus | null
  lastStatusAt: number
  /** 上面那一拍读到的**是不是我们的流**（audio_id 认得出来）—— 认不出来时它的位置不是我们的进度 */
  lastStatusIsOurs: boolean
  /** 暂停时定住的位置（这一项内已播秒数） */
  pausedWithinItem: number | null
  timer: ReturnType<typeof setTimeout> | null
  ticking: boolean
  pushFails: number
  lastError: string | null
}

/**
 * 会话表与 audio_id 计数器挂 `globalThis`，理由与对话监视器那条一样（那里记着实测后果）：
 * 模块被热重载/打包复制成几份时，**每份各有一个看门狗在推同一台音箱**，同一句话会被并行副本
 * 各投一次；`audio_id` 也靠自增序号保证唯一，两份各有各的计数就会撞号。
 */
interface CastRuntime { sessions: Map<string, Session>; audioSeq: number }
const globalWithRt = globalThis as typeof globalThis & { __xiaomiCastSession?: CastRuntime }
const rt: CastRuntime = globalWithRt.__xiaomiCastSession ??= { sessions: new Map<string, Session>(), audioSeq: 0 }

/** audio_id：够短、唯一、纯数字串（设备只认形状，回显原样） */
function nextAudioId(): string {
  rt.audioSeq += 1
  return `${Date.now()}${String(rt.audioSeq % 1000).padStart(3, '0')}`
}

/**
 * 把"已经播完的那些"记进 history。
 * 传的必须是**换窗之前的旧窗**：`pushWindow` 一执行 `s.window` 就是新窗了，
 * 事后再去 slice 会把"接下来要播的歌"当成播过的，"上一首"于是跳到错误的歌上。
 */
function recordPlayed(s: Session, oldWindow: WindowSlot[], from: number, to: number): void {
  for (const t of oldWindow.slice(from, to)) s.history.unshift({ uid: t.uid, durSec: t.durSec })
  s.history = s.history.slice(0, HISTORY_MAX)
}

function startInWindow(window: WindowSlot[], uid: string): number {
  const i = window.findIndex(t => t.uid === uid)
  return i < 0 ? 0 : i
}

function playingSlot(s: Session): WindowSlot {
  const i = Math.min(Math.max(s.playingIdx, 0), Math.max(0, s.window.length - 1))
  return s.window[i]
}

/** 这一项多长：元数据 > 设备报过的 > 当前实时读到的 > 兜底 */
/**
 * 这一项的总长（收口边界要用）。**取"我们传的那份"与"设备报的那份"里大的那个**。
 *
 * 为什么不是"直接信设备那份"（2026-10-11 我自己一度这么判，前端那发干净数据把它否了）：
 * 设备的 `duration` 到底在哪个坐标空间里**并不固定** —— 同一首（库里 205）它报 **213.7**（整曲），
 * 另一首 tx 那条（库里 246）它报 **199.5**（看着就像"我们推下去那段的剩余"）。
 * 而边界算式是 `剩余 = 总长 − 起点 − 已播`，`已播` 是从**这次推流**起算的：
 * 一旦设备那份是"剩余"，拿它当总长就等于把起点减了两遍 ⇒ **提前收口、掐掉尾巴**，
 * 那是用户明确不能忍的一侧（"宁可下一首前奏多重约 1 秒，也不掐当前这首"）。
 * 取大值则两种空间下都不会提前；设备报 0/不报（-1）时退回我们那份。
 * 只信"这一拍是我们的流"的那份设备时长 —— 22:20 那次提前 243 秒收口就是外来的 duration 污染。
 */
function itemDurSec(s: Session, slot: WindowSlot): number {
  let device = slot.deviceDurSec && slot.deviceDurSec > 0 ? slot.deviceDurSec : 0
  if (s.lastStatusIsOurs && slot === playingSlot(s) && s.lastStatus && s.lastStatus.duration > 0) {
    device = Math.max(device, s.lastStatus.duration / 1000)
  }
  const both = Math.max(slot.durSec, device)
  return both > 0 ? both : UNKNOWN_DUR_SEC
}

/**
 * 这一拍读到的到底是不是**我们的流**。设备回显的 audio_id 就是游标（真机 2026-10-08 验过），
 * 所以"认不出这是哪一格"的那一拍，位置一律**不许当成我们的进度**。
 *
 * 这条是 2026-10-10 22:20 真机打出来的：推「播放邓紫棋的龙卷风」下去 **5.3 秒**，第一拍读到
 * position=**279 秒**，而那一格时长 248 秒（`interval="04:08"`，事后从 kw 真搜回来逐条核过）
 * ⇒ `剩余 = 248 - 279 = -31` ⇒ 判成"已经放完"、当场掐掉刚要点开的那首
 * （日志对得上：58.245 收口，**58.417 设备才开始拉我们的流**）。那 279 秒是设备当时还挂着的
 * **别的内容**（小爱回了「请欣赏龙卷风 试听版」，它自己那条）。
 */
function statusIsOurs(s: Session, st: PlayStatus): boolean {
  return s.window.some(x => x.audioId === st.audioId)
}

/**
 * 这一项**从它的流起点算**已经播了多少秒。
 * 设备每次读到都带绝对位置，两次轮询之间按墙钟外推（暂停期间不外推）；
 * 这台不报位置时（`position < 0`）、以及**这一拍读到的不是我们的流**时，只能整个按推入时刻起算
 * —— 走的是本来就有那条兜底路，不新增机制（理由见 `statusIsOurs`）。
 */
function playedWithinStream(s: Session): number {
  const st = s.lastStatus
  if (!st || st.position < 0) {
    if (st && st.status !== PLAY_STATUS_PLAYING) return s.pausedWithinItem ?? 0
    return Math.max(0, (Date.now() - s.pushedAt) / 1000)
  }
  if (!s.lastStatusIsOurs) return Math.max(0, (Date.now() - s.pushedAt) / 1000)
  if (st.status !== PLAY_STATUS_PLAYING) return s.pausedWithinItem ?? st.position / 1000
  return st.position / 1000 + (Date.now() - s.lastStatusAt) / 1000
}

/** 这一项还剩多少秒（考虑它是从中间开始推的） */
function remainingSec(s: Session): number {
  const slot = playingSlot(s)
  return itemDurSec(s, slot) - slot.seekSec - playedWithinStream(s)
}

function buildView(s: Session): CastView {
  const slot = playingSlot(s)
  const st = s.lastStatus
  // 刚推完、还没读到状态的这一段：**按"在播"报**。推歌指令被设备受理就等于要出声，
  // 这时报 playing=false 会让客户端把乐观态按回去，出现"音箱在唱、按钮显示播放中"的假状态
  // （2026-10-08 真机验证时看到过）。过了宽限期还是读不到，才如实报 -1/false。
  const grace = Date.now() - s.pushedAt < PUSH_GRACE_MS
  const playing = st ? st.status === PLAY_STATUS_PLAYING : grace
  const statusCode = st ? st.status : (grace ? PLAY_STATUS_PLAYING : -1)
  return {
    deviceID: s.deviceID,
    deviceName: s.deviceName,
    hardware: s.hardware,
    uid: slot.uid,
    posSec: Math.max(0, slot.seekSec + playedWithinStream(s)),
    durSec: itemDurSec(s, slot),
    playing,
    status: statusCode,
    volume: st ? st.volume : -1,
    windowSize: s.window.length,
    pendingTracks: Math.max(0, s.rest.length - s.cursor),
    lastError: s.lastError,
  }
}

async function signSlots(
  config: SpeakerConfig, base: string, tracks: CastTrack[], seekSec = 0,
): Promise<WindowSlot[]> {
  const quality = config.playQuality ?? '320k'
  return tracks.map((t, i) => ({
    uid: t.uid,
    durSec: Math.max(0, t.durSec || 0),
    audioId: nextAudioId(),
    // 只有第一项带 seek：后面的都是整首从头播
    seekSec: i === 0 ? seekSec : 0,
    url: buildStreamUrl(base, t.uid, quality, i === 0 ? seekSec : 0),
  }))
}

/** 窗里剩下那些接在新起点之后的顺序（去掉重起的这一首，按 uid 去重） */
function afterInWindow(s: Session, afterFrom: number, excludeUid: string): CastTrack[] {
  return s.window.slice(afterFrom).map(t => ({ uid: t.uid, durSec: t.durSec })).filter(t => t.uid !== excludeUid)
}

function dedupeTracks(items: CastTrack[], excludeUid: string): CastTrack[] {
  const seen = new Set(excludeUid ? [excludeUid] : [])
  const out: CastTrack[] = []
  for (const t of items) {
    if (!t.uid || seen.has(t.uid)) continue
    seen.add(t.uid)
    out.push(t)
  }
  return out
}

/** 推一窗给设备并接管会话状态：窗内容、游标、起播时刻都在这一步归零重来 */
async function pushWindow(s: Session, slots: WindowSlot[]): Promise<boolean> {
  const t0 = Date.now()
  const config = await readSpeakerConfig()
  const creds = await ensureFreshCredentials()
  const items: PlayItem[] = slots.map(x => ({ url: x.url, audioId: x.audioId }))
  const r = await playItems(creds, s.deviceID, items, s.hardware, {
    musicApiDisabled: config.musicApiDisabledModels,
  })
  if (!r.accepted) {
    s.pushFails += 1
    s.lastError = '音箱没认这条推歌指令（云端受理了但设备没执行）'
    logger.warn('[xiaomi] 投放窗口被设备拒了', { 音箱: s.deviceName, 连续失败: s.pushFails })
    return false
  }
  s.window = slots
  s.playingIdx = 0
  s.recordedIdx = 0
  // 肯推新一窗就是"要继续播"，收尾状态得跟着撤 —— 否则用户在收口那两秒里按了下一首，
  // 下一拍会被收尾分支当成"它又自己播起来了"，把我们刚推的东西又停掉
  s.closing = false
  s.stopTries = 0
  s.pushedAt = Date.now()
  s.pausedWithinItem = null
  s.pushFails = 0
  s.lastError = null
  s.lastStatus = null
  s.lastStatusAt = 0
  s.lastStatusIsOurs = false
  logger.info('[xiaomi] 投放窗口已推给音箱', {
    音箱: s.deviceName, 首数: slots.length, 当前: slots[0].uid,
    起点秒: Math.round(slots[0].seekSec), 批量: r.batched,
    // 这一段含"读配置 + 可能续票 + 一次 ubus"，是接管延迟里执行段的主要开销之一
    用时ms: Date.now() - t0,
  })
  if (!r.batched && slots.length > 1) {
    logger.warn('[xiaomi] 这台不认批量窗口，只播第一项，剩下的靠看门狗逐首补', { 型号: s.hardware })
  }
  return true
}

/**
 * 从某一首重起一窗，并把会话的账算清楚。
 *
 * `afterFrom`：窗里从第几格起继续排在它后面（默认是当前格的下一格；回上一首要从 0 起，
 *   因为"回去"意味着窗里这些还要再播一遍，不该丢）；
 * `historyUpTo`：窗里第几格之前（含）算"已经播过"进 history（默认是当前格；
 *   seek 与回上一首都传 -1 —— 它们没播完任何东西，塞进 history 会让"上一首"跳到错的歌上）。
 *
 * cursor 的账：新一窗从 `rest[cursor..]` 拿了几首，就把 cursor 推几首；
 * 窗里原有的那些不重复计（它们本来就在窗内，没占 rest 的额度）。
 */
async function replayFrom(
  s: Session, start: CastTrack,
  opts: { seekSec?: number; afterFrom?: number; historyUpTo?: number } = {},
): Promise<boolean> {
  const afterFrom = opts.afterFrom ?? s.playingIdx + 1
  const historyUpTo = opts.historyUpTo ?? s.playingIdx
  const tail = afterInWindow(s, afterFrom, start.uid)
  const need = Math.max(0, CAST_WINDOW_SIZE - 1 - tail.length)
  const source = s.pendingRest ?? s.rest
  const from = s.pendingRest ? 0 : s.cursor
  const restTake = need > 0 ? source.slice(from, from + need) : []
  const after = dedupeTracks([...tail, ...restTake], start.uid).slice(0, CAST_WINDOW_SIZE - 1)

  const config = await readSpeakerConfig()
  const base = buildStreamBase(config.serverHost)
  const slots = await signSlots(config, base, [start, ...after], opts.seekSec ?? 0)
  const oldWindow = s.window.slice(0)
  const recordFrom = s.recordedIdx
  if (!(await pushWindow(s, slots))) return false

  if (historyUpTo >= 0) {
    recordPlayed(s, oldWindow, recordFrom, Math.max(historyUpTo + 1, startInWindow(oldWindow, start.uid)))
    // 起点之前那些里若有恰好等于起点的，别留在 history 里（它马上还要再播一遍）
    s.history = s.history.filter(t => t.uid !== start.uid)
  }
  if (s.pendingRest) {
    s.rest = s.pendingRest
    s.pendingRest = null
    s.cursor = restTake.length
  } else {
    s.cursor = from + restTake.length
  }
  return true
}

/**
 * 到边界了：补下一窗，或者整条队列放完就收口。
 *
 * cursor 与 history **只在推成功之后才动** —— 提前挪的话，一次被设备拒掉的补推
 * 就会把这 10 首从时间线上抹掉（表现是"跳过了一段歌"，很难查）。
 *
 * 返回值给 `skipCast` 用：它按"用户点了下一首"调这里，切不出东西时要如实回 409。
 */
async function advance(s: Session): Promise<'closing' | 'moved' | 'noop'> {
  if (s.loopOne && s.pendingRest === null) return 'noop'   // 让它自己转，不收口也不补窗
  if (s.pendingRest) {
    s.rest = s.pendingRest
    s.cursor = 0
    s.pendingRest = null
    // 拿到新顺序就不再是"循环这一首"了，否则新窗放完又会从头循环
    s.loopOne = false
  }
  const take = s.rest.slice(s.cursor, s.cursor + CAST_WINDOW_SIZE)
  if (take.length === 0) {
    await beginClose(s)
    return 'closing'
  }
  const config = await readSpeakerConfig()
  const base = buildStreamBase(config.serverHost)
  const oldWindow = s.window.slice(0)
  const recordFrom = s.recordedIdx
  const playedTo = s.playingIdx + 1   // 到边界了，当前这首也算播完
  if (!(await pushWindow(s, await signSlots(config, base, take)))) return 'noop'
  s.cursor += take.length
  recordPlayed(s, oldWindow, recordFrom, playedTo)
  return 'moved'
}

/**
 * 队列放完：发**第一声** stop，然后进"收尾"状态 —— 会话先不清。
 *
 * 为什么不发完就清：真机实测一次 stop 会打在"批放完 ⇒ 设备自己重拉开新一轮"那条缝里
 * （日志发了 stop，0.26 秒后它又拉了一次流），而会话一清，看门狗和"位置回跳"兜底就一起
 * 消失了，再没人回头看 —— 用户听到的就是"一直重播"。确认交给 tick 里那几拍做。
 */
async function beginClose(s: Session): Promise<void> {
  logger.info('[xiaomi] 队列放完，停掉音箱（开始收尾，要回读确认）', { 音箱: s.deviceName })
  s.closing = true
  s.stopTries = 1
  await stopDevice(s)
  // 确认读在这儿排，不交给调用方：走到这里的有两条路 —— 看门狗自己到边界（它末尾会排程），
  // 以及**用户按下一首而队列已空**（`skipCast` 直接调 `advance`，手上根本没有那枚定时器）。
  // 只靠前一条，后一种收尾就永远等不到回读，直到客户端下次来问才被动复活。
  scheduleTick(s, CLOSE_GAP_MS)
}

async function stopDevice(s: Session): Promise<void> {
  try {
    const creds = await ensureFreshCredentials()
    await playerOperation(creds, s.deviceID, 'stop')
  } catch (err) {
    logger.warn('[xiaomi] 收口 stop 没成功:', err instanceof Error ? err.message.slice(0, 120) : String(err))
  }
}

/** 推完之后另起一次"起播确认"的等待：不等到下一拍，界面尽快有音量与在播状态 */
const PRIME_READ_MS = 1200

/**
 * 这一拍的读数是不是"同一个播放项里位置大段回跳"= 它已经从头循环了。
 *
 * 两种回跳要分开：**起播那阵子**设备拉不到字节会自己挂断重拉（实测 5.1 秒挂断、0.1 秒后重拉，
 * 位置同样从 0 起），那种该等它继续；**已经播了半首**之后再归零只剩"放完自己从头循环"一种解释。
 * 闸门取"上一拍至少走完这一项的一半（且不短于 `LOOP_MIN_PLAYED_MS`）"，**不取"离结尾多近"**——
 * 后者在元数据时长撒谎时（现成例子：`kw:440613 实际=224s 期望=304s`）正好失效，而那类歌真会停不下来；
 * "过半"这一档撒谎的例子仍然过得了（224/304 = 74%）。
 *
 * 为什么从"至少 30 秒"抬到"至少过半"（2026-10-10 23:07 真机）：「播放邓紫棋的天空没有极限」推下去
 * **11 秒**就被判成从头循环 —— 上一拍那份 `30 秒` 是**小爱试听版留在同一个 audio_id 上的残留位置**
 * （`是我们的读数` 已经是 true，所以 §4.7.2 那道"外来读数"闸门拦不住它），而这一项 279 秒。
 * 30 秒对 279 秒来说是刚接上，不是快放完。
 * ⚠ 残余的洞要认：真实长度**不到声明一半**的那种元数据撒谎，这道闸门会认不出、只能等定点或人来停。
 * （换窗/重推都会把 `lastStatus` 清成 null、设备自己在窗内换项则 `audio_id` 会变，
 * 这两种都比不出回跳；这条判据又只在 `mustAct` 那一拍被采纳，误判的爆炸半径限于窗里最后一项。）
 */
function sawLoopRestart(s: Session, st: PlayStatus): boolean {
  const prev = s.lastStatus
  const idx = s.window.findIndex(x => x.audioId === st.audioId)
  if (!(idx === s.playingIdx && idx >= 0 && prev && s.lastStatusIsOurs)) return false
  const floor = Math.max(LOOP_MIN_PLAYED_MS, itemDurSec(s, playingSlot(s)) * 1000 / 2)
  return prev.position >= floor && st.position >= 0 && st.position <= prev.position - 3000
}

/** 把一次状态回读落进会话（看门狗与起播确认共用这一份口径） */
function applyStatus(s: Session, st: PlayStatus): void {
  s.lastStatus = st
  s.lastStatusAt = Date.now()
  // 先定"这一拍是不是我们的流"，再动位置相关的账：认不出来的那一拍，它报的位置/时长都是**别的内容**的
  s.lastStatusIsOurs = statusIsOurs(s, st)
  if (st.status !== PLAY_STATUS_PLAYING) {
    s.pausedWithinItem = st.position >= 0 && s.lastStatusIsOurs ? st.position / 1000 : playedWithinStream(s)
  } else {
    s.pausedWithinItem = null
  }
  // 设备回显的 audio_id 就是游标：认不出来就维持上一拍的判断，不硬猜
  const idx = s.window.findIndex(x => x.audioId === st.audioId)
  if (idx >= 0 && idx !== s.playingIdx) {
    if (idx > s.playingIdx) {
      // 设备自己在窗内往后播了：中间这些算"播过了"，否则"上一首"回不到刚听过的那首
      recordPlayed(s, s.window, s.recordedIdx, idx)
      s.recordedIdx = idx
    }
    s.playingIdx = idx
  }
  if (st.duration > 0 && s.lastStatusIsOurs) {
    const slot = playingSlot(s)
    if (!slot.deviceDurSec) slot.deviceDurSec = st.duration / 1000
  }
}

/**
 * 起播确认：刚推完的一两秒里读一次状态。
 * 不等下一拍是因为 startCast 返回的视图里 volume=-1、playing=false 会让界面先显示
 * "没声音/音量未知"，用户会以为投失败了（G1 的回读就是为这个加的）。
 */
function primeStatus(s: Session): void {
  setTimeout(() => {
    void (async () => {
      if (!rt.sessions.has(s.deviceID)) return
      try {
        const creds = await ensureFreshCredentials()
        applyStatus(s, await getPlayStatus(creds, s.deviceID))
      } catch (err) {
        s.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 200)
      }
    })()
  }, PRIME_READ_MS)
}

function scheduleTick(s: Session, delayMs: number): void {
  if (s.timer) clearTimeout(s.timer)
  s.timer = setTimeout(() => { void tick(s) }, delayMs)
}

/**
 * 窗里最后一项的排程：离边界还远照常轮询，进了 `TAIL_ARM_SEC` 以内就**一次睡到边界前 0.3 秒**。
 * 下限取快轮询那一档（`TAIL_POLL_MS`），免得剩余已经很小却算出几十毫秒把自己变成忙等。
 */
function tailDelayMs(remaining: number): number {
  if (remaining > TAIL_ARM_SEC) return POLL_MS
  return Math.max(TAIL_POLL_MS, Math.round((remaining - 0.3) * 1000))
}

/**
 * 看门狗一拍：读状态 → 认游标 → 判边界 → 安排下一次。
 *
 * 排程只在函数末尾做一次（**包括补推之后**）：早先这里写成"补推完就 return"，
 * 于是会话一旦真的补推过一次就不再排程，看门狗当场断气 —— 表现是"第一窗放完就不动了"。
 * 出错那一拍不重排（票失效之类继续轮询只会反复撞），等客户端下次来问时再拉起。
 */
async function tick(s: Session): Promise<void> {
  if (s.ticking) return
  s.ticking = true
  let nextDelay = POLL_MS
  let errored = false
  try {
    if (s.pushFails >= MAX_PUSH_FAILS) {
      logger.warn('[xiaomi] 连续推失败，停掉这台的投放会话', { 音箱: s.deviceName, 次数: s.pushFails })
      clearSession(s.deviceID)
      return
    }
    const creds = await ensureFreshCredentials()
    const st = await getPlayStatus(creds, s.deviceID)
    // 回跳要在落账之前判：applyStatus 会把 lastStatus 换成这一拍的读数，之后就比不出"掉回 0 了"
    const looped = sawLoopRestart(s, st)
    applyStatus(s, st)
    // TEMP-CAST-READ（临时探针，posSec 那件事定完就撤）：非边界这几拍一直是哑的，
    // 已经第三次让我们只能靠推 —— 先把设备原始读数钉在日志里。
    logger.info('[xiaomi] TEMP-CAST-READ 每拍', {
      音箱: s.deviceName, 位置毫秒: st.position, 时长毫秒: st.duration, 状态: st.status,
      是我们的: s.lastStatusIsOurs, 第几项: s.playingIdx, 窗长: s.window.length,
      起点秒: playingSlot(s).seekSec, 剩余秒: Math.round(remainingSec(s)),
    })

    // 收尾那几拍不参与边界判断，只回答一个问题：**它是不是真的停了**。
    // 还在播就补发 stop（`s.stopTries` 封顶），确认停了才清会话 —— 详见 CLOSE_GAP_MS 那段实测。
    if (s.closing) {
      if (st.status === PLAY_STATUS_PLAYING && s.stopTries < CLOSE_MAX_TRIES) {
        s.stopTries += 1
        logger.info('[xiaomi] 收口回读：它又自己播起来了，补发 stop', { 音箱: s.deviceName, 第几声: s.stopTries })
        await stopDevice(s)
        nextDelay = CLOSE_GAP_MS
      } else {
        logger.info(
          st.status === PLAY_STATUS_PLAYING
            ? '[xiaomi] 补发到上限它还在播，先撤（这一窗多半还在它手里循环）'
            : '[xiaomi] 收口确认：音箱停了',
          { 音箱: s.deviceName, 发过: s.stopTries },
        )
        // 清了会话 ⇒ 函数末尾那次排程自己会因为"不在表里"而跳过
        clearSession(s.deviceID)
      }
    } else {
      const remaining = remainingSec(s)
      // 动手的时机有两种：① 播到了窗里最后一项（不补它就会从头循环）；
      // ② 投放期间改过队列 —— 不必等整窗见底，当前这首放完就生效，
      //    而"当前这首放完"正是设备本来要换歌的时刻，重推落在这个静默点上不额外打断什么。
      // 单曲循环是**故意**留给它自己循环的：那种"从头再来"正是要的效果，所以①在这条上不成立。
      const mustAct = s.pendingRest !== null || (!s.loopOne && s.playingIdx >= s.window.length - 1)
      if (st.status === 0 && Date.now() - s.pushedAt >= PUSH_GRACE_MS) {
        logger.info('[xiaomi] 音箱停了但队列没放完，补推下一窗', { 音箱: s.deviceName, 剩余秒: Math.round(remaining) })
        await advance(s)
      } else if (mustAct && (remaining <= TAIL_GUARD_SEC || looped)) {
        // looped 那条是兜底：读到"同一项里位置大段回退"说明它已经从头循环了（睡过边界，或元数据
        // 时长比真实文件长 ⇒ 定点根本不会发生），再等一圈就是"接管的那首歌怎么停不下来"
        logger.info(looped ? '[xiaomi] 音箱把这一首从头循环了，立即收口' : '[xiaomi] 到边界了，补下一窗或收口', {
          音箱: s.deviceName, 剩余秒: Math.round(remaining),
          // 这三个数是 2026-10-10 那次"5 秒就掐"之后补的：光有 `剩余秒:-31` 反推不出是谁的位置，
          // 靠 248-279 手算才算出那 279 秒根本不是我们的流。下次一眼就能看出来。
          位置秒: st.position >= 0 ? Math.round(st.position / 1000) : -1,
          可信位置秒: Math.round(playedWithinStream(s)),
          时长秒: Math.round(itemDurSec(s, playingSlot(s))),
          是我们的读数: s.window.some(x => x.audioId === st.audioId),
        })
        await advance(s)
      } else {
        nextDelay = mustAct ? tailDelayMs(remaining) : POLL_MS
      }
      // 这一拍把会话推进了"收尾"（advance 见底 ⇒ beginClose）：下一拍要按收尾的节奏去回读，
      // 沿用 5 秒等于把确认推迟一整拍
      if (s.closing) nextDelay = CLOSE_GAP_MS
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    s.lastError = message.slice(0, 200)
    logger.warn('[xiaomi] 投放看门狗出错，这一拍不再排程:', message.slice(0, 160))
    errored = true
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
  } finally {
    s.ticking = false
  }
  if (!errored && rt.sessions.has(s.deviceID)) scheduleTick(s, nextDelay)
}

/** 停掉别台已有的投放：一次只允许一个投放会话，免得歌在两个房间同时响 */
async function stopOtherSessions(exceptDeviceID: string): Promise<void> {
  for (const [id, s] of [...rt.sessions]) {
    if (id === exceptDeviceID) continue
    if (s.timer) clearTimeout(s.timer)
    await stopDevice(s).catch(() => {})
    rt.sessions.delete(id)
  }
}

export interface StartCastInput {
  /** 从哪首开始（投放时的当前曲） */
  current: CastTrack
  /** 之后的播放顺序，由调用方按播放模式算好（随机要先冻结成一份列表） */
  rest: CastTrack[]
  deviceID?: string
  /** 从当前曲的第几秒开始（拖动过进度条、或从本地接着放） */
  seekSec?: number
  /** 单曲循环：只推这一首并让设备循环它（rest 传空） */
  loopOne?: boolean
}

/** 起一个投放会话（同一台重复调用 = 从头重投） */
export async function startCast(input: StartCastInput): Promise<CastView> {
  const config = await readSpeakerConfig()
  if (!config.enabled) throw new SpeakerError('小爱网关总开关是关的（面板上打开它）', 409)
  if (!input.current?.uid) throw new SpeakerError('得告诉我要投哪首歌', 400)
  const device = pickDevice(config.devices, input.deviceID)
  const base = buildStreamBase(config.serverHost)
  const rest = (input.rest ?? []).filter(t => t?.uid && t.uid !== input.current.uid).slice(0, CAST_MAX_TRACKS)
  const firstWindow = rest.slice(0, CAST_WINDOW_SIZE - 1)
  const current = (await signSlots(config, base, [input.current], Math.max(0, input.seekSec ?? 0)))[0]
  const slots = [current, ...(await signSlots(config, base, firstWindow))]

  const s: Session = {
    deviceID: device.deviceID,
    deviceName: device.name,
    hardware: device.hardware,
    window: [],
    playingIdx: 0,
    rest,
    cursor: firstWindow.length,
    history: [],
    recordedIdx: 0,
    pendingRest: null,
    loopOne: input.loopOne === true,
    closing: false,
    stopTries: 0,
    pushedAt: 0,
    lastStatus: null,
    lastStatusAt: 0,
    lastStatusIsOurs: false,
    pausedWithinItem: null,
    timer: null,
    ticking: false,
    pushFails: 0,
    lastError: null,
  }
  const old = rt.sessions.get(device.deviceID)
  if (old?.timer) clearTimeout(old.timer)
  await stopOtherSessions(device.deviceID)
  if (!(await pushWindow(s, slots))) {
    throw new SpeakerError(s.lastError ?? '音箱没认这条推歌', 502)
  }
  rt.sessions.set(device.deviceID, s)
  primeStatus(s)
  scheduleTick(s, POLL_MS)
  return buildView(s)
}

function requireSession(deviceID?: string): Session {
  const s = deviceID ? rt.sessions.get(deviceID) : rt.sessions.values().next().value
  if (!s) throw new SpeakerError('现在没有投放会话（先点「投到小爱」）', 409)
  return s
}

/** 下一首 / 上一首：用户本意就是切歌，所以当场重推（新起点之后照样带着一窗） */
export async function skipCast(delta: number, deviceID?: string): Promise<CastView> {
  const s = requireSession(deviceID)
  if (delta > 0) {
    if (s.playingIdx + 1 < s.window.length) {
      const next = { uid: s.window[s.playingIdx + 1].uid, durSec: s.window[s.playingIdx + 1].durSec }
      if (!(await replayFrom(s, next))) throw new SpeakerError(s.lastError ?? '音箱没认这条切歌指令', 502)
      return buildView(s)
    }
    // 窗里没了：从 rest 切下一窗。切不出来时 advance 会开始收口（发 stop，之后几拍回读确认），
    // 这一下是用户要"下一首"而我们已经没东西可给 —— 不能假装还在投放，如实报错让前端退出投放态
    if ((await advance(s)) === 'closing') throw new SpeakerError('队列已经放完，音箱停了', 409)
    return buildView(s)
  }
  // 先回本窗里的前一格（设备自己往后播的那些也算"刚听过"，它们不在 history 里就是回不去）
  if (s.playingIdx > 0) {
    const back = { uid: s.window[s.playingIdx - 1].uid, durSec: s.window[s.playingIdx - 1].durSec }
    if (!(await replayFrom(s, back, { afterFrom: s.playingIdx, historyUpTo: -1 }))) {
      throw new SpeakerError(s.lastError ?? '音箱没认这条切歌指令', 502)
    }
    return buildView(s)
  }
  const prev = s.history[0]
  if (!prev) {
    // 没有可回的上一首：等价于回到当前这首的开头（各家播放器的通用做法）
    const cur = { uid: playingSlot(s).uid, durSec: playingSlot(s).durSec }
    if (!(await replayFrom(s, cur, { historyUpTo: -1 }))) throw new SpeakerError(s.lastError ?? '音箱没认这条指令', 502)
    return buildView(s)
  }
  s.history = s.history.slice(1)
  // 窗里这些还要再播一遍，所以 afterFrom 从 0 起、且不往 history 里记
  if (!(await replayFrom(s, prev, { afterFrom: 0, historyUpTo: -1 }))) {
    throw new SpeakerError(s.lastError ?? '音箱没认这条切歌指令', 502)
  }
  return buildView(s)
}

/**
 * 拖动进度条：带 `seek` 偏移重推**这一项 + 后面剩余项**。
 * 只重推这一项不行 —— 那等于把连播丢了（实测重推会让设备从新流起点播起）。
 * seek 不算"播过"，所以 history 一律不动。
 */
export async function seekCast(sec: number, deviceID?: string): Promise<CastView> {
  const s = requireSession(deviceID)
  if (!Number.isFinite(sec) || sec < 0) throw new SpeakerError('要跳到第几秒得是个正数', 400)
  const cur = { uid: playingSlot(s).uid, durSec: playingSlot(s).durSec }
  if (!(await replayFrom(s, cur, { seekSec: sec, historyUpTo: -1 }))) {
    throw new SpeakerError(s.lastError ?? '音箱没认这条跳转指令', 502)
  }
  return buildView(s)
}

/**
 * 投放期间改了队列：存起来，等**当前这首放完**再生效（看门狗在边界动手）。
 * 不当场重推是因为重推会把正在播的这首从头放 —— 那是听得见的伤害。
 * 生效时旧窗里没播到的那些会被新队列整体取代：前端传来的顺序就是"接下来播什么"的权威。
 */
export function updateCastRest(rest: CastTrack[], deviceID?: string): CastView {
  const s = requireSession(deviceID)
  s.pendingRest = (rest ?? []).filter(t => t?.uid).slice(0, CAST_MAX_TRACKS)
  return buildView(s)
}

/** 暂停/继续之后立刻刷一次状态（别让进度按墙钟跑在设备前头） */
export async function refreshCast(deviceID?: string): Promise<CastView> {
  const s = requireSession(deviceID)
  const creds = await ensureFreshCredentials()
  const st = await getPlayStatus(creds, s.deviceID)
  s.lastStatus = st
  s.lastStatusAt = Date.now()
  s.lastStatusIsOurs = statusIsOurs(s, st)
  // 这一路也要过同一道"是不是我们的流"的关：认不出来时那份位置是别的内容的，定住它等于把别人的进度当成我们的
  s.pausedWithinItem = st.status === PLAY_STATUS_PLAYING ? null : (st.position >= 0 && s.lastStatusIsOurs ? st.position / 1000 : 0)
  const idx = s.window.findIndex(x => x.audioId === st.audioId)
  if (idx >= 0) s.playingIdx = idx
  if (!s.timer && rt.sessions.has(s.deviceID)) scheduleTick(s, POLL_MS)
  return buildView(s)
}

/**
 * 读会话状态（客户端轮询只走这里，**不打小米**：设备侧的读由看门狗按物理时效去做）。
 * 看门狗要是因为出错停了，这里顺手把它拉起来，免得投完以后进度永远不动。
 */
export async function castView(deviceID?: string): Promise<CastView | null> {
  const s = deviceID ? rt.sessions.get(deviceID) : rt.sessions.values().next().value
  if (!s) return null
  if (!s.timer && !s.ticking) scheduleTick(s, 0)
  const view = buildView(s)
  // TEMP-CAST-READ（同上，定完就撤）：这一条打的是**客户端真正拿到的那个数**，
  // 顺带把"看门狗是不是根本没在跑"一起钉掉 —— posSec 恒 0 现在只有两种可能，这份读数能分开它们。
  logger.info('[xiaomi] TEMP-CAST-READ 视图', {
    音箱: s.deviceName, posSec: Math.round(view.posSec * 10) / 10,
    设备位置毫秒: s.lastStatus ? s.lastStatus.position : null,
    外推秒: Math.round((Date.now() - s.lastStatusAt) / 100) / 10,
    是我们的: s.lastStatusIsOurs, 有读数: !!s.lastStatus,
    距推秒: Math.round((Date.now() - s.pushedAt) / 1000), 排程中: !!s.timer, 正在读: s.ticking,
  })
  return view
}

/** 退出投放：停掉音箱并清会话 */
export async function stopCast(deviceID?: string): Promise<void> {
  const s = deviceID ? rt.sessions.get(deviceID) : rt.sessions.values().next().value
  if (!s) return
  await stopDevice(s)
  clearSession(s.deviceID)
}

function clearSession(deviceID: string): void {
  const s = rt.sessions.get(deviceID)
  if (s?.timer) clearTimeout(s.timer)
  rt.sessions.delete(deviceID)
}

/** 测试用：清掉所有会话与定时器 */
export function _resetCastSessionsForTest(): void {
  for (const s of rt.sessions.values()) if (s.timer) clearTimeout(s.timer)
  rt.sessions.clear()
}

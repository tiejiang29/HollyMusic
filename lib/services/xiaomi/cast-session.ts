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
 * 三条实测口径决定了实现的形状：
 * - **重推会让那一项从 0 起播** ⇒ 补推只能卡边界；拖动位置靠"带 `seek` 偏移重推"，
 *   而且**剩余项必须一起重排**，否则重推一次就把连播丢了。
 * - `play_song_detail.audio_id` **原样回显我们填的值** ⇒ 它就是"播到窗里第几项"的游标。
 * - 设备报的 `duration` 是**当前项**的时长，不是整窗的。
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
/** 刚推完的宽限期：设备起播有延迟，这期间读到"停了"不算停 */
const PUSH_GRACE_MS = 8000
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
  pushedAt: number
  lastStatus: PlayStatus | null
  lastStatusAt: number
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
function itemDurSec(s: Session, slot: WindowSlot): number {
  if (slot.durSec > 0) return slot.durSec
  if (slot.deviceDurSec && slot.deviceDurSec > 0) return slot.deviceDurSec
  if (slot === playingSlot(s) && s.lastStatus && s.lastStatus.duration > 0) return s.lastStatus.duration / 1000
  return UNKNOWN_DUR_SEC
}

/**
 * 这一项**从它的流起点算**已经播了多少秒。
 * 设备每次读到都带绝对位置，两次轮询之间按墙钟外推（暂停期间不外推）；
 * 这台不报位置时（`position < 0`）只能整个按推入时刻起算。
 */
function playedWithinStream(s: Session): number {
  const st = s.lastStatus
  if (!st || st.position < 0) {
    if (st && st.status !== PLAY_STATUS_PLAYING) return s.pausedWithinItem ?? 0
    return Math.max(0, (Date.now() - s.pushedAt) / 1000)
  }
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
  s.pushedAt = Date.now()
  s.pausedWithinItem = null
  s.pushFails = 0
  s.lastError = null
  s.lastStatus = null
  s.lastStatusAt = 0
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
 */
async function advance(s: Session): Promise<void> {
  if (s.loopOne && s.pendingRest === null) return   // 让它自己转，不收口也不补窗
  if (s.pendingRest) {
    s.rest = s.pendingRest
    s.cursor = 0
    s.pendingRest = null
    // 拿到新顺序就不再是"循环这一首"了，否则新窗放完又会从头循环
    s.loopOne = false
  }
  const take = s.rest.slice(s.cursor, s.cursor + CAST_WINDOW_SIZE)
  if (take.length === 0) {
    logger.info('[xiaomi] 队列放完，停掉音箱', { 音箱: s.deviceName })
    await stopDevice(s)
    clearSession(s.deviceID)
    return
  }
  const config = await readSpeakerConfig()
  const base = buildStreamBase(config.serverHost)
  const oldWindow = s.window.slice(0)
  const recordFrom = s.recordedIdx
  const playedTo = s.playingIdx + 1   // 到边界了，当前这首也算播完
  if (!(await pushWindow(s, await signSlots(config, base, take)))) return
  s.cursor += take.length
  recordPlayed(s, oldWindow, recordFrom, playedTo)
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

/** 把一次状态回读落进会话（看门狗与起播确认共用这一份口径） */
function applyStatus(s: Session, st: PlayStatus): void {
  s.lastStatus = st
  s.lastStatusAt = Date.now()
  if (st.status !== PLAY_STATUS_PLAYING) {
    s.pausedWithinItem = st.position >= 0 ? st.position / 1000 : playedWithinStream(s)
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
  if (st.duration > 0) {
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
    applyStatus(s, st)

    const remaining = remainingSec(s)
    // 动手的时机有两种：① 播到了窗里最后一项（不补它就会从头循环）；
    // ② 投放期间改过队列 —— 不必等整窗见底，当前这首放完就生效，
    //    而"当前这首放完"正是设备本来要换歌的时刻，重推落在这个静默点上不额外打断什么。
    // 单曲循环是**故意**留给它自己循环的：那种"从头再来"正是要的效果，所以①在这条上不成立。
    const mustAct = s.pendingRest !== null || (!s.loopOne && s.playingIdx >= s.window.length - 1)
    if (st.status === 0 && Date.now() - s.pushedAt >= PUSH_GRACE_MS) {
      logger.info('[xiaomi] 音箱停了但队列没放完，补推下一窗', { 音箱: s.deviceName, 剩余秒: Math.round(remaining) })
      await advance(s)
    } else if (mustAct && remaining <= TAIL_GUARD_SEC) {
      await advance(s)
    } else {
      nextDelay = mustAct && remaining <= POLL_MS / 1000 ? TAIL_POLL_MS : POLL_MS
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
    pushedAt: 0,
    lastStatus: null,
    lastStatusAt: 0,
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
    // 窗里没了：从 rest 切下一窗。切不出来时 advance 会收口（停音箱 + 清会话），
    // 这里不能假装还在投放 —— 会话已不在表里，如实报错让前端退出投放态
    await advance(s)
    if (!rt.sessions.has(s.deviceID)) throw new SpeakerError('队列已经放完，音箱停了', 409)
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
  s.pausedWithinItem = st.status === PLAY_STATUS_PLAYING ? null : (st.position >= 0 ? st.position / 1000 : 0)
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
  return buildView(s)
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

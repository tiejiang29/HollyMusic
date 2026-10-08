/**
 * 对话轮询监视器（G0.5 量数，也是 G3 语音接管的输入源）。
 *
 * 为什么单开一个模块：这件事的全部价值在**时序口径**上 —— 基线取错一个来源，
 * 面板上就会看到"每次刷新都在重放昨天的对话"或者"我明明说了它一条没有"，
 * 而这两种都会让后面 G3 的接管判据被校准到错的地方。三条要记的：
 *
 * 1. **基线只用平台返回的时间戳，绝不用 `Date.now()`**（参考实现原文就是这么写的）：
 *    本机时钟比小米快 → 启动后一段时间内的真实对话会被静默丢掉；比它慢 → 重放历史。
 * 2. **"这次没取到"与"确实没有记录"必须分开**（`fetchConversations` 抛错 vs 返回 []）：
 *    前者不许动基线、不许清 lastError 之外的任何状态。
 * 3. **首轮不投递新记录**，但会把它们标成"启动时的历史"留在面板上（量数要看得到东西，
 *    G3 的接管只吃 `fromBaseline=false` 的那些）。
 *
 * 定时器是内存态、由**路由侧**启动（`ensureConversationMonitor()`）：Next 的 instrumentation
 * 是另一套模块副本，从那边写的内存态路由读不到。
 */
import { logger } from '@/lib/logger'
import {
  ensureFreshCredentials, readSpeakerConfig, clampPollSec,
} from '@/lib/services/xiaomi/token-store'
import { XiaomiAuthError, fetchConversations } from '@/lib/services/xiaomi/mina-client'
import { submitAsk } from '@/lib/services/xiaomi/voice-takeover'

/** 面板上的一行 */
export interface AskRow {
  deviceID: string
  deviceName: string
  /** 小爱侧时间戳（毫秒），也是"隔了几秒才看得见"的分母 */
  timestampMs: number
  /** 我们看到它的时刻（毫秒，本地时钟） */
  receivedAt: number
  query: string
  answer: string
  /** 疑似"小爱没答上"（按面板上那份可配的话术片段判） */
  looksFailed: boolean
  /** 启动那一轮读到的历史（不是刚说的），G3 的接管不许吃它 */
  fromBaseline: boolean
}

export interface MonitorState {
  running: boolean
  pollSec: number
  enabled: boolean
  lastPollAt: number | null
  lastError: string | null
  /**
   * 每台设备各自的轮询账目。G0.5 的全部意义就是可诊断：0 条行时得能分清
   * "拉了但平台真没有"（polls 在涨、seen 是 0）和"根本没在拉"（polls 不动）。
   */
  devices: Array<{ deviceID: string; name: string; primed: boolean; lastTs: number; polls: number; seen: number }>
}

const FEED_MAX = 60
/**
 * 允许"时间戳被往回改"时还能收到：平台会重写记录时间戳（参考实现为此留了退路），
 * 完全按 `> lastTs` 就会漏掉刚说的这句。往回容忍 10 秒，配合去重键不会重播。
 */
const REWIND_TOLERANCE_MS = 10_000

const feed: AskRow[] = []
const baselines = new Map<string, { name: string; hardware: string; lastTs: number; primed: boolean; seen: Set<string>; polls: number }>()

/** 拿到（或建出）这台设备的账目 */
function ensureAccount(deviceID: string, name: string, hardware: string) {
  let b = baselines.get(deviceID)
  if (!b) {
    b = { name, hardware, lastTs: 0, primed: false, seen: new Set<string>(), polls: 0 }
    baselines.set(deviceID, b)
  }
  return b
}

/** 每发起一次真拉取计一票：连拉失败也计，否则面板分不清"没在拉"和"拉着但平台没记录" */
function account(deviceID: string, name: string, hardware: string) {
  const b = ensureAccount(deviceID, name, hardware)
  b.polls++
  return b
}

function snapshotDevices(targets: Array<{ deviceID: string }>): MonitorState['devices'] {
  return targets.map(d => {
    const b = baselines.get(d.deviceID)
    return {
      deviceID: d.deviceID, name: b?.name ?? '', primed: b?.primed ?? false,
      lastTs: b?.lastTs ?? 0, polls: b?.polls ?? 0, seen: b?.seen.size ?? 0,
    }
  })
}

let timer: ReturnType<typeof setTimeout> | null = null
let ticking = false
let state: MonitorState = {
  running: false, pollSec: 2, enabled: false,
  lastPollAt: null, lastError: null, devices: [],
}

/** 话术片段命中即算"疑似没答上"。空答案也算 —— 小爱光响灯不出话是同一类失败 */
export function looksLikeFailedAnswer(answer: string, hints: string[]): boolean {
  const text = (answer ?? '').trim()
  if (!text) return true
  return hints.some(h => h && text.includes(h))
}

export function getConversationFeed(): { rows: AskRow[]; state: MonitorState } {
  return { rows: feed.slice(0, FEED_MAX), state }
}

export function stopConversationMonitor(): void {
  if (timer) clearTimeout(timer)
  timer = null
  state = { ...state, running: false }
}

/**
 * 路由侧调它：开关开着就确保有一台在跑。
 * 已经开着且参数没变则什么都不做（面板每几秒刷一次，不能每次都重来一遍）。
 */
export async function ensureConversationMonitor(): Promise<MonitorState> {
  const config = await readSpeakerConfig()
  const pollSec = clampPollSec(config.conversationPollSec)
  if (!config.conversationEnabled) {
    if (timer || state.running) stopConversationMonitor()
    return { ...state, enabled: false, pollSec }
  }
  // `running` 只是"我打算在跑"。真正的凭据是手上有没有定时器在等（timer）或有没有一拍在飞
  // （ticking）—— 两个都没有就是上一拍被硬错打停了，这里必须重新排起来，否则 tick() 里那句
  // "等面板下次来问时重新排程"是空的（实测：一次 code=999 之后永远停住）。
  if (state.running && (timer !== null || ticking) && state.pollSec === pollSec) return state
  state = { ...state, enabled: true, running: true, pollSec }
  logger.info('[xiaomi] 对话轮询启动', { 间隔秒: pollSec, 设备数: config.devices.filter(d => d.managed && d.presence === 'online').length })
  schedule(0)
  return state
}

function schedule(delayMs: number): void {
  if (timer) clearTimeout(timer)
  // 定时器一触发就把句柄清掉：不然 `timer` 永远指着一个已经响过的 Timeout，
  // "手上还有没有在等的那一拍"就判不出来（硬错停住后面板再问也救不回来）
  timer = setTimeout(() => { timer = null; void tick() }, delayMs)
}

/** 一拍：把所有在线纳管设备的对话记录拉一遍 */
async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  let failedHard = false
  try {
    const config = await readSpeakerConfig()
    if (!config.conversationEnabled) { stopConversationMonitor(); return }
    const targets = config.devices.filter(d => d.managed && d.presence === 'online' && d.hardware)
    if (targets.length === 0) {
      state = { ...state, lastPollAt: Date.now(), lastError: '没有在线且纳管的设备，暂无可轮询', devices: [] }
    } else {
      const creds = await ensureFreshCredentials()
      // 单台失败不阻断别台，但**要留在 lastError 上**：早先这里收尾时把 lastError 一律清成 null，
      // 于是一台设备每次都失败、面板却显示一切正常（测试抓到过）
      let softError: string | null = null
      for (const device of targets) {
        account(device.deviceID, device.name, device.hardware)
        let records
        try {
          records = await fetchConversations(creds, device.hardware, 5)
        } catch (err) {
          // 只有**票的事**（status 401）才停整个轮询。`mina-client` 把"上游拒绝"也用同一个
          // XiaomiAuthError 抛，但带的是 status=502（例：实测到的 code=999）—— 那是偶发的一拍，
          // 当硬错停掉就等于"一次抖动把功能打死且再也起不来"（2026-10-08 就是这么挂在面板上的）。
          // 这个 401/502 的分工与 token-store 那边同一口径。
          if (err instanceof XiaomiAuthError && err.status === 401) throw err
          softError = `${device.name}：${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`
          logger.warn('[xiaomi] 单台对话轮询失败:', softError)
          continue
        }
        const fresh = absorb(device.deviceID, device.name, records, config.failedAnswerHints)
        // 接管（G3）只吃"刚说的话"那批，历史一条都不许动别人的播放
        if (config.takeoverEnabled && fresh.length) for (const row of fresh) submitAsk(row)
      }
      state = { ...state, lastPollAt: Date.now(), lastError: softError, devices: snapshotDevices(targets) }
    }
  } catch (err) {
    failedHard = true
    const message = err instanceof Error ? err.message : String(err)
    state = { ...state, lastError: message.slice(0, 200) }
    logger.warn('[xiaomi] 对话轮询出错:', message.slice(0, 160))
  } finally {
    ticking = false
  }
  // 票失效这类硬错不再自己爬：等面板下一次来问时 ensureConversationMonitor 会重新排程
  if (!failedHard) {
    const config = await readSpeakerConfig()
    if (config.conversationEnabled) schedule(state.pollSec * 1000)
    else stopConversationMonitor()
  }
}

/** 把拉到的记录按基线规则收成进 feed，并返回"这轮新增的非历史行"（给 G3 的接管用） */
function absorb(deviceID: string, deviceName: string, records: { timestampMs: number; query: string; answer: string }[], hints: string[]): AskRow[] {
  const b = ensureAccount(deviceID, deviceName, '')
  const now = Date.now()
  const rows: AskRow[] = []
  for (const r of records) {
    const key = `${r.timestampMs}|${r.query}|${r.answer}`
    if (b.seen.has(key)) continue
    b.seen.add(key)
    if (b.seen.size > 200) {
      // 只留最近的一部分，长跑不漏内存（Set 保持插入序，删最旧）
      const oldest = b.seen.values().next().value
      if (oldest !== undefined) b.seen.delete(oldest)
    }
    if (b.primed && r.timestampMs < b.lastTs - REWIND_TOLERANCE_MS) continue
    rows.push({
      deviceID, deviceName,
      timestampMs: r.timestampMs,
      receivedAt: now,
      query: r.query,
      answer: r.answer,
      looksFailed: looksLikeFailedAnswer(r.answer, hints),
      // 首轮那批只当历史看，不算"刚说的话"
      fromBaseline: !b.primed,
    })
    if (r.timestampMs > b.lastTs) b.lastTs = r.timestampMs
  }
  if (!b.primed) {
    b.primed = true
    if (rows.length > 0) logger.info('[xiaomi] 对话基线建立', { 设备: deviceName, 历史条数: rows.length })
  }
  if (rows.length === 0) return []
  feed.unshift(...rows.reverse())
  if (feed.length > FEED_MAX) feed.length = FEED_MAX
  return rows.filter(r => !r.fromBaseline)
}

/** 只给测试用 */
export function _resetConversationMonitorForTest(): void {
  stopConversationMonitor()
  feed.length = 0
  baselines.clear()
  state = { running: false, pollSec: 2, enabled: false, lastPollAt: null, lastError: null, devices: [] }
}

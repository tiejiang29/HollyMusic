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
import type { SpeakerConfig } from '@/lib/services/xiaomi/token-store'
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
  /**
   * 回答是**后补进同一条记录**的（2026-10-09 实测：同一行先是空、下一拍带回 50 字回答）。
   * 有值 = 这一行还在等它的回答，到期时刻（毫秒）。到点仍空 ⇒ 标 `answerTimedOut` 再判。
   */
  answerWaitUntil?: number
  /** 等满了还是没有回答：判据照旧按"没证据"处理，但面板要能看出我们真等过 */
  answerTimedOut?: boolean
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
const baselines = new Map<string, { name: string; hardware: string; lastTs: number; primed: boolean; seen: Set<string>; polls: number; lastFreshTs: number }>()

/**
 * 挂着等回答的行（按设备）。键值里存的是**喂进 feed 的同一个对象**，所以补到回答时
 * 面板那一行会跟着变，不会多出一条重复记录。
 */
const pendingAnswers = new Map<string, AskRow[]>()

/** 拿到（或建出）这台设备的账目 */
function ensureAccount(deviceID: string, name: string, hardware: string) {
  let b = baselines.get(deviceID)
  if (!b) {
    b = { name, hardware, lastTs: 0, primed: false, seen: new Set<string>(), polls: 0, lastFreshTs: 0 }
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
  // 挂着等回答的那几行跟着作废：开关都关了还不许动设备，而句柄留在 Map 里等于把"已作废的口令"
  // 留给下一轮去判（重新打开轮询时它们早就不是"刚说的话"了）
  pendingAnswers.clear()
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
    // 状态本体里的 `enabled` 也要落回去：以前只把 enabled:false 贴在**返回值**上，而面板走的是
    // `convList` → `getConversationFeed()`（读的是 state 本体），于是关掉开关后它还看着 enabled:true。
    // 2026-10-08 修的是路由那两条手写分支，这是同一类的另一半。
    state = { ...state, enabled: false, pollSec }
    return state
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
          records = await fetchConversations(creds, device, 5)
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
        // 先记下"这台最新说到哪句"，**再**去结算挂着的那几行：用户已经改口时，
        // 旧句的回答这一拍就算回来了也不该再动设备（判据在 submitNow 里）
        if (fresh.length) {
          const b = ensureAccount(device.deviceID, device.name, device.hardware)
          for (const row of fresh) if (row.timestampMs > b.lastFreshTs) b.lastFreshTs = row.timestampMs
        }
        // 挂着等回答的那几行**每拍都要过一遍**：补上回答的那一批常常不含新口令（`fresh` 是空的），
        // 只在新行到达时才 settle 就会让它们永远挂着。
        settleWaiting(device.deviceID, records, config)
        // 接管（G3）只吃"刚说的话"那批，历史一条都不许动别人的播放
        if (fresh.length) {
          const waitSec = answerWaitSec(config)
          for (const row of fresh) {
            if (row.answer || waitSec <= 0) {
              submitNow(device.deviceID, row, config)
              continue
            }
            row.answerWaitUntil = Date.now() + waitSec * 1000
            const waiting = pendingAnswers.get(device.deviceID) ?? []
            waiting.push(row)
            pendingAnswers.set(device.deviceID, waiting)
          }
        }
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

/**
 * 这一拍要不要为"等回答"挂起（秒）。
 *
 * 挂起**只为接管服务**：面板那一行当拍到就进了 feed，不会因为等回答而晚出现或消失。
 * 接管关着、或这个键没配（旧数据 / 测试夹具）都返回 0 = 不挂起，直接走 submitNow 那道闸。
 */
function answerWaitSec(config: SpeakerConfig): number {
  if (!config.takeoverEnabled) return 0
  const sec = Number(config.takeoverAnswerWaitSec)
  return Number.isFinite(sec) && sec > 0 ? sec : 0
}

/**
 * 把一条口令交给接管链。
 *
 * 两道闸都在这儿：① 接管开关可能是在挂着等回答期间被关掉的 ⇒ 关着就一句都不发；
 * ② 等回答期间用户又说了更新的一句 ⇒ 旧句不许再动设备（他已经改口了，照旧话抢播就是打扰）。
 */
function submitNow(deviceID: string, row: AskRow, config: SpeakerConfig): void {
  row.answerWaitUntil = undefined
  if (!config.takeoverEnabled) return
  const b = baselines.get(deviceID)
  if (b && row.timestampMs < b.lastFreshTs) {
    logger.info('[xiaomi] 这条已被更新的一句超过，不动设备', { 说了: row.query.slice(0, 30) })
    return
  }
  submitAsk(row)
}

/**
 * 给挂着等回答的行补回答。
 *
 * 依据是 2026-10-09 的实测：同一行先是空、下一拍带回 50 字回答 —— 记录会被平台原地补全，
 * 所以"读到空"不等于"小爱没答"。等满 `takeoverAnswerWaitSec` 还空，才按"没证据"去判。
 */
function settleWaiting(
  deviceID: string, records: { timestampMs: number; query: string; answer: string }[], config: SpeakerConfig,
): void {
  const waiting = pendingAnswers.get(deviceID)
  if (!waiting || waiting.length === 0) return
  const now = Date.now()
  const rest: AskRow[] = []
  for (const row of waiting) {
    // absorb 已经把同一行的回答原地补全了；补不上的（平台改写了时间戳）再按 10 秒内的
    // 偏移找一次，但**必须同一句 query** —— 不然会把下一句的回答安到这一句头上（那比读早了更糟）
    const hit = row.answer
      ? null
      : records.find(r => !!r.answer && Math.abs(r.timestampMs - row.timestampMs) <= REWIND_TOLERANCE_MS && r.query === row.query)
    if (hit) {
      row.answer = hit.answer
      row.looksFailed = looksLikeFailedAnswer(hit.answer, config.failedAnswerHints)
    } else if (!row.answer && now < (row.answerWaitUntil ?? 0)) {
      // 还在窗口内且这一拍没带回回答 ⇒ 继续挂到下一拍
      rest.push(row)
      continue
    } else if (!row.answer) {
      // 等满了还是空：判据照旧按"没证据"走，但行上留个记号，面板能看出我们真等过
      row.answerTimedOut = true
    }
    submitNow(deviceID, row, config)
  }
  if (rest.length) pendingAnswers.set(deviceID, rest)
  else pendingAnswers.delete(deviceID)
}

/**
 * 把拉到的记录按基线规则收成进 feed，并返回"这轮新增的非历史行"（给 G3 的接管用）。
 *
 * 去重键是 `时间戳|说了什么`，**不含回答** —— 因为实测回答是后补进同一条记录的（2026-10-09）：
 * 把回答算进键会让同一句话在面板上出现两行（先空后有），接管也会收到两次。
 * 现在的做法是同一行**原地补全**：`pendingAnswers` 里存的就是 feed 里那个对象，所以补上回答
 * 面板那一行跟着变，一行不多。
 */
function absorb(deviceID: string, deviceName: string, records: { timestampMs: number; query: string; answer: string }[], hints: string[]): AskRow[] {
  const b = ensureAccount(deviceID, deviceName, '')
  const now = Date.now()
  const rows: AskRow[] = []
  for (const r of records) {
    const key = `${r.timestampMs}|${r.query}`
    if (b.seen.has(key)) {
      const prior = feed.find(x => x.deviceID === deviceID && x.timestampMs === r.timestampMs && x.query === r.query)
      if (prior && !prior.answer && r.answer) {
        prior.answer = r.answer
        prior.looksFailed = looksLikeFailedAnswer(r.answer, hints)
      }
      continue
    }
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

/**
 * 语音接管（G3）：第②层——读小爱的回答判"它到底答上了没"，答砸了才由我们顶上。
 *
 * 三层短路（顺序是有意的，越靠前越便宜、越确定）：
 *  ① 本地控制词表命中 ⇒ 直接执行（零网络零 LLM，见 `voice-control.ts`）；
 *  ② 播放类意图 ⇒ **先问小爱答上了没**，只有"像没答上"才去搜我们的曲库并顶上；
 *  ③ 其余一律不动（可选的 LLM 那层还没接：AI 凭据现在只在浏览器 localStorage，
 *     服务端拿不到，要做得先把凭据落 AppSetting —— 那是另一件事，不在这儿偷偷加）。
 *
 * 第②层为什么要有：小爱自己的音乐检索覆盖不到我们的曲库（我们聚合的歌、我们自己转码的文件），
 * 但它**会先接住那句口令**。所以判据不是"这句话像不像点歌"，而是"这句它有没有办成"——
 * 办成了我们闭嘴，办砸了我们补上，这样两边不会同时出声。
 *
 * **今天必须先记下的一条前提**（2026-10-08 实测）：对话接口鉴权、报文形状、二次 parse 全都通，
 * 但 `limit` 开到 120 拿回来还是 `records=0` —— 也就是"真实的一条口令"我们至今没看到过。
 * 所以这一层的判据只能用面板上那条**模拟口令**验证（它把合成的一行喂进同一条链路，
 * 日志里明确标 `合成`），**不等于端到端已验**。拿不到证据时的默认立场也据此定成"不动"。
 */
import { logger } from '@/lib/logger'
import { searchOneSource } from '@/lib/services/song-search-service'
import { intervalToSeconds } from '@/lib/db'
import {
  matchControl, matchMusicTrigger, normalizeUtterance, similarity,
  DEFAULT_CONTROL_RULES, DEFAULT_MUSIC_TRIGGERS, type ControlRule, type ControlOp,
} from '@/lib/services/xiaomi/voice-control'
import { readSpeakerConfig, type SpeakerConfig } from '@/lib/services/xiaomi/token-store'
import { castView, refreshCast, skipCast, startCast, stopCast } from '@/lib/services/xiaomi/cast-session'
import { controlSpeaker, setSpeakerVolume } from '@/lib/services/xiaomi/speaker-play'
import type { AskRow } from '@/lib/services/xiaomi/conversation-monitor'
import type { SourceType } from '@/lib/types/music'

export type Verdict =
  | 'control' | 'takeover' | 'standby' | 'no-hit' | 'answered' | 'stale' | 'rejected' | 'not-music'

export interface TakeoverDecision {
  verdict: Verdict
  /** 说清为什么，只给面板看；命中了哪条控制词 / 相似度多少 */
  reason: string
  op?: ControlOp
  /** "音量调到 40"里那个数 */
  volumeTo?: number
  uid?: string
  name?: string
  score?: number
}

/** 口令最多老几秒还接（超过就当没听见：轮询卡了一下回来的旧话不该打断现在正在放的歌） */
export const STALE_ASK_SEC = 90
/** "互相包含"的长度窗口：口令整句里嵌着两个字的词也算包含，会把闲聊配成抢播（实测过） */
export const CONTAINS_WINDOW_CHARS = 4

/**
 * 判"小爱这句答砸了没"。
 *
 * 三态里**只有 `false` 才允许接管**：`null` 是"我们没有证据"（回答是空的、或者这一条根本没拉回来），
 * 按面板那项 `takeoverWithoutEvidence` 决定（默认不动）。把"拿不到证据"折算成"它答砸了"是
 * 这一期最容易犯的错——今天实测的 0 条记录就是活例子。
 */
export function answeredOk(row: AskRow, hints: string[]): boolean | null {
  const text = (row.answer ?? '').trim()
  if (!text) return null
  if (hints.some(h => h && text.includes(h))) return false
  return true
}

/**
 * 决定要不要接管。纯函数：不查库、不打网络，好让这三层的判据能钉在测试里。
 *
 * `search` 由调用方注入（真实实现是拿候选去我们的曲库搜一遍）——这样判据与取数分离，
 * 也挡住"为了测试把网络塞进决策里"那种写法。
 */
export async function decideTakeover(
  row: AskRow, config: SpeakerConfig, nowMs = Date.now(),
): Promise<TakeoverDecision> {
  if (row.fromBaseline) return { verdict: 'rejected', reason: '这条是启动时的历史，不是刚说的话' }
  if (nowMs - row.timestampMs > STALE_ASK_SEC * 1000) {
    return { verdict: 'stale', reason: `这句已经过了 ${Math.round((nowMs - row.timestampMs) / 1000)} 秒，不该再动现在的播放` }
  }
  const query = (row.query ?? '').trim()
  if (!query) return { verdict: 'rejected', reason: '这一条没有"你说"的部分，无从判断' }

  const rules: ControlRule[] = config.controlRules?.length ? config.controlRules : DEFAULT_CONTROL_RULES
  const hit = matchControl(query, rules)
  if (hit) return { verdict: 'control', reason: `控制词「${hit.matched}」命中`, op: hit.op, volumeTo: hit.volumeTo }

  const ok = answeredOk(row, config.failedAnswerHints)
  if (ok === true) return { verdict: 'answered', reason: `小爱答上了（「${row.answer.slice(0, 24)}」），不抢` }
  if (ok === null && !config.takeoverWithoutEvidence) {
    return { verdict: 'standby', reason: '没拿到它的回答，按默认立场不动（面板可改成"没证据也接"）' }
  }

  // **"它没答上"推不出"他要听歌"**：先要像个点歌的说法，才去搜、才谈得上抢
  const triggers = (config.takeoverTriggers?.length ? config.takeoverTriggers : DEFAULT_MUSIC_TRIGGERS)
  const trigger = matchMusicTrigger(query, triggers)
  if (!trigger) return { verdict: 'not-music', reason: `不像点歌（没命中触发词），不动：「${query.slice(0, 20)}」` }

  // 拿去掉触发词的那半句去搜：整句「播放稻香」会让匹配度被多出来的两个字拖低
  const { best: cand, skippedShort } = await pickCandidate(query.replace(trigger, '') || query, config)
  // 门槛挡掉几条要写在理由里：不然面板上只显示"没搜到"，管理员分不清是真没有还是被自己填高的门槛清了
  const shortNote = skippedShort > 0 ? `（另有 ${skippedShort} 条被"像整曲"的门槛挡掉，那格填 0 可关）` : ''
  if (!cand) return { verdict: 'no-hit', reason: `我们这边也没搜到像「${query.slice(0, 20)}」的歌，不动${shortNote}` }
  if (cand.score < config.fuzzyMatchCutoff) {
    return { verdict: 'no-hit', reason: `最像的是「${cand.name}」但只有 ${(cand.score * 100).toFixed(0)}%，低于 ${(config.fuzzyMatchCutoff * 100).toFixed(0)}%` }
  }
  return { verdict: 'takeover', reason: `它没答上，我们这有「${cand.name}」(${(cand.score * 100).toFixed(0)}%)`, uid: cand.uid, name: cand.name, score: cand.score }
}

export interface Candidate { uid: string; name: string; singer: string; durSec: number; score: number }

interface PickResult { best: Candidate | null; skippedShort: number }

/**
 * 拿口令去我们的曲库搜一遍，取最像的那条。
 *
 * 只搜 `takeoverSources` 那几台（面板可改），单源一次取 10 条：口令是短句，
 * 排在前面的本来就相关，我们要的是"第一条像不像这句话"，不是翻页找冷门。
 *
 * 顺带数一下"被整曲门槛挡掉几条"（`skippedShort`）：这个数字是给面板看的，
 * 门槛填高了却没有别的候选时，管理员要能看出来是门槛干的，而不是"搜不到"。
 */
async function pickCandidate(query: string, config: SpeakerConfig): Promise<PickResult> {
  const sources = (config.takeoverSources?.length ? config.takeoverSources : ['tx']) as SourceType[]
  const minTrack = Number(config.takeoverMinTrackSec) || 0
  let skippedShort = 0
  let best: Candidate | null = null
  for (const source of sources.slice(0, 3)) {
    let list
    try {
      list = (await searchOneSource(source, query, 1, 10)).list
    } catch (err) {
      // 一台挂了不算搜不到：还有别台。但这条要留日志，否则面板只会说"没搜到"
      logger.warn('[voice-takeover] 单源搜索失败:', `${source} ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}`)
      continue
    }
    for (const s of list) {
      const durSec = intervalToSeconds(s.interval) || 0
      // 整曲门槛只挡"明显是片段"的那类（30 秒铃声/剪辑版），**不做"与谁相等"的判断** ——
      // 元数据时长本身也会错。拿不到时长（0）不算过短，宁可放过也不清空候选。
      if (minTrack > 0 && durSec > 0 && durSec < minTrack) { skippedShort++; continue }
      const name = similarity(query, s.name ?? '')
      const bySinger = s.singer ? similarity(query, s.singer) * 0.2 : 0
      // 互相包含就算同一首：口令是"放稻香"而曲名是"稻香"时，编辑距离会被那两个字拖到阈值以下；
      // 但只认长度 ≥2 的那一方（单字互相包含纯属巧合，会把"今天几号"配上任意一首带"天"的歌）。
      // **还要卡一个长度窗口**：口令是一整句话，句子里随便嵌着两个字的词就"互相包含"了 ——
      // 实测过「播放 一首绝对不存在的歌名QQZXTY」配上真歌名《不存在的》打出 100%（那是抢播，不是点歌）。
      // 窗口取 +4 字：够放"稻香这首歌"这类说法，又拦得住整句闲聊。
      const qn = normalizeUtterance(query)
      const nn = normalizeUtterance(s.name ?? '')
      const longer = Math.max(qn.length, nn.length)
      const shorter = Math.min(qn.length, nn.length)
      const contains = shorter >= 2 && (nn.includes(qn) || qn.includes(nn)) && longer <= shorter + CONTAINS_WINDOW_CHARS
      const score = contains ? 1 : Math.max(name, name * 0.7 + bySinger)
      if (!best || score > best.score) {
        best = {
          uid: s.uid ?? `${source}-${s.songmid}`, name: s.name ?? '', singer: s.singer ?? '',
          durSec, score,
        }
      }
    }
  }
  return { best, skippedShort }
}

/** 面板上那行"接管账目"的一条：判了什么、动没动、为什么 */
export interface TakeoverLogRow {
  at: number
  deviceID: string
  deviceName: string
  query: string
  answer: string
  verdict: Verdict
  reason: string
  /** 真做了什么（"投了《稻香》"、"没动"）；一行字，直接显示 */
  acted: string
  /** 面板"模拟一条口令"喂进来的（不是真话）——混在一起看过两次就分不清了 */
  synthetic: boolean
}

const LOG_MAX = 40
const log: TakeoverLogRow[] = []
/** 一条条排队处理：连着说"下一首 下一首"时不许两条并发去抢同一条 ubus 队 */
let chain: Promise<unknown> = Promise.resolve()

export function getTakeoverLog(): TakeoverLogRow[] {
  return log.slice(0, LOG_MAX)
}

function pushLog(row: TakeoverLogRow): void {
  log.unshift(row)
  if (log.length > LOG_MAX) log.length = LOG_MAX
}

const clampVolume = (v: number): number => Math.min(100, Math.max(0, Math.round(v)))

/** 第①层的执行：只在"这台正被我们投放"时动，否则一句"交回小爱"就完了 */
async function runControl(d: TakeoverDecision, deviceID: string, config: SpeakerConfig): Promise<string> {
  const view = await castView(deviceID)
  if (!view) return '没动（这台设备上没有我们的投放会话，交回小爱自己处理）'
  switch (d.op) {
    case 'pause':
      await controlSpeaker('pause', deviceID)
      await refreshCast(deviceID)
      return '暂停'
    case 'resume':
      // 我们对外叫 resume，小米那条报文里的 action 是 play
      await controlSpeaker('play', deviceID)
      await refreshCast(deviceID)
      return '继续播放'
    case 'next':
      await skipCast(1, deviceID)
      return '切下一首'
    case 'prev':
      await skipCast(-1, deviceID)
      return '切上一首'
    case 'stop':
      await stopCast(deviceID)
      return '停了，会话也收掉了'
    case 'volumeUp':
    case 'volumeDown': {
      // 音量会自己漂（实测 44→32），所以起点必须现读而不是记着上次那个数
      const from = view.volume >= 0 ? view.volume : 50
      const to = clampVolume(from + (d.op === 'volumeUp' ? config.volumeStep : -config.volumeStep))
      await setSpeakerVolume(to, deviceID)
      return `音量 ${from} → ${to}`
    }
    case 'setVolume': {
      const to = clampVolume(Number(d.volumeTo))
      await setSpeakerVolume(to, deviceID)
      return `音量调到 ${to}`
    }
    default:
      return '没动（词表命中但操作不认识）'
  }
}

/**
 * 判 + 执行 + 记账。错误不许抛出去：口令处理失败最坏就是"这句没接住"，
 * 不能因为一次 ubus 抖动把对话轮询整条链打断。
 */
export async function handleAskNow(
  row: AskRow, opts: { synthetic?: boolean; config?: SpeakerConfig } = {},
): Promise<TakeoverLogRow> {
  const config = opts.config ?? await readSpeakerConfig()
  const d = await decideTakeover(row, config)
  let acted = '没动'
  try {
    if (d.verdict === 'control') {
      acted = config.takeoverEnabled ? await runControl(d, row.deviceID, config) : '没动（接管开关关着）'
    } else if (d.verdict === 'takeover') {
      if (!config.takeoverEnabled) acted = '没动（接管开关关着）'
      else {
        await startCast({ current: { uid: d.uid!, durSec: 0 }, rest: [], deviceID: row.deviceID })
        acted = `顶上来了：《${d.name}》（${((d.score ?? 0) * 100).toFixed(0)}% 像「${row.query.slice(0, 16)}」）`
      }
    } else if (d.verdict === 'answered') {
      acted = '没动（它办成了）'
    } else if (d.verdict === 'standby') {
      acted = '没动（默认立场：没证据不抢）'
    } else if (d.verdict === 'not-music') {
      acted = '没动（不像点歌）'
    } else if (d.verdict === 'no-hit') {
      acted = '没动（我们这边也没有这条）'
    } else {
      acted = `没动（${d.reason}）`
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    acted = `想动但失败了：${message.slice(0, 80)}`
    logger.warn('[voice-takeover] 执行失败:', `${d.verdict} ${message.slice(0, 120)}`)
  }
  const entry: TakeoverLogRow = {
    at: Date.now(), deviceID: row.deviceID, deviceName: row.deviceName,
    query: row.query, answer: row.answer, verdict: d.verdict, reason: d.reason,
    acted, synthetic: !!opts.synthetic,
  }
  pushLog(entry)
  logger.info('[voice-takeover] 判了一条口令', {
    判定: d.verdict, 说了: row.query.slice(0, 30), 答了: row.answer.slice(0, 30), 做了: acted, 合成: !!opts.synthetic,
  })
  return entry
}

/** 轮询那边调这个：不 await，排队做，别把一拍拖长（处理期间也不许插进下一条） */
export function submitAsk(row: AskRow): void {
  chain = chain.then(() => handleAskNow(row)).catch(err => {
    logger.warn('[voice-takeover] 排队的一条处理异常:', err instanceof Error ? err.message : String(err))
  })
}

/** 只给测试用 */
export function _resetVoiceTakeoverForTest(): void {
  log.length = 0
  chain = Promise.resolve()
}

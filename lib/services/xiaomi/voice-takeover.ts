/**
 * 语音接管（G3）：第②层——**句子里有「播放 / 我想听」这类点歌触发词就直接由我们顶上，不看小爱答了什么**。
 *
 * 为什么不看回答（2026-10-09 用户拍的）：这台音箱没有音乐会员，小爱接住点歌口令后回的永远是
 * 「请欣赏X 试听版，手机打开小米音箱APP，开通音乐会员听全曲」那一套 —— **它答得越顺，端上来的越是
 * 30 秒片段**（实测设备 `duration=30024ms`，而我们搜到的《七里香》整曲是 04:59）。
 * 所以"它答上了没"这一格根本不该拦事：它是"它把口令接走了"的证据，不是"它办成了"的证据。
 *
 * 两层短路（顺序是有意的，越靠前越便宜、越确定）：
 *  ① 本地控制词表命中 ⇒ 直接执行（零网络零 LLM，见 `voice-control.ts`）；
 *  ② 命中点歌触发词 ⇒ 去我们的曲库搜，够像、且是整曲，就顶上；
 *  ③ 都对不上就什么都不做（可选的 LLM 那层还没接：AI 凭据现在只在浏览器 localStorage，
 *     服务端拿不到，要做得先把凭据落 AppSetting —— 那是另一件事，不在这儿偷偷加）。
 *
 * 第②层为什么要有：小爱自己的音乐检索覆盖不到我们的曲库（我们聚合的歌、我们自己转码的文件），
 * 但它**会先接住那句口令**，所以我们不抢，它就只放片段。
 *
 * **这条路的代价要记清**：不看回答，就没有任何东西替你判"这句话到底是不是点歌"。所以剩下三道闸
 * 一道都不许松 —— 触发词（面板可改，默认表刻意不收单个"放"字）、相似度门槛 0.75、"像整曲"的时长门槛。
 * 已知挡不住的一类：「我想听你说个笑话」这种**含触发词但不是点歌**的句子会去搜歌（然后大多 no-hit）；
 * 真撞上就靠把那个词从面板词表里摘掉，不靠在这里堆黑名单。
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
  | 'control' | 'takeover' | 'no-hit' | 'stale' | 'rejected' | 'not-music'

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
 * 决定要不要接管。纯函数：不查库、不打网络，好让这几层判据能钉在测试里。
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

  // 只看这句话，不看小爱答了什么（理由见文件头）
  const triggers = (config.takeoverTriggers?.length ? config.takeoverTriggers : DEFAULT_MUSIC_TRIGGERS)
  const trigger = matchMusicTrigger(query, triggers)
  if (!trigger) return { verdict: 'not-music', reason: `没命中点歌触发词，不动：「${query.slice(0, 20)}」` }

  // 拿去掉触发词的那半句去搜：整句「播放稻香」会让匹配度被多出来的两个字拖低
  const { best: cand, skippedShort } = await pickCandidate(query.replace(trigger, '') || query, config)
  // 门槛挡掉几条要写在理由里：不然面板上只显示"没搜到"，管理员分不清是真没有还是被自己填高的门槛清了
  const shortNote = skippedShort > 0 ? `（另有 ${skippedShort} 条被"像整曲"的门槛挡掉，那格填 0 可关）` : ''
  if (!cand) return { verdict: 'no-hit', reason: `我们这边也没搜到像「${query.slice(0, 20)}」的歌，不动${shortNote}` }
  if (cand.score < config.fuzzyMatchCutoff) {
    return { verdict: 'no-hit', reason: `最像的是「${cand.name}」但只有 ${(cand.score * 100).toFixed(0)}%，低于 ${(config.fuzzyMatchCutoff * 100).toFixed(0)}%` }
  }
  return {
    verdict: 'takeover',
    reason: `说了点歌（「${trigger}」），顶上整曲「${cand.name}」(${(cand.score * 100).toFixed(0)}%)`,
    uid: cand.uid, name: cand.name, score: cand.score,
  }
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
/**
 * 账本与队列同样挂 `globalThis`：模块被热重载复制成几份时，**串行队列必须是同一条** ——
 * 两份各有各的 `chain`，等于两句话并发去抢同一条 ubus 队（这正是它当初要串行的理由）。
 * 同一进程内的同一份账也才拼得出最近 40 条这个上限。
 */
interface TakeoverRuntime { log: TakeoverLogRow[]; chain: Promise<unknown> }
const globalWithRt = globalThis as typeof globalThis & { __xiaomiVoiceTakeover?: TakeoverRuntime }
const rt: TakeoverRuntime = globalWithRt.__xiaomiVoiceTakeover ??= { log: [], chain: Promise.resolve() }

export function getTakeoverLog(): TakeoverLogRow[] {
  return rt.log.slice(0, LOG_MAX)
}

function pushLog(row: TakeoverLogRow): void {
  rt.log.unshift(row)
  if (rt.log.length > LOG_MAX) rt.log.length = LOG_MAX
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
  // 分段计时是照着"从说完话到音箱出声 14 秒"这条实测摆的：判据（含搜歌）与执行（含推流）
  // 分开看才知道该压哪一段，别到时候又靠猜
  const decideStart = Date.now()
  const d = await decideTakeover(row, config)
  const decideMs = Date.now() - decideStart
  const actStart = Date.now()
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
    } else if (d.verdict === 'not-music') {
      acted = '没动（没命中点歌触发词）'
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
    判据ms: decideMs, 执行ms: Date.now() - actStart,
  })
  return entry
}

/**
 * 轮询那边调这个：不 await，排队做，别把一拍拖长（处理期间也不许插进下一条）。
 *
 * `done` 拿到的是**同一条判定记录对象**（对话回显那一行靠它把"处置"就地显示出来，
 * 省得管理员在两张表之间对齐同一句话）。异常不许冒出去：口令处理失败最坏就是"这句没接住"。
 */
export function submitAsk(row: AskRow, done?: (entry: TakeoverLogRow) => void): void {
  rt.chain = rt.chain.then(async () => {
    const entry = await handleAskNow(row)
    try {
      done?.(entry)
    } catch (err) {
      logger.warn('[voice-takeover] 判定回填失败:', err instanceof Error ? err.message : String(err))
    }
  }).catch(err => {
    logger.warn('[voice-takeover] 排队的一条处理异常:', err instanceof Error ? err.message : String(err))
  })
}

/** 只给测试用 */
export function _resetVoiceTakeoverForTest(): void {
  rt.log.length = 0
  rt.chain = Promise.resolve()
}

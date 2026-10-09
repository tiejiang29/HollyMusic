/**
 * 小爱网关的凭据与设备表读写（G0）。
 *
 * 存储按用户 2026-10-07 定的形态：**`AppSetting` 单键 `speaker`，值是 JSON**，
 * 与 `sourceDiscovery` 同构 —— 管理员在面板里改、不写配置文件也不走环境变量，
 * 也省掉一次"只为两张表"的迁移。
 *
 * 三条硬约定：
 * 1. `serviceToken` / `passToken` 原值**只进库不出网**：任何 GET 视图只能拿 `maskSecret` 后的尾巴
 *    （我们有过一次 wire 日志泄露会话 cookie 的事故 `0b33df9`，同类东西一律按凭据对待）；
 * 2. `serviceToken` 约 12 小时有效，**剩不到 3 小时就主动用 `passToken` 换一张**；
 *    换不到就报明确身份（要重新扫码），不拿 500 糊过去；
 * 3. 设备表要留 `hardware` —— G1 判"这台走 `player_play_music` 还是 `player_play_url`"只看它。
 */
import { logger } from '@/lib/logger'
import { maskSecret, readSetting, writeSetting } from '@/lib/services/app-setting'
import {
  SERVICE_TOKEN_TTL_MS,
  XiaomiLoginError,
  exchangeServiceToken,
  type XiaomiCredentials,
} from '@/lib/services/xiaomi/qr-login'
import { XiaomiAuthError, fetchDevices, type SpeakerDevice } from '@/lib/services/xiaomi/mina-client'
import { DEFAULT_CONTROL_RULES, DEFAULT_MUSIC_TRIGGERS, type ControlRule } from '@/lib/services/xiaomi/voice-control'

export const SPEAKER_SETTING_KEY = 'speaker'

/** 到期前 3 小时就刷，避免管理员正好在边界上点到一个死票 */
const REFRESH_AHEAD_MS = 3 * 60 * 60 * 1000

/**
 * 两次续期之间的最小间隔：小米对频繁登录是限流的（`code=70022`，连续失败还会进更长的冷却），
 * 而管理员连点几下"刷新设备列表"就会连着打 serviceLogin —— 没这道闸就是我们自己攒风控。
 * 参照 miot 的 `RELOGIN_MIN_INTERVAL_MS` 与 xiaomusic 的 `LOGIN_COOLDOWN_SEC`。
 */
const RENEW_MIN_INTERVAL_MS = 60 * 1000

/** 上一次真打出网续票的时刻（进程内，重启即清零 —— 清零后最多也就多续一次） */
let lastRenewAt = 0

export interface SpeakerConfig {
  /** 总开关：给 G1/G2 的自动任务看（关掉就不推歌、不轮对话）。
   *  面板上的手动动作不受它管 —— 关着也要能刷新设备列表、能看清登录状态 */
  enabled: boolean
  credentials: XiaomiCredentials | null
  devices: SpeakerDevice[]
  lastSyncAt: string | null
  /** 最近一次失败的**脱敏**原因，给面板说明"为什么显示未登录" */
  lastError: string | null
  /**
   * 推给音箱的音频地址用哪个主机名（G1）。**必须填音箱够得着的局域网地址** ——
   * 我们从后台/公网看到的 host（回环、隧道地址、域名反代）音箱多半拉不到。
   * 空 = 没配，此时推歌会明确报"先在面板上填音箱可达的服务地址"，不会拼一个听起来能播其实放不出的 URL。
   */
  serverHost: string
  /** 投歌用的音质档（音箱只可靠播 MP3，所以只允许 MP3 两档；G1.5 转码上线后再谈 flac） */
  playQuality: SpeakerPlayQuality
  /** 管理员显式禁用某型号的 Music API（参考实现也有这个覆盖位，兼容性问题时用来降级） */
  musicApiDisabledModels: string[]
  /** 对话轮询开关（G0.5）。默认关着 —— 它会常驻打小米，得管理员明确要量才开 */
  conversationEnabled: boolean
  /** 对话轮询间隔（秒），1~30 */
  conversationPollSec: number
  /** 疑似"小爱没答上"的话术片段（面板可改）：G3 拿它判要不要接管 */
  failedAnswerHints: string[]
  /**
   * 语音接管总开关（G3）。**默认关着**：它一开就是"听了你说的话就动那台音箱"。
   * （原来这条注释写的"前提没验过、平台回 0 条"已作废 —— 记录拉得到，是我们把 Cookie 的
   * deviceId 填成了登录那台设备，2026-10-09 修在 51b2f72。）
   */
  takeoverEnabled: boolean
  /** 拿不到小爱的回答时站哪边：false=不动（默认），true=也接管。这条是留给管理员定的，不替他判 */
  takeoverWithoutEvidence: boolean
  /**
   * 读回答要等多久（秒，0~10）。**0~10 的来源是 mi-song-gpt 的上限**：对话记录是先落 query、
   * 回答晚一点才补进同一条，所以"空回答"里混着"我们读早了"这一类，等满窗口再判才不脏。
   * 0 = 退回老行为（读到空就立刻判没证据）。
   */
  takeoverAnswerWaitSec: number
  /**
   * 候选要"像整曲"的门槛（秒，0=关）。防的是我们自己也挑到 30 秒铃声/剪辑版：
   * 2026-10-09 实测小爱给的是 30024ms 的片段，而《你不知道》整曲是 225s。
   * **只用来"过短就不选"，不用来"不等就拒"** —— 元数据时长本身也会错（见 audioServe 那条
   * 「试听片段不落库: kw:440613 实际=224s 期望=304s」）。
   */
  takeoverMinTrackSec: number
  /** 曲名相似度门槛（0~1）：低于它就算搜到了也不认（防"今天几号"被硬配上一首歌） */
  fuzzyMatchCutoff: number
  /** 接管时去哪几台源搜候选（按顺序试，最多用前三台） */
  takeoverSources: string[]
  /** 第①层那张控制词表（面板可改；空则回落到代码里的默认表） */
  controlRules: ControlRule[]
  /** "大声点/小声点"一次调几档 */
  volumeStep: number
  /** 第②层的门槛：这句话里要有哪个词才算点歌（面板可改） */
  takeoverTriggers: string[]
}

export type SpeakerPlayQuality = '320k' | '128k'

/**
 * 默认的"疑似没答上"话术片段。
 *
 * 注意来源：三个参考实现（miot / miservice / xiaomusic）里**都没有**这种词表 —— 它们靠拦截用户
 * 口令，不读小爱的回答。这份是我按常见小爱拒绝话术自己列的**初稿**，必须靠 G0.5 面板上的
 * 真实回显来校准后再信它，所以现在只用于"标记 + 计数"，不参与任何自动决策。
 */
export const DEFAULT_FAILED_ANSWER_HINTS = [
  '没有找到', '没找到', '找不到', '没有搜索到', '暂未找到',
  '暂时还没有', '暂无', '不太明白', '没听清', '再说一遍', '换个说法',
  '我还不能', '还不会', '服务开小差', '出了点问题', '稍后再试',
]

/** 轮询间隔的合法区间（照参考实现：miot 1~30s、xiaomusic 也有下限），下限防的是把小米接口打爆 */
export const CONVERSATION_POLL_SEC_MIN = 1
export const CONVERSATION_POLL_SEC_MAX = 30

/** 相似度门槛合法区间：低于 0.2 什么都能配上，高于 0.95 基本永远配不上 */
export const FUZZY_CUTOFF_MIN = 0.2
export const FUZZY_CUTOFF_MAX = 0.95
/**
 * 默认门槛。2026-10-09 用 16 条真实形状的口令在判据上扫出来的分布：
 * 对的那些（含"播放周杰伦的七里香""我想听一下告白气球"）**全是 100%**（相等或包含命中），
 * 该拒的最高只有 67%（打错字的"喜欢您"→《喜欢你》），垃圾那批是 0/25/31/43/60%。
 * 0.6 会放过"稻香这首歌"→《青春这首歌》这种**共用尾缀**的错配；0.75 与 0.85 在这批上
 * 结果完全一样，所以取一个中间偏宽的 0.75。
 */
export const FUZZY_CUTOFF_DEFAULT = 0.75
/** 音量步长合法区间（一次"大声点"调几档） */
export const VOLUME_STEP_MIN = 1
export const VOLUME_STEP_MAX = 50

export function clampCutoff(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return FUZZY_CUTOFF_DEFAULT
  return Math.min(FUZZY_CUTOFF_MAX, Math.max(FUZZY_CUTOFF_MIN, n))
}

export function clampVolumeStep(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 10
  return Math.min(VOLUME_STEP_MAX, Math.max(VOLUME_STEP_MIN, Math.round(n)))
}

/** 等回答的合法区间：0=不等（老行为），上限照 mi-song-gpt 的 10 秒，再长用户就听到小爱说完了 */
export const ANSWER_WAIT_SEC_MIN = 0
export const ANSWER_WAIT_SEC_MAX = 10
export const ANSWER_WAIT_SEC_DEFAULT = 6
/** "像整曲"的门槛上限取 10 分钟，防止填成 999 之类把候选清光 */
export const MIN_TRACK_SEC_MAX = 600

export function clampAnswerWaitSec(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return ANSWER_WAIT_SEC_DEFAULT
  return Math.min(ANSWER_WAIT_SEC_MAX, Math.max(ANSWER_WAIT_SEC_MIN, Math.round(n)))
}

export function clampMinTrackSec(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 90
  return Math.min(MIN_TRACK_SEC_MAX, Math.max(0, Math.round(n)))
}

const DEFAULT_CONFIG: SpeakerConfig = {
  enabled: false,
  credentials: null,
  devices: [],
  lastSyncAt: null,
  lastError: null,
  serverHost: '',
  playQuality: '320k',
  musicApiDisabledModels: [],
  conversationEnabled: false,
  conversationPollSec: 2,
  failedAnswerHints: DEFAULT_FAILED_ANSWER_HINTS,
  takeoverEnabled: false,
  takeoverWithoutEvidence: false,
  takeoverAnswerWaitSec: ANSWER_WAIT_SEC_DEFAULT,
  takeoverMinTrackSec: 90,
  fuzzyMatchCutoff: FUZZY_CUTOFF_DEFAULT,
  takeoverSources: ['tx'],
  controlRules: DEFAULT_CONTROL_RULES,
  volumeStep: 10,
  takeoverTriggers: DEFAULT_MUSIC_TRIGGERS,
}

/**
 * 读配置。**必须补齐缺键**：G0 那版库里存的对象没有 `conversationEnabled`/`failedAnswerHints` 这些新字段，
 * 原样返回会让下面拿到 undefined（`undefined.filter(...)` 就是 500），而这台 NAS 上不会有人重新保存一遍配置。
 */
export async function readSpeakerConfig(): Promise<SpeakerConfig> {
  const stored = await readSetting<Partial<SpeakerConfig>>(SPEAKER_SETTING_KEY, DEFAULT_CONFIG)
  // 转码那一期整块撤了，但库里那行 JSON 还留着它四个键：读的时候抹掉，
  // 免得下次写回时把没人读的旧配置又带一圈（面板上也别显示一个不生效的 ffmpeg 路径）
  delete (stored as Record<string, unknown>).transcodeEnabled
  delete (stored as Record<string, unknown>).ffmpegPath
  delete (stored as Record<string, unknown>).transcodeNormalize
  delete (stored as Record<string, unknown>).transcodeCapMb
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    devices: Array.isArray(stored.devices) ? stored.devices : [],
    musicApiDisabledModels: Array.isArray(stored.musicApiDisabledModels) ? stored.musicApiDisabledModels : [],
    failedAnswerHints: Array.isArray(stored.failedAnswerHints) && stored.failedAnswerHints.length > 0
      ? stored.failedAnswerHints
      : DEFAULT_FAILED_ANSWER_HINTS,
    conversationPollSec: clampPollSec(stored.conversationPollSec),
    // 接管那几项：词表存坏了（不是数组/空数组）要回落到默认表，否则第①层会一条都命不中
    takeoverEnabled: !!stored.takeoverEnabled,
    takeoverWithoutEvidence: !!stored.takeoverWithoutEvidence,
    takeoverAnswerWaitSec: clampAnswerWaitSec(stored.takeoverAnswerWaitSec),
    takeoverMinTrackSec: clampMinTrackSec(stored.takeoverMinTrackSec),
    fuzzyMatchCutoff: clampCutoff(stored.fuzzyMatchCutoff),
    takeoverSources: Array.isArray(stored.takeoverSources) && stored.takeoverSources.length
      ? stored.takeoverSources.map(s => String(s)) : DEFAULT_CONFIG.takeoverSources,
    controlRules: Array.isArray(stored.controlRules) && stored.controlRules.length > 0
      ? stored.controlRules.filter(r => r && typeof r.op === 'string' && Array.isArray(r.words))
      : DEFAULT_CONTROL_RULES,
    volumeStep: clampVolumeStep(stored.volumeStep),
    takeoverTriggers: Array.isArray(stored.takeoverTriggers) && stored.takeoverTriggers.length
      ? stored.takeoverTriggers.map(t => String(t)) : DEFAULT_MUSIC_TRIGGERS,
  }
}

/** 间隔夹到合法区间；坏值（undefined/NaN/0）退回默认 2 秒，不把它变成"每 0 秒打一次小米" */
export function clampPollSec(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.conversationPollSec
  return Math.min(CONVERSATION_POLL_SEC_MAX, Math.max(CONVERSATION_POLL_SEC_MIN, Math.round(n)))
}

export async function writeSpeakerConfig(config: SpeakerConfig): Promise<void> {
  await writeSetting(SPEAKER_SETTING_KEY, config)
}

/** 面板与 API 能看到的全部：没有任何一种凭据原值 */
export interface SpeakerView {
  enabled: boolean
  loggedIn: boolean
  accountTail: string
  tokenTail: string
  expiresAt: string | null
  /** 票还剩多久；负数 = 已过期（等下一次操作去续并如实报错） */
  msToExpiry: number | null
  needsRefresh: boolean
  devices: SpeakerDevice[]
  lastSyncAt: string | null
  lastError: string | null
  /** G1 之后面板要能改这三样（管理员要调的都在面板上，不写配置文件） */
  serverHost: string
  playQuality: SpeakerPlayQuality
  musicApiDisabledModels: string[]
  conversationEnabled: boolean
  conversationPollSec: number
  failedAnswerHints: string[]
  /** 语音接管（G3）那几项 */
  takeoverEnabled: boolean
  takeoverWithoutEvidence: boolean
  takeoverAnswerWaitSec: number
  takeoverMinTrackSec: number
  fuzzyMatchCutoff: number
  takeoverSources: string[]
  controlRules: ControlRule[]
  volumeStep: number
  takeoverTriggers: string[]
}

export async function getSpeakerView(): Promise<SpeakerView> {
  const config = await readSpeakerConfig()
  const creds = config.credentials
  const expiresAtMs = creds ? Date.parse(creds.expiresAt) : null
  const msToExpiry = expiresAtMs === null || !Number.isFinite(expiresAtMs) ? null : expiresAtMs - Date.now()
  return {
    enabled: config.enabled,
    loggedIn: !!creds?.serviceToken,
    accountTail: creds?.accountTail ?? '',
    tokenTail: creds?.serviceToken ? maskSecret(creds.serviceToken) : '',
    expiresAt: creds?.expiresAt ?? null,
    msToExpiry,
    needsRefresh: msToExpiry === null ? false : msToExpiry < REFRESH_AHEAD_MS,
    devices: config.devices,
    lastSyncAt: config.lastSyncAt,
    lastError: config.lastError,
    serverHost: config.serverHost,
    playQuality: config.playQuality,
    musicApiDisabledModels: config.musicApiDisabledModels,
    conversationEnabled: config.conversationEnabled,
    conversationPollSec: config.conversationPollSec,
    failedAnswerHints: config.failedAnswerHints,
    takeoverEnabled: config.takeoverEnabled,
    takeoverWithoutEvidence: config.takeoverWithoutEvidence,
    takeoverAnswerWaitSec: config.takeoverAnswerWaitSec,
    takeoverMinTrackSec: config.takeoverMinTrackSec,
    fuzzyMatchCutoff: config.fuzzyMatchCutoff,
    takeoverSources: config.takeoverSources,
    controlRules: config.controlRules,
    volumeStep: config.volumeStep,
    takeoverTriggers: config.takeoverTriggers,
  }
}

/**
 * 接管那几项都是面板项（G3）。词表传进来的是**已经解析好的规则**（路由用 `parseControlRules`
 * 把面板那几行文本转过来）；解析成空表时这里回落到默认表 —— 空表会让第①层一条都命不中，
 * 那种"配了等于没配"最难查。
 */
export async function setSpeakerTakeover(input: {
  enabled?: boolean; withoutEvidence?: boolean; cutoff?: unknown;
  sources?: string[]; controlRules?: ControlRule[]; volumeStep?: unknown; triggers?: string[];
  answerWaitSec?: unknown; minTrackSec?: unknown;
}): Promise<SpeakerView> {
  const config = await readSpeakerConfig()
  if (typeof input.enabled === 'boolean') config.takeoverEnabled = input.enabled
  if (typeof input.withoutEvidence === 'boolean') config.takeoverWithoutEvidence = input.withoutEvidence
  if (input.cutoff !== undefined) config.fuzzyMatchCutoff = clampCutoff(input.cutoff)
  if (input.answerWaitSec !== undefined) config.takeoverAnswerWaitSec = clampAnswerWaitSec(input.answerWaitSec)
  if (input.minTrackSec !== undefined) config.takeoverMinTrackSec = clampMinTrackSec(input.minTrackSec)
  if (Array.isArray(input.sources)) {
    const list = input.sources.map(x => String(x).trim()).filter(Boolean).slice(0, 3)
    if (list.length) config.takeoverSources = list
  }
  if (Array.isArray(input.controlRules) && input.controlRules.length) config.controlRules = input.controlRules
  if (input.volumeStep !== undefined) config.volumeStep = clampVolumeStep(input.volumeStep)
  if (Array.isArray(input.triggers)) {
    const list = input.triggers.map(t => String(t).trim()).filter(Boolean)
    if (list.length) config.takeoverTriggers = list
  }
  await writeSpeakerConfig(config)
  return getSpeakerView()
}

export async function setSpeakerEnabled(enabled: boolean): Promise<void> {
  const config = await readSpeakerConfig()
  await writeSpeakerConfig({ ...config, enabled })
}

/**
 * 音箱拉流用的主机名。空串 = 没配（此时推歌会明确报错，不静默拼一个回环地址）。
 * 传进来时只裁首尾空格 —— 大小写、带不带端口这些交给 `buildStreamBase` 去判并说清。
 */
export async function setSpeakerServerHost(serverHost: string): Promise<void> {
  const config = await readSpeakerConfig()
  await writeSpeakerConfig({ ...config, serverHost: serverHost.trim() })
}

export async function setSpeakerPlayQuality(playQuality: SpeakerPlayQuality): Promise<void> {
  if (playQuality !== '320k' && playQuality !== '128k') {
    throw new XiaomiLoginError('音箱只支持 MP3 两档（320k / 128k）', 400)
  }
  const config = await readSpeakerConfig()
  await writeSpeakerConfig({ ...config, playQuality })
}

/** 某个型号推歌有问题时，管理员可以把它从 Music API 名单里摘掉（退回 player_play_url） */
/** 面板项：对话轮询开关 + 间隔 + 失败话术片段（G0.5/G3 都用这一处） */
export async function setSpeakerConversation(input: {
  enabled?: boolean; pollSec?: unknown; failedAnswerHints?: string[]; deviceID?: string;
}): Promise<SpeakerView> {
  const config = await readSpeakerConfig()
  if (typeof input.enabled === 'boolean') config.conversationEnabled = input.enabled
  if (input.pollSec !== undefined) config.conversationPollSec = clampPollSec(input.pollSec)
  if (Array.isArray(input.failedAnswerHints)) {
    const hints = input.failedAnswerHints.map(h => String(h).trim()).filter(Boolean)
    config.failedAnswerHints = hints.length > 0 ? hints : DEFAULT_FAILED_ANSWER_HINTS
  }
  await writeSpeakerConfig(config)
  return getSpeakerView()
}

export async function setSpeakerMusicApiDisabled(models: string[]): Promise<void> {
  const config = await readSpeakerConfig()
  const cleaned = [...new Set(models.map(m => String(m ?? '').trim().toUpperCase()).filter(Boolean))]
  await writeSpeakerConfig({ ...config, musicApiDisabledModels: cleaned })
}

/** 扫码成功后落凭据；换账号扫码时旧设备表一起清掉（那是另一个账号的音箱） */
export async function saveCredentials(creds: XiaomiCredentials): Promise<void> {
  const config = await readSpeakerConfig()
  const sameAccount = config.credentials?.userId === creds.userId
  await writeSpeakerConfig({
    ...config,
    enabled: true,
    credentials: creds,
    devices: sameAccount ? config.devices : [],
    lastError: null,
  })
}

export async function clearSpeakerLogin(): Promise<void> {
  const config = await readSpeakerConfig()
  await writeSpeakerConfig({ ...config, enabled: false, credentials: null, devices: [], lastSyncAt: null, lastError: null })
  logger.info('[xiaomi] 已退出小爱登录并清空设备表')
}

/**
 * 用 `passToken` 静默换一张新票（不需要重新扫码）。
 * 换票失败时**不清凭据** —— passToken 大概率还在，下一次操作还能再试；
 * 只有明确"这张 passToken 也不行了"才叫管理员重扫。
 *
 * **换到的票要先打一次设备列表才算数**（照 miot 的 `validateToken`）：光看"接口给了票"不够，
 * 一张开不了门的票存进库以后，面板会显示"已登录"、每次操作却都失败，比明说"要重扫"难查得多。
 * 验证拿回 401 类的错就当这张票不行（不落库）；只是上游抖动/超时（502 类）则不牵连新票 ——
 * 换票这一步确实成功了，没能证明它是坏的，那就先存着（`devices` 带回 null 让调用方自己再试）。
 *
 * 返回值分三种而不是 `creds | null`：调用方要把"60 秒内刚试过所以没打"和"打了但没换成"
 * 说成两句话，前者叫管理员等一会儿，后者才叫重新扫码。
 */
type RenewOutcome =
  | { state: 'ok'; creds: XiaomiCredentials; devices: SpeakerDevice[] | null }
  | { state: 'throttled' }
  | { state: 'failed' }

async function renew(config: SpeakerConfig): Promise<RenewOutcome> {
  const old = config.credentials
  if (!old?.passToken || !old.userId) return { state: 'failed' }
  if (Date.now() - lastRenewAt < RENEW_MIN_INTERVAL_MS) {
    // 60 秒内已经试过一次就不再打出网请求（小米对频繁登录限流：70022，连续失败还会进更长冷却）
    logger.warn('[xiaomi] 距上次续期不足 60 秒，本轮跳过')
    return { state: 'throttled' }
  }
  lastRenewAt = Date.now()
  try {
    const { serviceToken } = await exchangeServiceToken({
      passToken: old.passToken,
      userId: old.userId,
      cUserId: old.cUserId,
      deviceId: old.deviceId,
    })
    const next: XiaomiCredentials = {
      ...old,
      serviceToken,
      expiresAt: new Date(Date.now() + SERVICE_TOKEN_TTL_MS).toISOString(),
      // passToken 每次换取也可能轮换，拿新的留着才续得上
    }
    let devices: SpeakerDevice[] | null = null
    try {
      devices = await fetchDevices(next)
    } catch (err) {
      if (err instanceof XiaomiAuthError && err.status === 401) {
        await writeSpeakerConfig({ ...config, lastError: '续到的新票打不开设备列表，请在面板上重新扫码' })
        logger.warn('[xiaomi] 续到的新票验证失败（401 类），不写回凭据')
        return { state: 'failed' }
      }
      logger.warn('[xiaomi] 续期后验证没打成（上游抖动），新票照存', {
        原因: err instanceof Error ? err.message.slice(0, 120) : String(err),
      })
    }
    await writeSpeakerConfig({ ...config, credentials: next, lastError: null })
    logger.info('[xiaomi] 已用 passToken 静默续期 serviceToken', {
      账号尾号: next.accountTail,
      验证: devices ? `通过（${devices.length} 台）` : '未复验（设备列表那次没打成）',
    })
    return { state: 'ok', creds: next, devices }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await writeSpeakerConfig({ ...config, lastError: `续期失败：${message.slice(0, 120)}` })
    logger.warn('[xiaomi] 静默续期失败:', message.slice(0, 140))
    return { state: 'failed' }
  }
}

/**
 * 拿一张能用的票：优先用没到刷新窗口的现票；否则续期；续期后仍过期就抛明确错误。
 *
 * 这里刻意**不在票过期时直接清凭据** —— 管理员看到"需要重新扫码"和"小米那边临时抽了"
 * 是两件事，后者重试就好，清凭据会把人家逼去重扫一遍。
 */
export async function ensureFreshCredentials(): Promise<XiaomiCredentials> {
  const config = await readSpeakerConfig()
  const creds = config.credentials
  if (!creds?.serviceToken) {
    throw new XiaomiAuthError('还没有登录小爱账号（面板上扫码登录）', 401)
  }
  const msToExpiry = Date.parse(creds.expiresAt) - Date.now()
  if (Number.isFinite(msToExpiry) && msToExpiry > REFRESH_AHEAD_MS) return creds

  const renewed = await renew(config)
  if (renewed.state === 'ok') return renewed.creds
  if (Number.isFinite(msToExpiry) && msToExpiry <= 0) {
    throw new XiaomiAuthError(
      renewed.state === 'throttled'
        ? '刚刚试过续票（60 秒内不再重复打小米），过一会儿再点一次；一直不行才需要重新扫码'
        : '小爱的票已过期且静默续期没成功，请在面板上重新扫码',
      401,
    )
  }
  // 票还没到期，续期失败只是少了一次刷新，先用着
  return creds
}

/** 拉一次设备列表；遇到"票不行"就当场续一次再试一遍 */
export async function syncDevices(): Promise<SpeakerDevice[]> {
  let creds = await ensureFreshCredentials()
  let devices: SpeakerDevice[]
  try {
    devices = await fetchDevices(creds)
  } catch (err) {
    // 只有"票不行"（401 身份，含 code=70016）才值得当场续一张再试：上游 5xx / 非 JSON 拿去续票
    // 只会白跑一趟，还会把一次网络抖动写成"续期失败"，管理员看到的错就变成假的。
    if (!(err instanceof XiaomiAuthError) || err.status !== 401) throw err
    const renewed = await renew(await readSpeakerConfig())
    if (renewed.state !== 'ok') throw err
    creds = renewed.creds
    // 续期那一步已经拿新票打过一次设备列表了，能直接用就别再打第二遍
    devices = renewed.devices ?? await fetchDevices(creds)
  }
  const config = await readSpeakerConfig()
  // managed 是管理员的手动标记，刷新列表时按 deviceID 保住它
  const managedById = new Map(config.devices.map(d => [d.deviceID, d.managed]))
  const merged = devices.map(d => ({ ...d, managed: managedById.get(d.deviceID) ?? d.managed }))
  await writeSpeakerConfig({ ...config, devices: merged, lastSyncAt: new Date().toISOString(), lastError: null })
  logger.info('[xiaomi] 设备列表已更新', { 台数: merged.length })
  return merged
}

/** 面板上勾选"纳管/不纳管"这一台 */
export async function setDeviceManaged(deviceID: string, managed: boolean): Promise<void> {
  const config = await readSpeakerConfig()
  if (!config.devices.some(d => d.deviceID === deviceID)) {
    throw new XiaomiLoginError('这台设备不在列表里，请先刷新设备列表', 404)
  }
  await writeSpeakerConfig({
    ...config,
    devices: config.devices.map(d => (d.deviceID === deviceID ? { ...d, managed } : d)),
  })
}

export { XiaomiAuthError, XiaomiLoginError }
export type { SpeakerDevice, XiaomiCredentials }

/** 只给测试用：续期节流是进程内状态，不清掉同一批用例里第二条就测不动了 */
export function _resetRenewThrottleForTest(): void {
  lastRenewAt = 0
}

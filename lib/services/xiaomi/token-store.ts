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
   * 转码出口开关（G1.5）：库里不是 MP3 的那些（本地导入的 `loc-`、平台只剩更高档）
   * 靠它变成能投。关掉就退回旧行为——非 MP3 改走在线取 MP3 档，取不到就明确报错。
   */
  transcodeEnabled: boolean
  /**
   * ffmpeg 可执行文件：PATH 里的名字（默认 `ffmpeg`）或绝对路径。
   * 生产镜像里**没有** ffmpeg（本仓库的镜像只装了 nginx/openssl），所以这栏在 NAS 上要填
   * 容器里能用的东西，或者等镜像带上它 —— 不要假装它一定存在，探不到就是探不到。
   */
  ffmpegPath: string
  /** 响度归一化（`loudnorm`）：实测慢一个量级，默认关 */
  transcodeNormalize: boolean
  /** 转码产物总占用上限（MB），按 lastAccessAt 淘汰；0 = 不设限 */
  transcodeCapMb: number
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

/** 转码产物容量闸的合法区间（MB），0 = 不设限 */
export const TRANSCODE_CAP_MB_MIN = 0
export const TRANSCODE_CAP_MB_MAX = 20_000

export function clampCapMb(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 500
  return Math.min(TRANSCODE_CAP_MB_MAX, Math.max(TRANSCODE_CAP_MB_MIN, Math.round(n)))
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
  transcodeEnabled: true,
  ffmpegPath: 'ffmpeg',
  transcodeNormalize: false,
  transcodeCapMb: 500,
}

/**
 * 读配置。**必须补齐缺键**：G0 那版库里存的对象没有 `conversationEnabled`/`failedAnswerHints` 这些新字段，
 * 原样返回会让下面拿到 undefined（`undefined.filter(...)` 就是 500），而这台 NAS 上不会有人重新保存一遍配置。
 */
export async function readSpeakerConfig(): Promise<SpeakerConfig> {
  const stored = await readSetting<Partial<SpeakerConfig>>(SPEAKER_SETTING_KEY, DEFAULT_CONFIG)
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    devices: Array.isArray(stored.devices) ? stored.devices : [],
    musicApiDisabledModels: Array.isArray(stored.musicApiDisabledModels) ? stored.musicApiDisabledModels : [],
    failedAnswerHints: Array.isArray(stored.failedAnswerHints) && stored.failedAnswerHints.length > 0
      ? stored.failedAnswerHints
      : DEFAULT_FAILED_ANSWER_HINTS,
    conversationPollSec: clampPollSec(stored.conversationPollSec),
    // 老库里存的对象同样没有转码这四个键：`ffmpegPath` 为空串会让每次 spawn 都失败在起跑线，
    // 所以这里补默认值，不指望有人重新保存一遍配置
    ffmpegPath: typeof stored.ffmpegPath === 'string' && stored.ffmpegPath.trim()
      ? stored.ffmpegPath.trim() : DEFAULT_CONFIG.ffmpegPath,
    transcodeCapMb: clampCapMb(stored.transcodeCapMb),
    transcodeEnabled: stored.transcodeEnabled !== false,
    transcodeNormalize: !!stored.transcodeNormalize,
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
  /** 转码出口（G1.5）：库里非 MP3 的那些靠它变成能投 */
  transcodeEnabled: boolean
  ffmpegPath: string
  transcodeNormalize: boolean
  transcodeCapMb: number
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
    transcodeEnabled: config.transcodeEnabled,
    ffmpegPath: config.ffmpegPath,
    transcodeNormalize: config.transcodeNormalize,
    transcodeCapMb: config.transcodeCapMb,
  }
}

/** 转码那四项（G1.5）：都是面板项，缺省位不传就不动 */
export async function setSpeakerTranscode(input: {
  enabled?: boolean; ffmpegPath?: unknown; normalize?: boolean; capMb?: unknown;
}): Promise<SpeakerView> {
  const config = await readSpeakerConfig()
  if (typeof input.enabled === 'boolean') config.transcodeEnabled = input.enabled
  if (typeof input.ffmpegPath === 'string') config.ffmpegPath = input.ffmpegPath.trim() || DEFAULT_CONFIG.ffmpegPath
  if (typeof input.normalize === 'boolean') config.transcodeNormalize = input.normalize
  if (input.capMb !== undefined) config.transcodeCapMb = clampCapMb(input.capMb)
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

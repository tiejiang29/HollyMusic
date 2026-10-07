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

export interface SpeakerConfig {
  /** 总开关：给 G1/G2 的自动任务看（关掉就不推歌、不轮对话）。
   *  面板上的手动动作不受它管 —— 关着也要能刷新设备列表、能看清登录状态 */
  enabled: boolean
  credentials: XiaomiCredentials | null
  devices: SpeakerDevice[]
  lastSyncAt: string | null
  /** 最近一次失败的**脱敏**原因，给面板说明"为什么显示未登录" */
  lastError: string | null
}

const DEFAULT_CONFIG: SpeakerConfig = {
  enabled: false,
  credentials: null,
  devices: [],
  lastSyncAt: null,
  lastError: null,
}

export async function readSpeakerConfig(): Promise<SpeakerConfig> {
  return readSetting<SpeakerConfig>(SPEAKER_SETTING_KEY, DEFAULT_CONFIG)
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
  }
}

export async function setSpeakerEnabled(enabled: boolean): Promise<void> {
  const config = await readSpeakerConfig()
  await writeSpeakerConfig({ ...config, enabled })
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
 */
async function renew(config: SpeakerConfig): Promise<XiaomiCredentials | null> {
  const old = config.credentials
  if (!old?.passToken || !old.userId) return null
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
    await writeSpeakerConfig({ ...config, credentials: next, lastError: null })
    logger.info('[xiaomi] 已用 passToken 静默续期 serviceToken', { 账号尾号: next.accountTail })
    return next
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await writeSpeakerConfig({ ...config, lastError: `续期失败：${message.slice(0, 120)}` })
    logger.warn('[xiaomi] 静默续期失败:', message.slice(0, 140))
    return null
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
  if (renewed) return renewed
  if (Number.isFinite(msToExpiry) && msToExpiry <= 0) {
    throw new XiaomiAuthError('小爱的票已过期且静默续期没成功，请在面板上重新扫码', 401)
  }
  // 票还没到期，续期失败只是少了一次刷新，先用着
  return creds
}

/** 拉一次设备列表；遇到 401 就当场续一次票再试一遍 */
export async function syncDevices(): Promise<SpeakerDevice[]> {
  let creds = await ensureFreshCredentials()
  let devices: SpeakerDevice[]
  try {
    devices = await fetchDevices(creds)
  } catch (err) {
    // 只有"票不行"（401 身份）才值得当场续一张再试：上游 5xx / 非 JSON 拿去续票只会白跑一趟，
    // 还会把一次网络抖动写成"续期失败"，管理员看到的错就变成假的。
    if (!(err instanceof XiaomiAuthError) || err.status !== 401) throw err
    const renewed = await renew(await readSpeakerConfig())
    if (!renewed) throw err
    creds = renewed
    devices = await fetchDevices(creds)
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

/**
 * 小爱音箱网关 API 客户端（admin 面板用，G0）
 *
 * 这里能出现的只有**脱敏后的视图**：账号尾号、token 尾四位、到期时间。
 * `serviceToken` / `passToken` 原值没有任何一条路径能从服务端走到浏览器，
 * 面板也就不许尝试渲染它们。
 */

import { apiGet, apiPost } from './client'

export interface SpeakerDeviceView {
  deviceID: string
  name: string
  /** 型号代码（L05B 一类）：G1 靠它决定走哪个播放接口 */
  hardware: string
  model: string
  miotDID: string
  /** `online` 才算在线 */
  presence: string
  managed: boolean
}

export interface SpeakerView {
  enabled: boolean
  loggedIn: boolean
  accountTail: string
  tokenTail: string
  expiresAt: string | null
  /** 票还剩多少毫秒；负数 = 已过期 */
  msToExpiry: number | null
  needsRefresh: boolean
  devices: SpeakerDeviceView[]
  lastSyncAt: string | null
  lastError: string | null
  /** 音箱拉流用的主机名（必须局域网可达）；空 = 没配，此时推歌会被明确拒绝 */
  serverHost: string
  playQuality: '320k' | '128k'
  musicApiDisabledModels: string[]
}

export interface QrStartResult {
  sessionId: string
  /** 一次性口令：只有拿到这张二维码的这次请求知道，轮询必须带上 */
  loginToken: string
  /** 平台自己渲染的二维码 PNG（base64，不带 data: 前缀） */
  qrPngBase64: string
  expiresInMs: number
}

export type QrPollResult =
  | { state: 'waiting' }
  | { state: 'expired'; message: string }
  | { state: 'failed'; message: string }
  | { state: 'signedIn'; view: SpeakerView }

export function getSpeaker(): Promise<SpeakerView> {
  return apiGet<SpeakerView>('admin/speaker')
}

export function startSpeakerQr(): Promise<QrStartResult> {
  return apiPost<QrStartResult>('admin/speaker', { action: 'qrStart' })
}

export function pollSpeakerQr(sessionId: string, loginToken: string): Promise<QrPollResult> {
  return apiPost<QrPollResult>('admin/speaker', { action: 'qrPoll', sessionId, loginToken })
}

export function refreshSpeakerDevices(): Promise<{ devices: SpeakerDeviceView[]; view: SpeakerView }> {
  return apiPost<{ devices: SpeakerDeviceView[]; view: SpeakerView }>('admin/speaker', { action: 'devices' })
}

export function setSpeakerManaged(deviceID: string, managed: boolean): Promise<SpeakerView> {
  return apiPost<SpeakerView>('admin/speaker', { action: 'setManaged', deviceID, managed })
}

export function setSpeakerEnabled(enabled: boolean): Promise<SpeakerView> {
  return apiPost<SpeakerView>('admin/speaker', { action: 'setEnabled', enabled })
}

/** 取消一张还没人扫的码（sessionId 不给也行，服务端只是清掉对应会话） */
export function speakerLogout(sessionId?: string): Promise<SpeakerView> {
  return apiPost<SpeakerView>('admin/speaker', { action: 'logout', ...(sessionId ? { sessionId } : {}) })
}

/** 音箱拉流用的主机名（面板项，落 AppSetting；填错就等于"投过去没声音"，所以要能当场看清自己填了什么） */
export function setSpeakerHost(serverHost: string): Promise<SpeakerView> {
  return apiPost<SpeakerView>('admin/speaker', { action: 'setHost', serverHost })
}

export function setSpeakerQuality(quality: '320k' | '128k'): Promise<SpeakerView> {
  return apiPost<SpeakerView>('admin/speaker', { action: 'setQuality', quality })
}

export function setSpeakerMusicApiDisabled(models: string[]): Promise<SpeakerView> {
  return apiPost<SpeakerView>('admin/speaker', { action: 'setMusicApiDisabled', models })
}

/** 面板上的急救控制：推完没声时先用它把音箱停掉，别让人去拧物理按键 */
export function controlSpeakerFromAdmin(
  op: 'play' | 'pause' | 'stop', deviceID?: string,
): Promise<{ ok: boolean; deviceName: string }> {
  return apiPost<{ ok: boolean; deviceName: string }>('admin/speaker', { action: 'control', op, ...(deviceID ? { deviceID } : {}) })
}

export function setSpeakerVolumeFromAdmin(volume: number, deviceID?: string): Promise<{ ok: boolean; deviceName: string }> {
  return apiPost<{ ok: boolean; deviceName: string }>('admin/speaker', { action: 'volume', volume, ...(deviceID ? { deviceID } : {}) })
}

/** 音箱报回来的播放状态（`status`：1=在播 2=暂停 0=停止 -1=读不到；-1 与 0 是两件事） */
export interface SpeakerStreamStatus {
  status: number
  position: number
  duration: number
  volume: number
  title: string
}

export interface SpeakerStatusRead {
  device: SpeakerDeviceView
  status: SpeakerStreamStatus
}

/** 读一次音箱当前状态（1=在播 2=暂停 0=停止 -1=读不到） */
export function readSpeakerStatusFromAdmin(deviceID?: string): Promise<SpeakerStatusRead> {
  return apiPost<SpeakerStatusRead>('admin/speaker', { action: 'status', ...(deviceID ? { deviceID } : {}) })
}

/** 面板上的「试推」：指定一个 uid 直接投一次，用来验地址通不通（日常入口在播放页） */
export function testPushSpeaker(uid: string, deviceID?: string): Promise<import('./speaker').SpeakerPlayOutcome> {
  return apiPost<import('./speaker').SpeakerPlayOutcome>('admin/speaker', { action: 'play', uid, ...(deviceID ? { deviceID } : {}) })
}

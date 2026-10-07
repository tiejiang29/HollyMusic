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

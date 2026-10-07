/**
 * 投歌到小爱音箱的客户端（登录用户级，G1）。
 *
 * 这个模块**永远拿不到也看不到凭据**：服务端只回音箱名/型号/状态这些公开字段，
 * 小米的协议、令牌签发全在服务端做完。
 */

import { apiGet, apiPost } from './client'

export interface SpeakerPick {
  deviceID: string
  name: string
  hardware: string
  online: boolean
  managed: boolean
}

export interface SpeakerAvailability {
  enabled: boolean
  /** 能投 = 开关开着 + 有在线纳管音箱 + 配了局域网地址，三件齐了按钮才可点 */
  ready: boolean
  serverHostReady: boolean
  playQuality: '320k' | '128k'
  devices: SpeakerPick[]
}

export interface SpeakerPlayOutcome {
  /** 设备端认了且回读到的状态是"在播" */
  playing: boolean
  /** 云端/设备端是否受理了这条推歌指令（与"是否在放"是两件事） */
  pushed: boolean
  deviceName: string
  hardware: string
  status: { status: number; position: number; duration: number; volume: number; title: string } | null
  /** 没在放时的人话原因，直接显示给用户 */
  reason: string | null
}

export function getSpeakerAvailability(): Promise<SpeakerAvailability> {
  return apiGet<SpeakerAvailability>('speaker')
}

export function castToSpeaker(uid: string, deviceID?: string): Promise<SpeakerPlayOutcome> {
  return apiPost<SpeakerPlayOutcome>('speaker', { action: 'play', uid, ...(deviceID ? { deviceID } : {}) })
}

export type SpeakerOp = 'pause' | 'resume' | 'stop'

export function controlSpeaker(op: SpeakerOp, deviceID?: string): Promise<{ ok: boolean; deviceName: string }> {
  return apiPost<{ ok: boolean; deviceName: string }>('speaker', { action: op, ...(deviceID ? { deviceID } : {}) })
}

export function setSpeakerPlaybackVolume(volume: number, deviceID?: string): Promise<{ ok: boolean; deviceName: string }> {
  return apiPost<{ ok: boolean; deviceName: string }>('speaker', { action: 'volume', volume, ...(deviceID ? { deviceID } : {}) })
}

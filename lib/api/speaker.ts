/**
 * 投放到小爱音箱的客户端（登录用户级，G1/G2）。
 *
 * 这个模块**永远拿不到也看不到凭据**：服务端只回音箱名/型号/会话状态这些公开字段，
 * 小米的协议、令牌签发、窗口补推全在服务端做完。
 *
 * 前端只管两件事：把**播放顺序**交出去（`startCast` 的 rest），以及把会话报回来的
 * 位置/状态显示出来（`readCastStatus`）。连播与补窗由服务端看门狗负责 ——
 * 网页一隐藏就一分钟才醒一次，那种亚分钟判据放不进浏览器里。
 */

import { apiGet, apiPost } from './client'

export interface SpeakerPick {
  deviceID: string
  name: string
  hardware: string
  online: boolean
  managed: boolean
}

/** 一格的播放顺序条目：uid + 时长（秒，0=不知道，服务端会用设备报的时长兜） */
export interface CastTrack {
  uid: string
  durSec: number
}

/** 服务端投放会话报回来的状态（进度、歌名游标、音量都在这里） */
export interface CastView {
  deviceID: string
  deviceName: string
  hardware: string
  /** 现在播的是哪首（设备回显的游标换算出来的，不是我们本地假设的） */
  uid: string
  posSec: number
  durSec: number
  playing: boolean
  /** 1=在播 2=暂停 0=停了 -1=读不到 */
  status: number
  /** 0-100，-1=没读到 */
  volume: number
  windowSize: number
  pendingTracks: number
  lastError: string | null
}

export interface SpeakerAvailability {
  enabled: boolean
  /** 能投 = 开关开着 + 有在线纳管音箱 + 配了局域网地址，三件齐了按钮才可点 */
  ready: boolean
  serverHostReady: boolean
  playQuality: '320k' | '128k'
  devices: SpeakerPick[]
  /** 刷新页面后也能认出"还在投着" */
  casting: CastView | null
}

export interface SpeakerPlayOutcome {
  /** 设备端认了且回读到的状态是"在播" */
  playing: boolean
  /** 云端/设备端是否受理了这条推歌指令（与"是否在放"是两件事） */
  pushed: boolean
  deviceName: string
  hardware: string
  status: { status: number; position: number; duration: number; volume: number; title: string; audioId: string } | null
  /** 没在放时的人话原因，直接显示给用户 */
  reason: string | null
}

export function getSpeakerAvailability(): Promise<SpeakerAvailability> {
  return apiGet<SpeakerAvailability>('speaker')
}

export interface StartCastInput {
  current: CastTrack
  /** 之后依次播的顺序，按播放模式算好（随机要先冻结成一份列表） */
  rest: CastTrack[]
  deviceID?: string
  seekSec?: number
  /** 单曲循环：只推当前这一首，让设备自己循环它（rest 传空） */
  loopOne?: boolean
}

/** 进投放：把当前曲 + 后面的顺序整个交出去，服务端自己切窗推给音箱 */
export function startCast(input: StartCastInput): Promise<CastView> {
  return apiPost<CastView>('speaker', {
    action: 'cast', current: input.current, rest: input.rest,
    ...(input.deviceID ? { deviceID: input.deviceID } : {}),
    ...(input.seekSec ? { seekSec: input.seekSec } : {}),
    ...(input.loopOne ? { loopOne: true } : {}),
  })
}

/** 投放中改了队列：只更新顺序，服务端等当前这首放完才生效（不打断正在播的） */
export function updateCastRest(rest: CastTrack[], deviceID?: string): Promise<CastView> {
  return apiPost<CastView>('speaker', { action: 'castRest', rest, ...(deviceID ? { deviceID } : {}) })
}

/** 下一首 / 上一首 */
export function skipCast(delta: 1 | -1, deviceID?: string): Promise<CastView> {
  return apiPost<CastView>('speaker', { action: 'castSkip', delta, ...(deviceID ? { deviceID } : {}) })
}

/** 拖动进度条：服务端带偏移重推这一首 + 后面剩余的首 */
export function seekCast(sec: number, deviceID?: string): Promise<CastView> {
  return apiPost<CastView>('speaker', { action: 'seek', sec, ...(deviceID ? { deviceID } : {}) })
}

/** 读会话状态（只读服务端，不打小米；没有会话时 casting 为 null） */
export function readCastStatus(deviceID?: string): Promise<{ casting: CastView | null }> {
  return apiPost<{ casting: CastView | null }>('speaker', { action: 'castStatus', ...(deviceID ? { deviceID } : {}) })
}

/** 退出投放：停掉音箱并清会话 */
export function stopCast(deviceID?: string): Promise<{ ok: boolean; casting: null }> {
  return apiPost<{ ok: boolean; casting: null }>('speaker', { action: 'castStop', ...(deviceID ? { deviceID } : {}) })
}

export type SpeakerOp = 'pause' | 'resume' | 'stop'

/**
 * 播控之后服务端会把会话状态一并带回来（`casting`）：
 * 暂停/继续要立刻反映到进度与按钮上，不能等下一次轮询。
 */
export function controlSpeaker(
  op: SpeakerOp, deviceID?: string,
): Promise<{ ok: boolean; deviceName: string; casting?: CastView | null }> {
  return apiPost<{ ok: boolean; deviceName: string; casting?: CastView | null }>(
    'speaker', { action: op, ...(deviceID ? { deviceID } : {}) },
  )
}

/** 音箱音量：0-100（与本地那个 0~1 的音量是两回事） */
export function setSpeakerPlaybackVolume(volume: number, deviceID?: string): Promise<{ ok: boolean; deviceName: string; volume: number }> {
  return apiPost<{ ok: boolean; deviceName: string; volume: number }>('speaker', { action: 'volume', volume, ...(deviceID ? { deviceID } : {}) })
}

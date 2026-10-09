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
  /** 对话轮询（G0.5）那三项 + 语音接管（G3）那七项，服务端视图里都有，面板直接读 */
  conversationEnabled: boolean
  conversationPollSec: number
  failedAnswerHints: string[]
  /** 语音接管（G3）那七项 */
  takeoverEnabled: boolean
  fuzzyMatchCutoff: number
  takeoverSources: string[]
  controlRules: Array<{ op: string; words: string[] }>
  volumeStep: number
  takeoverTriggers: string[]
  /** 抢播候选至少要像整曲（秒）；0 = 不筛，试听版也会被端上去 */
  takeoverMinTrackSec: number
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

/** 面板上的一行对话（G0.5 量数） */
export interface SpeakerAskRow {
  deviceID: string
  deviceName: string
  /** 小爱侧时间戳（毫秒） */
  timestampMs: number
  /** 我们看见它的时刻（毫秒）—— 两者之差就是"说出口到看得见"的延迟 */
  receivedAt: number
  query: string
  answer: string
  looksFailed: boolean
  /** 启动那一轮读到的历史，不是刚说的话 */
  fromBaseline: boolean
  /**
   * 这一句的处置结果，判完回填到**同一行**（省得在两张表之间对齐同一句话）。
   * 没进过接管链的行（历史、接管关着）这里是空的。
   */
  takeover?: { at: number; verdict: TakeoverVerdict; reason: string; acted: string }
}

/** 判据的结论（与服务层 `Verdict` 同一套；回答不参与判据，所以没有"答上了/没证据"这两格） */
export type TakeoverVerdict = 'control' | 'takeover' | 'no-hit' | 'stale' | 'rejected' | 'not-music'

export interface ConversationState {
  running: boolean
  pollSec: number
  enabled: boolean
  lastPollAt: number | null
  lastError: string | null
  /**
   * 每台设备各自的轮询账目：`polls` 在涨而 `seen` 是 0，说明"拉到了但平台真没记录"；
   * `polls` 不涨才是"压根没在拉"。G0.5 要的就是这个分辨。
   */
  devices: Array<{ deviceID: string; name: string; primed: boolean; lastTs: number; polls: number; seen: number }>
  /**
   * 平台最新一条的时间戳减本机此刻（毫秒），**只在超前 >5 分钟时非空**。
   * 纯诊断、不参与任何判据：它的用处是让"读早了"和"本机时钟偏了"这两种解释在面板上分得开。
   */
  clockSkewMs: number | null
}

export interface ConversationFeed {
  rows: SpeakerAskRow[]
  state: ConversationState
}

/** 对话轮询的面板项（开关 / 间隔秒 / 失败话术片段） */
export function setSpeakerConversation(input: {
  enabled?: boolean; pollSec?: number; failedAnswerHints?: string[];
}): Promise<{ view: SpeakerView; state: ConversationState }> {
  return apiPost<{ view: SpeakerView; state: ConversationState }>('admin/speaker', { action: 'convSet', ...input })
}

/** 拉对话回显（只读；顺带保证轮询在跑） */
export function readConversationFeed(): Promise<ConversationFeed> {
  return apiPost<ConversationFeed>('admin/speaker', { action: 'convList' })
}
/** 面板上的一行接管账目 */
export interface TakeoverLogRow {
  at: number
  deviceID: string
  deviceName: string
  query: string
  answer: string
  verdict: TakeoverVerdict
  reason: string
  acted: string
  /** 面板"模拟口令"喂的那条，不是真话 */
  synthetic: boolean
}

export function setSpeakerTakeover(input: {
  enabled?: boolean; cutoff?: number;
  sources?: string[]; controlRulesText?: string; volumeStep?: number; triggers?: string[];
  minTrackSec?: number;
}): Promise<{ view: SpeakerView }> {
  return apiPost<{ view: SpeakerView }>('admin/speaker', { action: 'askSet', ...input })
}

export function readTakeoverLog(): Promise<{ rows: TakeoverLogRow[] }> {
  return apiPost<{ rows: TakeoverLogRow[] }>('admin/speaker', { action: 'askLog' })
}

/** 喂一条合成口令走同一条判据链路（真机拉不到对话记录时唯一的验证手段） */
export function simulateAsk(query: string, answer: string): Promise<TakeoverLogRow> {
  return apiPost<TakeoverLogRow>('admin/speaker', { action: 'askSimulate', query, answer })
}

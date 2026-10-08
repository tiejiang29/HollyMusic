/**
 * MiNA（小爱音箱接口）客户端 —— G0 只用得到设备列表，G1 的播放控制往这里加。
 *
 * 出处：`songloft-org/songloft-plugin-miot`（Apache-2.0）的 `src/mina/*`；
 * 三个动作的形状已实测：`GET /admin/v2/device_list?master=1`、`POST /remote/ubus`、
 * 对话记录走另一个域名的 `device_profile/v2/conversation`。
 *
 * 鉴权是纯 cookie：`userId` + `serviceToken` + `channel=MI_APP_STORE`，没有签名。
 * 401 一定要抛成能认的错误类型：调用方要靠它区分"票过期了（能静默续）"和"根本没登录（要扫码）"，
 * 不能拿一句 500 把两件事糊在一起。
 */
import { logger } from '@/lib/logger'
import { assertPublicHttpUrl } from '@/lib/server/url-guard'
import type { XiaomiCredentials } from '@/lib/services/xiaomi/qr-login'

const MINA_BASE = 'https://api2.mina.mi.com'

/** 票过期 / 需要重新扫码 —— 路由层据此回 401，面板据此把"重新登录"摆到眼前 */
export class XiaomiAuthError extends Error {
  readonly status: number
  constructor(message: string, status = 401) {
    super(message)
    this.name = 'XiaomiAuthError'
    this.status = status
  }
}

export interface SpeakerDevice {
  deviceID: string
  name: string
  /** 型号代码（如 `L05B`）。G1 靠它决定走 `player_play_music` 还是 `player_play_url`，必须存 */
  hardware: string
  model: string
  miotDID: string
  /** `online` / 其它 = 离线 */
  presence: string
  /** 是否纳入本网关管理（一台账号下可能有多台音箱，管理员要能挑） */
  managed: boolean
}

const text = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')

/**
 * 小米说"这张票不行"有三种写法，都得认（少认一种，续期就不会被触发，管理员只看到一句莫名的拒绝）：
 * `code=401/319`、`code=70016`（"登录验证失败"），以及少数只写在 message 里的 `auth` 字样。
 * 出处：`hanxi/xiaomusic` 的 `auth.py` 拿 `70016`/`登录验证失败` 当重新登录的判据，
 * `Yonsm/MiService` 的 `mi_request` 拿 `message` 含 `auth` 当判据。
 */
const AUTH_CODES = new Set(['401', '319', '70016'])

export function isAuthFailure(code: string, message: string): boolean {
  return AUTH_CODES.has(code) || message.includes('登录验证失败') || /auth/i.test(message)
}

export async function fetchDevices(creds: XiaomiCredentials): Promise<SpeakerDevice[]> {
  const url = `${MINA_BASE}/admin/v2/device_list?master=1`
  await assertPublicHttpUrl(url)
  const res = await fetch(url, {
    headers: {
      // UA 与登录时那台"手机"保持一致，免得平台把请求当成新设备
      'User-Agent': `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${creds.deviceId} APP/xiaomi.smarthome APPV/62830`,
      Cookie: `userId=${creds.userId}; serviceToken=${creds.serviceToken}; channel=MI_APP_STORE`,
      Accept: 'application/json',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  })
  if (res.status === 401 || res.status === 403) throw new XiaomiAuthError('小爱音箱的票已失效，需要重新登录')
  const body = await res.text()
  if (!res.ok) {
    // 只打状态与长度：小米的错误体里可能回带请求上下文，不整段落日志
    logger.warn('[xiaomi] device_list 非 2xx', { 状态: res.status, 字节: body.length })
    throw new XiaomiAuthError(`读取设备列表失败（HTTP ${res.status}）`, 502)
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(body) as Record<string, unknown>
  } catch {
    throw new XiaomiAuthError('设备列表返回的不是 JSON（可能被风控页挡了）', 502)
  }
  const code = text(parsed.code)
  const message = text(parsed.message) || text(parsed.description) || text(parsed.result)
  if (code && code !== '0') {
    // 200 里包着错误码是这套接口的常态：判"票失效"要码与话术一起看，只看 HTTP 状态会漏掉 70016
    if (isAuthFailure(code, message)) {
      throw new XiaomiAuthError(`小爱音箱的票已失效（code=${code}），需要重新登录`)
    }
    throw new XiaomiAuthError(`读取设备列表被拒绝（code=${code} ${message}）`, 502)
  }
  const list = Array.isArray(parsed.data) ? parsed.data as Record<string, unknown>[] : []
  return list.map(d => ({
    deviceID: text(d.deviceID),
    name: text(d.name) || text(d.deviceName) || text(d.alias) || text(d.ssid) || '(未命名设备)',
    hardware: text(d.hardware),
    model: text(d.model) || text(d.hardware),
    miotDID: text(d.miotDID),
    presence: text(d.presence) || 'unknown',
    managed: true,
  })).filter(d => d.deviceID)
}

// ============================================================================
// 播控（G1）
// ============================================================================

const UBUS_PATH = '/remote/ubus'
const UBUS_TIMEOUT_MS = 8000
/** `player_play_music` 那条报文里的固定占位 id（照参考实现的值，别自己编） */
const DEFAULT_MUSIC_AUDIO_ID = '1732418460076477549'
const MUSIC_CP_ID = '355454500'

/**
 * 这些型号要用 `player_play_music`（推 `player_play_url` 会"亮灯不出声"）。
 * 出处：`songloft-org/songloft-plugin-miot`（Apache-2.0）`src/mina/constants.ts` 的
 * `DEFAULT_MUSIC_API_MODELS`；我们这台实测是 `L05B`，就在名单里。
 */
export const MUSIC_API_MODELS: readonly string[] = [
  'X08C', 'X08E', 'X8F', 'X4B', 'LX05', 'OH11', 'OH2', 'OH2P', 'X6A', 'LX04',
  'L05B', 'L05C', 'LX06', 'L06A', 'X08A', 'X10A', 'L15A', 'L16A', 'L17A',
]

export function usePlayMusicApi(hardware: string, disabledModels: string[] = []): boolean {
  if (disabledModels.includes(hardware)) return false
  return MUSIC_API_MODELS.includes(hardware)
}

/** `player_get_play_status` 的 status：1 在播、2 暂停、0 停止，-1 是没读出来 */
export const PLAY_STATUS_PLAYING = 1

export interface PlayStatus {
  status: number
  /** 当前播放位置（毫秒） */
  position: number
  /** 设备报上来的时长（毫秒）；0 = 这台/这条路径不报时长 */
  duration: number
  volume: number
  /** 设备自己认为在放什么（不少固件这条是它自己的曲库项，不是我们推的 URL） */
  title: string
  /** 我们推给它时填的 `audio_id`，设备原样回显；'' = 这台没报。投放会话拿它当"播到第几项"的游标 */
  audioId: string
}

interface UbusResponse {
  code: number
  message?: string
  data?: unknown
}

/**
 * 同一台设备的 ubus 调用**必须串行**。
 * 云端对并发指令不保证执行顺序，两条一起发过去会出现"后发的被先发的盖掉"；
 * 后面 G2 的对话轮询也会挤同一条队，所以队列在这层收口，不由调用方自觉。
 */
const queues = new Map<string, Promise<unknown>>()

function enqueueUbus<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(deviceId) ?? Promise.resolve()
  const next = prev.then(task, task)
  // 队列里只留这一条尾巴：失败不能把后面的都带崩
  queues.set(deviceId, next.catch(() => undefined))
  return next
}

const cookieOf = (creds: XiaomiCredentials): string =>
  `userId=${creds.userId}; serviceToken=${creds.serviceToken}; channel=MI_APP_STORE`

/**
 * 日志脱敏：推给音箱的 URL 里带 `st` 分享令牌，等于一枚能放歌的凭据，
 * 所以报文进日志前只留长度不留内容（和 serviceToken/passToken 同一等对待）。
 */
function summarizeMessage(message: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(message)) {
    if (key === 'url' || key === 'music' || key === 'text') {
      parts.push(`${key}(长${String(value ?? '').length})`)
    } else {
      parts.push(`${key}=${String(value ?? '')}`)
    }
  }
  return parts.join(' ')
}

async function ubus(
  creds: XiaomiCredentials,
  deviceId: string,
  method: string,
  path: string,
  message: Record<string, unknown>,
): Promise<UbusResponse> {
  const url = `${MINA_BASE}${UBUS_PATH}`
  await assertPublicHttpUrl(url)
  const form: Record<string, string> = {
    deviceId,
    method,
    path,
    message: JSON.stringify(message),
    requestId: `${deviceId.slice(-6)}-${Date.now()}`,
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${creds.deviceId} APP/xiaomi.smarthome APPV/62830`,
      Cookie: cookieOf(creds),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(form).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(UBUS_TIMEOUT_MS),
  })
  if (res.status === 401 || res.status === 403) {
    throw new XiaomiAuthError(`小爱的票已失效（${method} 回 HTTP ${res.status}），需要重新登录`)
  }
  const body = await res.text()
  if (!res.ok) {
    logger.warn('[xiaomi] ubus 非 2xx', { 方法: method, 状态: res.status, 字节: body.length })
    throw new XiaomiAuthError(`播控请求失败（${method}，HTTP ${res.status}）`, 502)
  }
  let parsed: UbusResponse
  try {
    parsed = JSON.parse(body) as UbusResponse
  } catch {
    throw new XiaomiAuthError(`播控返回的不是 JSON（${method}，可能被风控页挡了）`, 502)
  }
  const code = Number(parsed.code)
  if (isAuthFailure(String(parsed.code ?? ''), String(parsed.message ?? ''))) {
    throw new XiaomiAuthError(`小爱的票已失效（${method}，code=${parsed.code}），需要重新登录`)
  }
  if (code !== 0) {
    // 云端这一层非 0 就是"我没受理"，和"设备端没执行"是两件事（后者看 data.code）
    logger.warn('[xiaomi] ubus 云端拒绝', {
      方法: method, code: parsed.code, 消息: String(parsed.message ?? '').slice(0, 80), 报文: summarizeMessage(message),
    })
    throw new XiaomiAuthError(`播控被云端拒绝（${method}，code=${parsed.code} ${String(parsed.message ?? '')}）`, 502)
  }
  return parsed
}

/**
 * 设备级返回码：`data` 里可能还有一层 `code`，那才是音箱本体的回执。
 * 只看云端 code==0 会把"受理了但设备没执行"当成成功（就是"亮灯不出声"那种）。
 */
function deviceOk(result: UbusResponse, action: string): boolean {
  const data = result.data
  if (data && typeof data === 'object' && 'code' in data) {
    const code = Number((data as Record<string, unknown>).code)
    if (!Number.isNaN(code) && code !== 0) {
      logger.warn('[xiaomi] 设备端返回非 0', { 动作: action, 设备码: code })
      return false
    }
  }
  return true
}

/** 一项要推给音箱的播放内容：一条我们自己的流地址 + 我们给它编的 audio_id */
export interface PlayItem {
  url: string
  audioId: string
}

/**
 * `player_play_music` 的报文。
 *
 * **`audio_items` 是数组，且设备会按顺序自己播完**（2026-10-08 真机实测：推 10 项时
 * 24100→24101→24102→24103 依次出声，边界处新项已经跑到 pos=3s），所以连续播放这件事
 * 可以整包交给音箱，不用我们掐着秒推下一首。
 * 代价是它放完一批会**从头循环**（`player_set_loop` 只有单曲/列表/随机三档，没有"不循环"），
 * 尾巴得由调用方收。`audio_id` 是我们填的、设备**原样回显** ⇒ 它同时是"现在播到第几项"的游标。
 */
function playMusicMessage(items: PlayItem[], keepLight: boolean): Record<string, unknown> {
  const music = {
    payload: {
      audio_type: keepLight ? 'MUSIC' : '',
      audio_items: items.map((it, i) => ({
        item_id: { audio_id: it.audioId, cp: { album_id: '-1', episode_index: i, id: MUSIC_CP_ID, name: 'xiaowei' } },
        stream: { url: it.url },
      })),
      list_params: { listId: '-1', loadmore_offset: 0, origin: 'xiaowei', type: 'MUSIC' },
    },
    play_behavior: 'REPLACE_ALL',
  }
  return { startaudioid: items[0]?.audioId ?? DEFAULT_MUSIC_AUDIO_ID, music: JSON.stringify(music) }
}

/**
 * 一次推一组（一首或多首）给音箱。
 *
 * 走不通 `player_play_music` 时退回 `player_play_url` —— 那条口只收单条地址，
 * 所以退化的同时**只有第一项会播**，剩下的靠调用方的看门狗逐首补推。
 */
export async function playItems(
  creds: XiaomiCredentials,
  deviceId: string,
  items: PlayItem[],
  hardware = '',
  opts: { keepLight?: boolean; musicApiDisabled?: string[] } = {},
): Promise<{ accepted: boolean; batched: boolean }> {
  const keepLight = opts.keepLight ?? false
  if (items.length === 0) return { accepted: false, batched: false }
  return enqueueUbus(deviceId, async () => {
    if (usePlayMusicApi(hardware, opts.musicApiDisabled ?? [])) {
      try {
        const got = await ubus(creds, deviceId, 'player_play_music', 'mediaplayer', playMusicMessage(items, keepLight))
        if (deviceOk(got, 'player_play_music')) return { accepted: true, batched: true }
        logger.warn('[xiaomi] player_play_music 设备端没认，退回 player_play_url', { 型号: hardware, 项数: items.length })
      } catch (err) {
        logger.warn('[xiaomi] player_play_music 失败，退回 player_play_url:', errMessage(err))
      }
    }
    const got = await ubus(creds, deviceId, 'player_play_url', 'mediaplayer', {
      url: items[0].url, type: keepLight ? 1 : 2, media: 'app_ios',
    })
    return { accepted: deviceOk(got, 'player_play_url'), batched: false }
  })
}

/** 推一条 URL 给音箱；`hardware` 决定走 play_music 还是 play_url（分流判据就是它） */
export async function playUrl(
  creds: XiaomiCredentials,
  deviceId: string,
  url: string,
  hardware = '',
  opts: { keepLight?: boolean; musicApiDisabled?: string[] } = {},
): Promise<boolean> {
  const r = await playItems(creds, deviceId, [{ url, audioId: DEFAULT_MUSIC_AUDIO_ID }], hardware, opts)
  return r.accepted
}

/** 播放控制：play / pause / stop 都走 `player_play_operation` */
export async function playerOperation(
  creds: XiaomiCredentials,
  deviceId: string,
  action: 'play' | 'pause' | 'stop',
): Promise<boolean> {
  return enqueueUbus(deviceId, async () => {
    // 有些固件单发 stop 不会真停，参考实现的做法是先 pause 再 stop，我们照做
    if (action === 'stop') {
      await ubus(creds, deviceId, 'player_play_operation', 'mediaplayer', { action: 'pause', media: 'app_ios' })
        .catch(() => null)
    }
    const got = await ubus(creds, deviceId, 'player_play_operation', 'mediaplayer', { action, media: 'app_ios' })
    return deviceOk(got, `player_play_operation:${action}`)
  })
}

export async function setVolume(creds: XiaomiCredentials, deviceId: string, volume: number): Promise<boolean> {
  const v = Math.max(0, Math.min(100, Math.floor(volume)))
  return enqueueUbus(deviceId, async () => {
    const got = await ubus(creds, deviceId, 'player_set_volume', 'mediaplayer', { volume: v })
    return deviceOk(got, 'player_set_volume')
  })
}

/**
 * 回读播放状态。`info` 是一段 JSON 字符串（小米就这么给的），解析不出来一律当"未知"（-1），
 * 不许拿 0 当"停了" —— 0 是有含义的，读不到和停了是两件事。
 */
export async function getPlayStatus(creds: XiaomiCredentials, deviceId: string): Promise<PlayStatus> {
  return enqueueUbus(deviceId, async () => {
    const got = await ubus(creds, deviceId, 'player_get_play_status', 'mediaplayer', {})
    const data = got.data as { info?: unknown } | undefined
    let info: Record<string, unknown> = {}
    try {
      info = typeof data?.info === 'string' ? JSON.parse(data.info) as Record<string, unknown>
        : (data?.info as Record<string, unknown>) ?? {}
    } catch {
      info = {}
    }
    const detail = (info.play_song_detail ?? {}) as Record<string, unknown>
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : -1)
    // 位置/时长在 `play_song_detail` 里（真机实测：顶层只有 status/volume/loop_type/media_type）。
    // 两处都取、取先拿到的那个：不同固件放过顶层，硬只读一处就会一直显示 0s。
    const pick = (key: 'position' | 'duration'): number => {
      const top = num(info[key])
      const nested = num(detail[key])
      return Math.max(top, nested)
    }
    return {
      status: num(info.status) < 0 ? -1 : num(info.status),
      // 不兜成 0：0 是"刚开始"，-1 才是"这台不报" —— 兜起来就让面板分不清两件事了
      position: pick('position'),
      // 0/缺失都会如实变成 -1：这台不报时长时，上层不能拿它做时长判据
      duration: pick('duration'),
      volume: num(info.volume),
      title: typeof info.title === 'string' ? info.title : '',
      // 设备**原样回显**我们填的 audio_id（真机实测）⇒ 投放会话靠它认"播到窗里第几项"
      audioId: detail.audio_id === undefined || detail.audio_id === null
        ? ''
        : String(detail.audio_id),
    }
  })
}

// ============================================================================
// 对话记录（G0.5 量数 / G3 语音接管的输入）
// ============================================================================

const CONV_URL = 'https://userprofile.mina.mi.com/device_profile/v2/conversation'

/** 一条对话：小爱侧记录的时间戳（毫秒）、用户说的那句、小爱回答的原文 */
export interface AskRecord {
  timestampMs: number
  query: string
  /** 小爱的 TTS 回答原文；这条没回答就给 '' */
  answer: string
}

/**
 * 拉一台设备的对话记录（按时间升序）。
 *
 * 出处：`songloft-org/songloft-plugin-miot`（Apache-2.0）`src/mina/client.ts` 的
 * `getConversations` —— URL、`source=dialogu`、`limit`、以及**`data` 是一段 JSON 字符串要二次 parse**
 * 这三件事都是从它那里确认的（漏了二次 parse 就会永远读到空列表，而且是静默的空）。
 *
 * 失败一律抛错、不返回空数组：调用方要靠"这次到底没取到"与"确实没人说话"的区分决定
 * 动不动基线（参考实现把这两者分得很严：混同了要么把历史当新对话重放，要么把网络抖当成无声）。
 */
export async function fetchConversations(
  creds: XiaomiCredentials, hardware: string, limit = 5,
): Promise<AskRecord[]> {
  if (!hardware) throw new XiaomiAuthError('这台设备没有 hardware 型号，拉不了对话记录', 400)
  // 重试要复用同一个 timestamp（miot 就是这么做的）：每次重算会让三次的结果对不上
  const url = `${CONV_URL}?source=dialogu&hardware=${encodeURIComponent(hardware)}&timestamp=${Date.now()}&limit=${limit}`
  await assertPublicHttpUrl(url)
  const res = await fetch(url, {
    headers: {
      'User-Agent': `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${creds.deviceId} APP/xiaomi.smarthome APPV/62830`,
      Cookie: `userId=${creds.userId}; serviceToken=${creds.serviceToken}; channel=MI_APP_STORE; deviceId=${creds.deviceId}`,
      Accept: 'application/json',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  })
  if (res.status === 401 || res.status === 403) throw new XiaomiAuthError('小爱的票已失效（对话记录，HTTP ' + res.status + '），需要重新登录')
  const body = await res.text()
  if (!res.ok) {
    logger.warn('[xiaomi] 对话记录非 2xx', { 状态: res.status, 字节: body.length })
    throw new XiaomiAuthError(`读取对话记录失败（HTTP ${res.status}）`, 502)
  }
  let outer: Record<string, unknown>
  try {
    outer = JSON.parse(body) as Record<string, unknown>
  } catch {
    throw new XiaomiAuthError('对话记录返回的不是 JSON（可能被风控页挡了）', 502)
  }
  const code = text(outer.code)
  const message = text(outer.message)
  if (code && code !== '0') {
    if (isAuthFailure(code, message)) throw new XiaomiAuthError(`小爱的票已失效（对话记录，code=${code}），需要重新登录`)
    throw new XiaomiAuthError(`读取对话记录被拒绝（code=${code} ${message}）`, 502)
  }
  // 外层 data 是**字符串**，得再 parse 一次；直接当对象用会静默拿到空列表
  let data: Record<string, unknown> = {}
  if (typeof outer.data === 'string') {
    try { data = JSON.parse(outer.data) as Record<string, unknown> } catch { data = {} }
  } else if (outer.data && typeof outer.data === 'object') {
    data = outer.data as Record<string, unknown>
  }
  const records = Array.isArray(data.records) ? data.records as Record<string, unknown>[] : []
  return records.map(r => {
    const answers = Array.isArray(r.answers) ? r.answers as Record<string, unknown>[] : []
    const tts = answers.find(a => text(a.type) === 'TTS')
    const answer = tts && tts.tts && typeof tts.tts === 'object' ? text((tts.tts as Record<string, unknown>).text) : ''
    return {
      timestampMs: Number(r.time) || 0,
      query: text(r.query),
      answer,
    }
  }).filter(r => r.timestampMs > 0).sort((a, b) => a.timestampMs - b.timestampMs)
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message.slice(0, 140) : String(err))

/** 只给测试用：清掉进程内的串行队列（正常不该在业务里调） */
export function _resetUbusQueuesForTest(): void {
  queues.clear()
}

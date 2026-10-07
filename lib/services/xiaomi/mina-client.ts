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

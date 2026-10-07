/**
 * 小米扫码登录（小爱音箱网关 G0）。
 *
 * 出处：协议形状照 `songloft-org/songloft-plugin-miot`（Apache-2.0）的 `src/qrcode/qrcode.ts`
 * 与 `src/mina/auth.ts`，并已在 2026-10-07 用真账号逐步跑通（扫码 → passToken → 换 micoapi
 * serviceToken → `mina/admin/v2/device_list` 真的列出了设备）。
 *
 * **两步是必需的，不是可选优化**：二维码登录用的 `sid` 是 `mijia`（米家），它发下来的
 * passToken 只够再去换票；小爱音箱走的 MiNA 要的是 `sid=micoapi` 的 serviceToken。
 * 少第二步就是"拿到了票但什么也干不了"。
 *
 * 三条实现上的坑，都在这条链上踩过才写进来：
 * 1. 响应体带 `&&&START&&&` 前缀，直接 `JSON.parse` 会炸；
 * 2. `nonce` 是 18~19 位大整数，**必须从原始字符串里抠**——`JSON.parse` 会把它四舍五入成
 *    `…000`，签名就算错（表现是"换票莫名 401"）；
 * 3. 换票要跟着重定向链走并**收集每一跳的 Set-Cookie**（serviceToken 就在其中一跳的头里），
 *    所以这里不能用 `safePublicFetch`（它为跟跳会 cancel 掉中间响应体、也不回传中间跳的头），
 *    改成每一跳自己调 `assertPublicHttpUrl` 再过 `fetch` —— SSRF 校验一道都不省。
 */
import crypto from 'node:crypto'
import { logger } from '@/lib/logger'
import { assertPublicHttpUrl } from '@/lib/server/url-guard'

const ACCOUNT_BASE = 'https://account.xiaomi.com'
const QR_SID = 'mijia'
/** 小爱音箱（MiNA）要的票是这个 sid */
export const TARGET_SID = 'micoapi'

/** serviceToken 的实际有效期约 12 小时，这里取个保守值给续期判定用 */
export const SERVICE_TOKEN_TTL_MS = 12 * 60 * 60 * 1000
/** 二维码会话的寿命：超时就得重新出一张（平台的 ticket 也会失效，别留着） */
export const QR_SESSION_TTL_MS = 5 * 60 * 1000
/** 单次 lp 请求给的时间：平台是长轮询，正常情况下它 holds 到 ~25-30s，超时就是"还没人扫" */
export const LP_WAIT_MS = 8000

export class XiaomiLoginError extends Error {
  readonly status: number
  constructor(message: string, status = 409) {
    super(message)
    this.name = 'XiaomiLoginError'
    this.status = status
  }
}

/** 凭据全集：serviceToken 用来打接口，passToken 用来静默续期（丢了它就得重新扫码） */
export interface XiaomiCredentials {
  serviceToken: string
  passToken: string
  userId: string
  cUserId: string
  deviceId: string
  /** 到期时间（ISO）。过期前 3 小时主动刷一次 */
  expiresAt: string
  /** 小米账号（数字 id 的尾号），只用于面板回显"是哪一枚" */
  accountTail: string
}

interface QrSession {
  deviceId: string
  userAgent: string
  jar: Map<string, string>
  pollUrl: string
  createdAt: number
  /**
   * 一次性口令：只有拿到二维码的那次调用知道它。
   * 会话 id 是随机数但不是秘密，光凭 id 就能 poll 的话，等于任何拿到 id 的人都能替别人
   * 把这半程登录走完（并看到账号尾号）—— 所以两者都要对得上。
   */
  loginToken: string
}

const sessions = new Map<string, QrSession>()

/** 剥掉小米 JSON 响应的固定前缀 */
export function stripJsonPrefix(body: string): string {
  return body.replace('&&&START&&&', '').trim()
}

/** 从**原始字符串**里抠整数字段，绕开 JSON.parse 的大整数精度丢失 */
export function pickBigIntField(text: string, key: string): string {
  const m = new RegExp(`"${key}"\\s*:\\s*"?(-?\\d+)"?`).exec(text)
  return m ? m[1] : ''
}

/** `clientSign = base64(sha1("nonce={nonce}&{ssecurity}"))` —— 输入串的格式不能改一个字 */
export function computeClientSign(nonce: string, ssecurity: string): string {
  return crypto.createHash('sha1').update(`nonce=${nonce}&${ssecurity}`).digest('base64')
}

const field = (o: Record<string, unknown>, key: string): string => {
  const v = o[key]
  return typeof v === 'string' || typeof v === 'number' ? String(v) : ''
}

function newDeviceId(): string {
  return crypto.randomBytes(8).toString('hex').toUpperCase()
}

/** 每次会话一套独立 cookie，绝不跨会话共享（换错账号是最难查的那类脏状态） */
function cookieHeaderOf(jar: Map<string, string>): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

function harvest(res: Response, jar: Map<string, string>): void {
  for (const raw of res.headers.getSetCookie?.() || []) {
    const pair = raw.split(';')[0]
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
}

/**
 * 一跳一手：先过 SSRF 校验，再手动跟跳，好让每一跳的 Set-Cookie 都被收进 jar。
 * `HopResult.redirectTo` 由调用方决定是否继续跟。
 */
async function hop(
  url: string,
  jar: Map<string, string>,
  userAgent: string,
  init: { method?: string; body?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ res: Response; redirectTo: string | null }> {
  await assertPublicHttpUrl(url)
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    body: init.body,
    headers: {
      'User-Agent': userAgent,
      Accept: 'application/json, text/plain, */*',
      Cookie: cookieHeaderOf(jar),
      ...init.headers,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(init.timeoutMs ?? 20000),
  })
  harvest(res, jar)
  const status = res.status
  const location = status >= 300 && status < 400 ? res.headers.get('location') : null
  return { res, redirectTo: location ? new URL(location, url).toString() : null }
}

/** 跟到底（有上限），返回最后一跳的响应；途中所有 cookie 已落 jar */
async function followTo(
  url: string,
  jar: Map<string, string>,
  userAgent: string,
  // 上限取实测那次用的同一个数（真账号跑通时到第 4 跳才停），比它长就是平台在打转
  maxHops = 10,
): Promise<Response> {
  let current = url
  for (let i = 0; i <= maxHops; i++) {
    const { res, redirectTo } = await hop(current, jar, userAgent)
    if (!redirectTo) return res
    // 跟跳时不重放 body（303/302 语义上转 GET），但要把上一跳读空以免挂着
    await res.body?.cancel().catch(() => {})
    current = redirectTo
  }
  throw new XiaomiLoginError('小米登录的重定向链过长，已中止')
}

async function getJson(url: string, jar: Map<string, string>, userAgent: string, timeoutMs?: number) {
  const { res } = await hop(url, jar, userAgent, { timeoutMs })
  const text = stripJsonPrefix(await res.text())
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new XiaomiLoginError(`小米返回的不是可解析的 JSON（HTTP ${res.status}）`)
  }
  return { res, text, parsed }
}

/**
 * 第二步：用 passToken 换 `micoapi` 的 serviceToken。
 * 扫码成功之后、以及后面每次静默续期，走的都是这一个函数（续期不需要重新扫码）。
 */
export async function exchangeServiceToken(
  creds: { passToken: string; userId: string; cUserId?: string; deviceId: string },
): Promise<{ serviceToken: string; ssecurity: string }> {
  const jar = new Map<string, string>([
    ['sdkVersion', '3.8.6'],
    ['deviceId', creds.deviceId],
    ['passToken', creds.passToken],
    ['userId', creds.userId],
  ])
  if (creds.cUserId) jar.set('cUserId', creds.cUserId)
  const userAgent = `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${creds.deviceId} APP/xiaomi.smarthome APPV/62830`

  const { text, parsed } = await getJson(`${ACCOUNT_BASE}/pass/serviceLogin?sid=${TARGET_SID}&_json=true`, jar, userAgent)
  const location = field(parsed, 'location')
  const ssecurity = field(parsed, 'ssecurity')
  // 顺序不能反：先拿原始串里的 18 位 nonce，抠不到才退到 JSON 解析出来的值
  const nonce = pickBigIntField(text, 'nonce') || field(parsed, 'nonce')
  const code = field(parsed, 'code')
  if (!location || !nonce) {
    throw new XiaomiLoginError(`换 ${TARGET_SID} 的票失败${code ? `（code=${code}）` : ''}，可能需要重新扫码`)
  }
  const signed = `${location}${location.includes('?') ? '&' : '?'}_userIdNeedEncrypt=true&clientSign=${encodeURIComponent(computeClientSign(nonce, ssecurity))}`
  await followTo(signed, jar, userAgent)
  const serviceToken = jar.get('serviceToken') ?? ''
  if (!serviceToken) throw new XiaomiLoginError('跟完重定向也没拿到 micoapi 的 serviceToken')
  return { serviceToken, ssecurity }
}

/** 第一步：出一张平台自己的二维码图片（base64 PNG），并登记一个等待扫码的会话 */
export interface QrStartResult {
  sessionId: string
  loginToken: string
  qrPngBase64: string
  expiresInMs: number
}

export async function startQrLogin(): Promise<QrStartResult> {
  const deviceId = newDeviceId()
  const userAgent = `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${deviceId} APP/xiaomi.smarthome APPV/62830`
  const jar = new Map<string, string>([['sdkVersion', '3.8.6'], ['deviceId', deviceId]])

  const first = await getJson(`${ACCOUNT_BASE}/pass/serviceLogin?sid=${QR_SID}&_json=true`, jar, userAgent)
  const sign = field(first.parsed, '_sign')
  const qs = field(first.parsed, 'qs')
  const callback = field(first.parsed, 'callback')
  if (!sign || !qs || !callback) throw new XiaomiLoginError('小米没给全登录签名参数（_sign/qs/callback）')

  const params = new URLSearchParams({ _qrsize: '240', qs, sid: QR_SID, _sign: sign, callback, _json: 'true', _dc: String(Date.now()) })
  const second = await getJson(`${ACCOUNT_BASE}/longPolling/loginUrl?${params.toString()}`, jar, userAgent)
  const loginUrl = field(second.parsed, 'loginUrl')
  const pollUrl = field(second.parsed, 'lp')
  // `qr` 是平台**渲染好的二维码图片地址**（带 _qrsize/_hasLogo），不是二维码内容。
  // 自己拿 loginUrl 编一张是错的：App 认不出来，只会回一句"二维码已过期"（实测踩过两次）。
  const qrImageUrl = field(second.parsed, 'qr')
  if (!pollUrl) throw new XiaomiLoginError('小米没返回轮询地址（lp）')

  const { res } = await hop(qrImageUrl || loginUrl, jar, userAgent)
  const png = Buffer.from(await res.arrayBuffer())
  if (res.status !== 200 || png.length < 200) {
    throw new XiaomiLoginError(`取二维码图片失败（HTTP ${res.status}，${png.length} 字节）`)
  }

  const sessionId = crypto.randomBytes(12).toString('hex')
  const loginToken = crypto.randomBytes(16).toString('hex')
  sessions.set(sessionId, { deviceId, userAgent, jar, pollUrl, createdAt: Date.now(), loginToken })
  pruneSessions()
  logger.info('[xiaomi] 已生成登录二维码', { 会话: sessionId.slice(0, 6), 图片来源: qrImageUrl ? '平台' : '登录地址' })
  return { sessionId, loginToken, qrPngBase64: png.toString('base64'), expiresInMs: QR_SESSION_TTL_MS }
}

export type QrPollResult =
  | { state: 'waiting' }
  | { state: 'expired'; message: string }
  | { state: 'signedIn'; credentials: XiaomiCredentials }
  | { state: 'failed'; message: string }

/**
 * 第二步的一半：问一次"扫了没"。
 *
 * 平台的 lp 是长轮询，没人扫时它就一直不回字节 —— 那**不是错误**，返回 `waiting` 让前端过几秒再来。
 * 一旦确认，就地完成换 micoapi 票并返回凭据；会话随即销毁（一张码只许换一次票）。
 */
export async function pollQrLogin(sessionId: string, loginToken: string): Promise<QrPollResult> {
  const session = sessions.get(sessionId)
  // id 对不上或口令对不上都当成作废：不回"口令错了"这种能用来试探的差异
  if (!session || session.loginToken !== loginToken) {
    return { state: 'expired', message: '这次扫码已经作废，请重新获取二维码' }
  }
  if (Date.now() - session.createdAt > QR_SESSION_TTL_MS) {
    sessions.delete(sessionId)
    return { state: 'expired', message: '二维码已过期（超过 5 分钟），请重新获取' }
  }

  let parsed: Record<string, unknown>
  try {
    const got = await getJson(session.pollUrl, session.jar, session.userAgent, LP_WAIT_MS)
    parsed = got.parsed
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return { state: 'waiting' }
    // 网络类失败不销毁会话：下一次轮询还会再来，过期由时间戳兜
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('[xiaomi] 轮询扫码状态失败（本轮忽略）:', message.slice(0, 120))
    return { state: 'waiting' }
  }

  const passToken = field(parsed, 'passToken')
  const userId = field(parsed, 'userId')
  if (!passToken || !userId) {
    const code = field(parsed, 'code')
    if (code && code !== '0') {
      sessions.delete(sessionId)
      return { state: 'expired', message: `平台说这张码失效了（code=${code} ${field(parsed, 'desc')}），请重新获取` }
    }
    return { state: 'waiting' }
  }

  const cUserId = field(parsed, 'cUserId')
  try {
    const { serviceToken } = await exchangeServiceToken({ passToken, userId, cUserId, deviceId: session.deviceId })
    const credentials: XiaomiCredentials = {
      serviceToken,
      passToken,
      userId,
      cUserId,
      deviceId: session.deviceId,
      expiresAt: new Date(Date.now() + SERVICE_TOKEN_TTL_MS).toISOString(),
      accountTail: userId.slice(-4),
    }
    sessions.delete(sessionId)
    logger.info('[xiaomi] 扫码登录完成并已换到 micoapi 票', { 账号尾号: credentials.accountTail })
    return { state: 'signedIn', credentials }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('[xiaomi] 换 micoapi 票失败:', message.slice(0, 140))
    return { state: 'failed', message }
  }
}

/** 主动放弃（管理员点了"取消"或换了账号） */
export function abandonQrLogin(sessionId: string): void {
  sessions.delete(sessionId)
}

function pruneSessions(): void {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.createdAt > QR_SESSION_TTL_MS) sessions.delete(id)
  }
}

/** 只给测试用的注入点（与 `_setRunnerForTest` 同构：不 mock 掉真实网络就测不了这条链） */
export function _resetQrSessionsForTest(): void {
  sessions.clear()
}

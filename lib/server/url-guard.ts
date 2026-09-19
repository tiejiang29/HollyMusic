/**
 * 出站请求地址护栏（防 SSRF）
 *
 * 判定依据是「域名解析出的每个 IP 都必须是公网地址」：本机、私网（10/172.16-31/192.168/
 * 169.254/100.64-127/198.18-19）、组播保留段、IPv6 回环与链路本地一律拒绝。
 *
 * 关键约定：只校验初始 URL 挡不住「公网 URL 302 跳内网」，所以凡是从不可信来源
 * （音源脚本、上游接口、用户传入）拿到的地址，都必须走 safePublicFetch 或自行
 * 以 redirect:'manual' 逐跳调用本模块的 assertPublicHttpUrl。
 * 残余风险：校验与真正连接之间存在 DNS rebinding 时间窗（TOCTOU），本模块不覆盖。
 */

import dns from 'dns/promises'
import net from 'net'

export function isPublicIp(address: string): boolean {
  const version = net.isIP(address)
  if (version === 4) {
    const [first, second] = address.split('.').map(Number)
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19))
    )
  }
  if (version === 6) {
    const normalized = address.toLowerCase()
    if (normalized.startsWith('::ffff:')) return isPublicIp(normalized.slice('::ffff:'.length))
    return !(
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    )
  }
  return false
}

/** 校验 http(s) URL 拒绝本机/私网/无法解析地址（防 SSRF），供下载回源、订阅校验与图片抓取复用。 */
export async function assertPublicHttpUrl(value: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('无效的 URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('仅支持 HTTP 或 HTTPS')
  }
  if (url.username || url.password) {
    throw new Error('URL 不能包含账号信息')
  }
  if (url.hostname.toLowerCase() === 'localhost') {
    throw new Error('不允许访问本机或内网地址')
  }
  const addresses = net.isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await dns.lookup(url.hostname, { all: true, verbatim: true }).catch(() => [])
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error('不允许访问本机、内网或无法解析的地址')
  }
  return url
}

/** safePublicFetch 抛出的错误带 code，调用方据此区分 403（地址被拦）与 502（重定向异常）。 */
export type SafeFetchErrorCode = 'BLOCKED_URL' | 'INVALID_REDIRECT' | 'TOO_MANY_REDIRECTS'

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode
  constructor(code: SafeFetchErrorCode, message: string) {
    super(message)
    this.name = 'SafeFetchError'
    this.code = code
  }
}

export const MAX_SAFE_REDIRECTS = 5

/**
 * 逐跳 SSRF 校验的 fetch：每跳（含每个重定向目标）先 assertPublicHttpUrl，
 * 再以 redirect:'manual' 只请求单跳，因此公网地址 302 跳私网会被拦下并抛 SafeFetchError。
 * 其余语义与原生 fetch 一致（init.signal / 超时由调用方控制）。
 */
export async function safePublicFetch(
  url: string,
  init: Omit<RequestInit, 'redirect'> = {},
  maxRedirects: number = MAX_SAFE_REDIRECTS,
): Promise<Response> {
  let currentUrl = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    try {
      await assertPublicHttpUrl(currentUrl)
    } catch (e) {
      throw new SafeFetchError('BLOCKED_URL', e instanceof Error ? e.message : '不允许访问的地址')
    }
    const resp = await fetch(currentUrl, { ...init, redirect: 'manual' })
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location')
      await resp.body?.cancel().catch(() => {})
      if (!location) throw new SafeFetchError('INVALID_REDIRECT', '重定向地址无效')
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }
    return resp
  }
  throw new SafeFetchError('TOO_MANY_REDIRECTS', '重定向次数过多')
}

/**
 * 图片代理 API
 * GET /api/image-proxy?url=<远程图片URL>[&w=<期望像素>] → 返回图片二进制
 *
 * 背景：腾讯 y.gtimg.cn 等平台图片域名命中浏览器广告拦截/跟踪防护规则
 * （ERR_BLOCKED_BY_CLIENT），前端直连会静默失败；改走同源代理绕开客户端拦截。
 * 安全：仅允许音乐平台图片域名白名单（同时天然杜绝 SSRF），响应超时与大小受限，
 * 字节缓存走 imageCache 单例（条数 + 总字节双上限，TTL 60 分钟），并输出 Cache-Control 供浏览器复用。
 *
 * `w`：请求方知道的显示像素，目前只对网易云生效（它的 CDN 认 `param=<w>y<w>`）。
 * 为什么要调用方传而不是全局改写：实测封面中位 64KB，但列表格子只要 ~170 物理像素，
 * 而播放页大圆盘要吃 500~1100 物理像素——一刀切缩略会把大圆盘弄糊，
 * 且 `param=NyN` 会把非方原图（实测有 980x1400 的）裁成方图，构图会变。
 * 所以不传 w 时行为与从前完全一致；传了也只动 music.126.net。
 */

import { NextRequest } from 'next/server'
import { imageCache, type ImageCacheEntry } from '@/lib/cache-manager'
import { logger } from '@/lib/logger'
import { safePublicFetch, SafeFetchError } from '@/lib/server/url-guard'

const ALLOWED_HOST_SUFFIXES = [
  'gtimg.cn', // QQ 图片 CDN（y.gtimg.cn / imgcache.gtimg.cn 等）
  'qpic.cn', // QQ 歌单封面（p.qpic.cn）
  'y.qq.com', // QQ 站内图：music-file.y.qq.com 是用户上传歌单封面的落点（生产实测 403 的就是它），
              // 原先只列了 qpic.y.qq.com 这一具体主机，同族别的子域一律被拒
  'music.126.net', // 网易云
  'kuwo.cn', // 酷我
  'kugou.com', 'kgimg.com', // 酷狗
  'migu.cn', // 咪咕
]

const CACHE_TTL = 60 * 60 * 1000
const MAX_BYTES = 5 * 1024 * 1024
/** 单张超过这个数就只透传不缓存：实测这类占 1.3%，却主导了缓存字节数（均值 121KB 全靠它们抬） */
const CACHEABLE_MAX_BYTES = 1024 * 1024
const REQUEST_TIMEOUT = 8_000
/** `w` 的合法区间：小于 32 没有意义，大于 1000 就是原图规模，没必要当"请求尺寸" */
const THUMB_MIN = 32
const THUMB_MAX = 1000

function isNeteaseImage(hostname: string): boolean {
  return hostname === 'music.126.net' || hostname.endsWith('.music.126.net')
}

function parseThumbWidth(raw: string | null): number | null {
  if (!raw || !/^\d{1,4}$/.test(raw)) return null
  const n = Number(raw)
  return n >= THUMB_MIN && n <= THUMB_MAX ? n : null
}

function isAllowedHost(hostname: string): boolean {
  return ALLOWED_HOST_SUFFIXES.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))
}

export async function GET(request: NextRequest) {
  const rawUrl = request.nextUrl.searchParams.get('url') || ''
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return new Response('invalid url', { status: 400 })
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !isAllowedHost(parsed.hostname)) {
    // 不记日志的话，"某张图在车机/手机上取不到"在服务端完全不可见（生产就这么漏过一次）
    logger.warn('[api/image-proxy] 拒绝代理请求（协议或域名不在白名单）:', parsed.hostname)
    return new Response('host not allowed', { status: 403 })
  }

  // 只有网易云认 param=<w>y<w>；原 URL 已带 param 时不覆盖（平台自己选好的尺寸就别动了）
  const width = parseThumbWidth(request.nextUrl.searchParams.get('w'))
  if (width && isNeteaseImage(parsed.hostname) && !parsed.searchParams.has('param')) {
    parsed.searchParams.set('param', `${width}y${width}`)
  }

  // 键取"实际要打的上游 URL"：不同 w 必须是不同条目，同一 URL 的多种编码写法则该共用一条
  const cacheKey = `image-proxy:v2:${parsed.toString()}`
  const cached = imageCache.get(cacheKey)
  if (cached) return toImageResponse(cached)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    // 首跳已过平台域名白名单，但白名单域名仍可能 302 到其它主机，
    // 故逐跳校验目标为公网地址（重定向目标不再要求白名单：CDN 换主是常态）
    const upstream = await safePublicFetch(parsed.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: `${parsed.protocol}//${parsed.hostname}/` },
      signal: controller.signal,
    })
    if (!upstream.ok) return new Response('upstream error', { status: 502 })

    const contentType = upstream.headers.get('content-type') || ''
    if (!contentType.startsWith('image/')) {
      // 平台偶发返回错误页/跳转页，不能当图片下发
      return new Response('not an image', { status: 502 })
    }
    const bytes = new Uint8Array(await upstream.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
      return new Response('image size out of range', { status: 502 })
    }

    const image: ImageCacheEntry = { bytes, contentType }
    // 大图只透传：一张就顶普通封面十几张的额度，缓存它等于把常用封面挤光
    if (bytes.byteLength <= CACHEABLE_MAX_BYTES) imageCache.set(cacheKey, image, CACHE_TTL)
    return toImageResponse(image)
  } catch (error) {
    if (error instanceof SafeFetchError && error.code === 'BLOCKED_URL') {
      logger.warn('[api/image-proxy] 重定向目标被私网拦截:', rawUrl.slice(0, 100), error.message)
      return new Response('host not allowed', { status: 403 })
    }
    logger.warn('[api/image-proxy] fetch failed:', rawUrl.slice(0, 100), error)
    return new Response('fetch failed', { status: 502 })
  } finally {
    clearTimeout(timeoutId)
  }
}

function toImageResponse(image: ImageCacheEntry): Response {
  return new Response(image.bytes, {
    headers: {
      'Content-Type': image.contentType,
      // 封面低频变化，允许浏览器缓存一天，避免重复打代理
      'Cache-Control': 'public, max-age=86400',
    },
  })
}

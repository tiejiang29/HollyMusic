/**
 * 音频流 serve API（2026-08 重构版）。
 *
 * 设计：URL 解析惰性化——只在「真正 miss」时调用一次上游，由 audioServe 内部进行中去重。
 * 已缓存的请求完全不触发 URL 解析。
 *
 * 鉴权（2026-09）：登录会话（签名 cookie）优先；匿名仅放行分享落地页
 * 签发的 st token（HMAC，绑定 uid+quality+时效，见 lib/services/auth.ts）。
 * 与 /api/music-url、/api/track 等接口口径一致，未认证返回 401。
 *
 * GET  /api/audio?uid=<source-songmid>&quality=<quality>[&st=<shareToken>]
 *      - 已完整缓存 → 本地文件 Range（任意 seek，0 次上游调用）
 *      - 进行中 → attach 到内存 entry（0 次上游调用）
 *      - miss → fetch 上游一次（多用户并发也只 1 次）
 *      - seek 超出已下载 → 等待 15s → 超时 503 + Retry-After
 *
 * HEAD /api/audio?... → 同 GET 但不带 body，供 <audio> 探测
 *
 * uid 格式：`${source}-${存储songmid}`，与 resolveMusicInfoById 一致。
 */

import { NextRequest } from 'next/server'
import { logger } from '@/lib/logger'
import { resolveMusicInfoById } from '@/lib/db'
import { musicSourceManager } from '@/lib/music-source-manager'
import type { QualityType } from '@/lib/types/music'
import { parseIntervalToSeconds } from '@/lib/types/player'
import { audioServe } from '@/lib/audio-serve'
import type { UpstreamUrlResolver } from '@/lib/audio-serve'
import { getAuthState } from '@/lib/services/user-context'
import { verifyShareAudioToken } from '@/lib/services/auth'
import { cacheNativeLyricForMusic } from '@/lib/services/lyrics'
import { serveFromLibrary, ingestFromCache } from '@/lib/services/music-library'

function buildErrorResponse(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({ success: false, error: { code, message } }),
    { status, headers: { 'Content-Type': 'application/json' } }
  )
}

/** 看起来像在取图而不是在取音频：Android HttpURLConnection（Glide）默认不发 Accept，所以只能靠 UA + 显式 image 声明 */
function looksLikeImageFetch(request: NextRequest): boolean {
  const ua = request.headers.get('user-agent') ?? ''
  const accept = request.headers.get('accept') ?? ''
  return ua.startsWith('Dalvik/') || accept.includes('image/')
}

async function handleAudio(request: NextRequest, isHead: boolean): Promise<Response> {
  const { searchParams } = new URL(request.url)
  const uid = searchParams.get('uid')
  const quality = (searchParams.get('quality') || '320k') as QualityType

  if (!uid) {
    return buildErrorResponse(400, 'INVALID_PARAMS', '缺少必填参数: uid')
  }

  const validQualities: QualityType[] = ['128k', '320k', 'flac', 'flac24bit']
  if (!validQualities.includes(quality)) {
    return buildErrorResponse(400, 'QUALITY_NOT_SUPPORTED', `不支持的音质: ${quality}`)
  }

  // 鉴权前置：登录会话优先；匿名仅放行分享页签发的 st token（绑定 uid+quality）。
  // 放在 ensureInitialized 之前，未认证请求不触发磁盘/上游初始化。
  const rangeHeader = request.headers.get('range')
  const authState = await getAuthState(request)
  if (!authState.authenticated) {
    const shareToken = searchParams.get('st') ?? ''
    if (!verifyShareAudioToken(uid, quality, shareToken)) {
      // 车机封面改道：CarWith 的音乐卡片把当前播放项的 MEDIA_URI（就是我们的音频地址）
      // 当图片下载，而这条地址必须登录 → 永远 401、永远没封面。
      // 2026-09-29 车机实测形状：未认证 + 无 cookie + 无 Range + **不发 Accept** +
      // UA=`Dalvik/2.1.0 (Linux; U; Android 16; …)`，一次播放重试 22 次。
      // 只用正向特征取或：以后小米换成 OkHttp 拉图，这里只是失效退回 401，
      // 不会误伤 curl / 浏览器 / 监控探针（它们既不是 Dalvik 也不声明 image）。
      if (!isHead && !rangeHeader && looksLikeImageFetch(request)) {
        logger.info(`[/api/audio] 未认证取图请求改道到封面: uid=${uid} ua=${request.headers.get('user-agent') ?? '-'}`)
        // Location 用相对路径：不用 request.nextUrl.origin 是为了不把 Host 请求头回显进
        // 跳转目标（伪造 Host 就能把我们变成开放重定向器）。
        return new Response(null, {
          status: 302,
          headers: {
            location: `/api/cover/${encodeURIComponent(uid)}`,
            'cache-control': 'no-store',
          },
        })
      }
      return buildErrorResponse(401, 'UNAUTHORIZED', '未登录，且未携带有效的分享凭证')
    }
  }

  try {
    await audioServe.ensureInitialized()

    // 从 DB 解析 uid → MusicInfo（search 时已 upsert，正常流程都有）
    const musicInfo = await resolveMusicInfoById(uid)
    if (!musicInfo) {
      return buildErrorResponse(404, 'NOT_FOUND', `找不到歌曲信息: ${uid}`)
    }

    const cacheKey = `${musicInfo.source}:${musicInfo.songmid}:${quality}`

    // 本地优先 ①：音乐库命中（uid 精确 → 跨平台模糊），库内音质 ≥ 请求档即服务
    const libraryResp = await serveFromLibrary(musicInfo, quality, rangeHeader, isHead)
    if (libraryResp) return libraryResp

    // URL resolver 下沉到 audioServe 内部：只在真正 miss 时调用一次。
    // 已缓存 / 进行中的请求完全不触发 URL 解析（解决重复打上游问题）。
    // 回传 provider：audioServe 发现假地址时可排除该音源重新解析。
    const upstreamUrlResolver: UpstreamUrlResolver = async (excludeProviders) => {
      if (!musicSourceManager.isInitialized()) {
        await musicSourceManager.initialize()
      }
      return musicSourceManager.getMusicUrlWithProvider(musicInfo, quality, { excludeProviders })
    }

    return await audioServe.serve({
      cacheKey,
      upstreamUrlResolver,
      rangeHeader,
      isHead,
      intervalSec: parseIntervalToSeconds(musicInfo.interval),
      // 完成后：歌词预缓存 + 边听边下入库（music-library 内部处理去重/配额）
      onCached: () => Promise.all([
        cacheNativeLyricForMusic(musicInfo),
        ingestFromCache(cacheKey, musicInfo, quality),
      ]).then(() => {}),
    })
  } catch (error) {
    logger.error('[/api/audio] 失败:', error)
    const message = error instanceof Error ? error.message : '音频 serve 失败'
    const status = message.includes('无法获取播放链接') ? 502 : 500
    return buildErrorResponse(status, 'AUDIO_SERVE_FAILED', message)
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  return handleAudio(request, false)
}

export async function HEAD(request: NextRequest): Promise<Response> {
  return handleAudio(request, true)
}

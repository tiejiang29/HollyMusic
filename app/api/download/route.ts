import { NextRequest, NextResponse } from 'next/server'
import { createReadStream } from 'fs'
import { stat, readFile } from 'fs/promises'
import { Readable } from 'stream'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { logger } from '@/lib/logger'
import { resolveMusicInfoById } from '@/lib/db'
import { musicSourceManager } from '@/lib/music-source-manager'
import { audioServe, parseRange } from '@/lib/audio-serve'
import type { UpstreamUrlResolver } from '@/lib/audio-serve'
import { cacheNativeLyricForMusic } from '@/lib/services/lyrics'
import { getCoverBytesById } from '@/lib/services/cover'
import { getLyricSidecarPath } from '@/lib/server/lyric-cache'
import { planTaggedDelivery, createTaggedFileRead } from '@/lib/server/audio-tag-delivery'
import { findLibrarySong, shouldServeLibraryFile } from '@/lib/services/music-library'
import { parseIntervalToSeconds } from '@/lib/types/player'
import type { MusicInfo, QualityType } from '@/lib/types/music'
import { assertPublicHttpUrl } from '@/lib/server/url-guard'
import {
  isValidUrl,
  extractDomain,
  isAllowedDomain,
  getAllowedDomainsFromEnv,
  sanitizeFilename,
  stripHtml,
  buildUpstreamHeaders,
  buildContentDisposition,
  buildFilenameFromMusicInfo,
} from '@/lib/server/download-utils'

/**
 * 音乐下载代理路由
 *
 * 两种模式：
 *
 * 1. uid 模式（推荐，与播放 /api/audio 一致，复用磁盘缓存）：
 *    GET /api/download?uid=<source-songmid>&quality=<quality>
 *    - requireUser 鉴权
 *    - resolveMusicInfoById(uid) 从 DB 解析 MusicInfo
 *    - 后端用 buildFilenameFromMusicInfo 组装文件名（不接收前端 filename，安全）
 *    - audioServe.serve({ cacheKey, upstreamUrlResolver, ... })
 *      · 缓存命中（播放过）→ 磁盘读，0 回源
 *      · 缓存 miss → 回源一次 + 边下边落盘 + 跟随交付完整文件（下次命中）
 *    - 注入 Content-Disposition: attachment
 *
 * 2. url 模式（兼容直链下载，不缓存）：
 *    GET /api/download?url=<encoded>&filename=<name>
 *    - requireUser 鉴权
 *    - 直接流式代理上游，加 Content-Disposition（filename 由前端提供 + sanitize）
 *
 * 鉴权：受 requireUser 保护，未登录返回 401。
 */


/** 按扩展名给 Content-Type（库内文件无 DB contentType） */
function contentTypeForPath(filePath: string): string {
  const map: Record<string, string> = {
    '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
    '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  }
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return map[ext] || 'audio/mpeg'
}

// ============================================================================
// 配置常量
// ============================================================================

/** url 模式：单文件大小上限（字节），默认 500MB */
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024

/** url 模式：回源 fetch 超时（毫秒） */
const UPSTREAM_TIMEOUT_MS = 30_000

// ============================================================================
// 域名白名单（url 模式用；默认放行所有，环境变量配置后生效）
// ============================================================================

function getAllowedDownloadDomains(): string[] {
  const fromEnv = getAllowedDomainsFromEnv()
  return fromEnv.length > 0 ? fromEnv : ['*']
}

// ============================================================================
// uid 模式：复用 AudioServe 磁盘缓存
// ============================================================================

async function handleDownloadByUid(
  request: NextRequest,
  uid: string,
  quality: QualityType,
  clientIP: string
): Promise<NextResponse> {
  // 1. 从 DB 解析 uid → MusicInfo（搜索时已 upsert，正常流程都有）
  const musicInfo = await resolveMusicInfoById(uid)
  if (!musicInfo) {
    logger.warn(`[download] uid 未找到: ${uid} ip=${clientIP}`)
    return NextResponse.json(
      { error: `找不到歌曲信息: ${uid}` },
      { status: 404 }
    )
  }

  // 2. cacheKey 与 /api/audio 完全一致，确保命中同一份磁盘缓存
  const cacheKey = `${musicInfo.source}:${musicInfo.songmid}:${quality}`

  // 3. upstreamUrlResolver：只在 cache miss 时调用一次（audioServe 内部去重）
  //    回传 provider：audioServe 发现假地址时可排除该音源重新解析
  const upstreamUrlResolver: UpstreamUrlResolver = async (excludeProviders) => {
    if (!musicSourceManager.isInitialized()) {
      await musicSourceManager.initialize()
    }
    return musicSourceManager.getMusicUrlWithProvider(musicInfo, quality, { excludeProviders })
  }

  // 3.5 本地优先：音乐库命中（uid 精确 → 跨平台模糊，音质 ≥ 请求档）直接发文件
  //     复用库内音质构造文件名扩展名（后端组装，不信任前端输入）
  const rangeHeader = request.headers.get('range')
  const libraryRow = await findLibrarySong(musicInfo)
  if (libraryRow && shouldServeLibraryFile(libraryRow, quality, musicInfo.types)) {
    const fstat = await stat(libraryRow.filePath).catch(() => null)
    if (fstat) {
      const libFilename = sanitizeFilename(
        buildFilenameFromMusicInfo(musicInfo, libraryRow.quality as QualityType)
      )
      const contentType = contentTypeForPath(libraryRow.filePath)
      const disposition = buildContentDisposition(libFilename)
      logger.info(`[download] library 命中 uid=${uid} file=${libraryRow.filePath}`)
      // 正本同样只做"交付侧换链头"，**绝不写库文件本身** —— 它是全库里最不可重建的数据。
      // 改写不成（非 flac / 链头异常 / 封面歌词缺失）就退回下面这条原样直发，字节行为与今天一致。
      const tagged = await deliverTaggedFile({
        served: { filePath: libraryRow.filePath, size: fstat.size, contentType },
        musicInfo, uid, disposition, rangeHeader,
      })
      if (tagged) return tagged
      return new NextResponse(createReadStream(libraryRow.filePath) as unknown as ReadableStream, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(fstat.size),
          'Content-Disposition': disposition,
        },
      })
    }
  }

  // 4. 确保 audioServe 已初始化（创建缓存目录等）
  await audioServe.ensureInitialized()

  // 5. 委托 audioServe（缓存命中 → 磁盘读；miss → 回源 + 边下边落盘 + 跟随交付）
  //    透传客户端 Range 头：普通下载（window.location.href）无 Range，audioServe
  //    返回 200 完整文件；浏览器断点续传携带 Range，返回 206 完整区间
  /** 本地整文件交付时 audioServe 告诉我们文件在哪、按记账多大（打标签要预读链头） */
  let servedFromDisk: { filePath: string; size: number; contentType: string } | null = null
  const audioResp = await audioServe.serve({
    cacheKey,
    upstreamUrlResolver,
    rangeHeader,
    isHead: false,
    intervalSec: parseIntervalToSeconds(musicInfo.interval),
    onCached: () => cacheNativeLyricForMusic(musicInfo),
    onServedFromDisk: info => { servedFromDisk = info },
  })

  // 6. audioServe 错误响应（502/503）直接透传
  if (!audioResp.ok) {
    logger.warn(
      `[download] audioServe 返回 ${audioResp.status} uid=${uid} cacheKey=${cacheKey} ip=${clientIP}`
    )
    return new NextResponse(audioResp.body, {
      status: audioResp.status,
      headers: audioResp.headers,
    })
  }

  // 7. 后端组装文件名（不信任前端输入，从 DB MusicInfo 构造）
  //    非侵入式：不改 audio-serve.ts，仅在外层包装
  const finalFilename = sanitizeFilename(buildFilenameFromMusicInfo(musicInfo, quality))
  const disposition = buildContentDisposition(finalFilename)

  // 7.5 元数据打标：只要这次是从本地文件交付就尝试改写（含续传的 Range，见 deliverTaggedFile
  //     里的字节空间换算）。任何一步不成都原样交付 —— 元数据是增益，不是下载的前置条件。
  if (servedFromDisk) {
    const tagged = await deliverTaggedFile({
      served: servedFromDisk, musicInfo, uid, disposition, rangeHeader,
    })
    if (tagged) return tagged
  }

  const headers = new Headers(audioResp.headers)
  headers.set('Content-Disposition', disposition)

  logger.info(
    `[download] ok uid=${uid} cacheKey=${cacheKey} ip=${clientIP} status=${audioResp.status}`
  )

  return new NextResponse(audioResp.body, {
    status: audioResp.status,
    headers,
  })
}

// ============================================================================
// 元数据打标交付（见 lib/server/audio-tag.ts 的约束说明）
// ============================================================================

/** 封面抓取内部超时 5s，这里再压一刀：封面再慢也不该把一次下载的首字节拖过 3 秒 */
const COVER_BUDGET_MS = 3000

/**
 * 返回打过标签的响应；返回 null 表示"不改写，调用方按原样交付"。
 * 整段兜 try/catch：读盘、取封面、重写链头任何一步失败都不能让下载变成 500。
 */
async function deliverTaggedFile(args: {
  served: { filePath: string; size: number; contentType: string }
  musicInfo: MusicInfo
  uid: string
  disposition: string
  rangeHeader: string | null
}): Promise<NextResponse | null> {
  const { served, musicInfo, uid, disposition, rangeHeader } = args
  try {
    const lyric = await readSidecarLyric(served.filePath)
    const picture = await withBudget(getCoverBytesById(uid), COVER_BUDGET_MS)

    const plan = await planTaggedDelivery(served.filePath, served.size, {
      // 上游数据可能被 HTML 高亮标签污染，与文件名同一把尺清洗
      TITLE: stripHtml(musicInfo.name || '').trim() || null,
      ARTIST: stripHtml(musicInfo.singer || '').trim() || null,
      ALBUM: stripHtml(musicInfo.albumName || '').trim() || null,
      // 只写已落盘的精确歌词；拿不到就整个字段不写（错配比缺失糟糕得多）
      LYRICS: lyric,
    }, picture)

    if ('reason' in plan) {
      logger.info(`[download] 未打标签 uid=${uid} 原因=${plan.reason}`)
      return null
    }

    // 续传/分段请求一律在**改写后的字节空间**里解析：这样同一个 URL 的任何切片都来自
    // 同一套字节，不会出现"打过标签的前半 + 没打的后半"拼成坏文件的情况。
    const range = parseRange(rangeHeader, plan.totalLength)
    if (range === 'unsatisfiable') {
      return new NextResponse(null, {
        status: 416,
        headers: {
          'Content-Range': `*/${plan.totalLength}`,
          'Content-Type': served.contentType,
          'Cache-Control': 'no-store',
        },
      })
    }
    const start = range ? range.start : 0
    const end = range ? range.end : plan.totalLength - 1

    const headers = new Headers()
    headers.set('Content-Type', served.contentType)
    headers.set('Content-Length', String(end - start + 1))
    headers.set('Content-Disposition', disposition)
    // 不骗浏览器"不能续传"：它续传时我们会用同一套空间回应，语义是诚实的。
    // 但也不给 `public, max-age=3600`：这份副本是按用户元数据拼出来的，缓存下来
    // 只会让"改了标签还发旧内容"变得难以解释。
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Cache-Control', 'no-store')
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${plan.totalLength}`)

    logger.info(
      `[download] 已写入标签 uid=${uid} 容器=${plan.container} 头部 ${plan.audioStart}B→${plan.newHead.length}B `
      + `尾部裁 ${plan.tailTrim}B 长度 ${served.size}→${plan.totalLength} 区间=${range ? '206' : '200'} `
      + `歌词=${lyric ? '有' : '无'} 封面=${picture ? `${picture.data.length}B` : '无'}`
    )
    const stream = createTaggedFileRead(served.filePath, plan, start, end)
    return new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: range ? 206 : 200,
      headers,
    })
  } catch (err) {
    logger.warn(`[download] 打标流程异常，按原样交付 uid=${uid}:`, err)
    return null
  }
}

/** 歌词只读缓存旁已有的 sidecar（由播放/下载后置任务写入），绝不为打标签现取上游 */
async function readSidecarLyric(audioFilePath: string): Promise<string | null> {
  try {
    const text = await readFile(getLyricSidecarPath(audioFilePath), 'utf-8')
    return text.trim() ? text.trim() : null
  } catch {
    return null
  }
}

/** 超时后给 null，而不是让封面把下载卡住 */
async function withBudget<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms) }),
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ============================================================================
// url 模式：直接流式代理（不缓存，兼容直链场景）
// ============================================================================

async function handleDownloadByUrl(
  url: string,
  filename: string | null,
  clientIP: string
): Promise<NextResponse> {
  if (!isValidUrl(url)) {
    return NextResponse.json({ error: '无效的 URL' }, { status: 400 })
  }

  const domain = extractDomain(url)
  const allowed = getAllowedDownloadDomains()
  if (!domain || !isAllowedDomain(domain, allowed)) {
    logger.warn(`[download] 域名被拒: ${domain} | ip=${clientIP}`)
    return NextResponse.json({ error: '不支持的下载域名' }, { status: 403 })
  }

  // header 阶段限时 UPSTREAM_TIMEOUT_MS；header 返回后转为 body 阶段的
  // stall 续期（每收到一块数据续期），慢速但持续的传输不误杀，真 stall 才中止
  const controller = new AbortController()
  const stallTimer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  if (stallTimer.unref) stallTimer.unref()

  // 私网/本机地址拦截（无论白名单如何配置都强制生效，关闭认证后 SSRF 面）
  try {
    await assertPublicHttpUrl(url)
  } catch (e) {
    logger.warn(`[download] 地址被私网拦截 url=${url.slice(0, 120)} ip=${clientIP}:`, e instanceof Error ? e.message : e)
    return NextResponse.json({ error: '不允许的下载地址' }, { status: 403 })
  }

  // 手动跟随重定向：逐跳校验目标地址，防止公网 URL 302 跳私网
  let remoteResponse: Response | undefined
  let currentUrl = url
  try {
    const MAX_REDIRECTS = 5
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicHttpUrl(currentUrl)
      const resp = await fetch(currentUrl, {
        headers: buildUpstreamHeaders(currentUrl),
        signal: controller.signal,
        redirect: 'manual',
      })
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location')
        await resp.body?.cancel().catch(() => {})
        if (!location) {
          return NextResponse.json({ error: '下载源重定向地址无效' }, { status: 502 })
        }
        currentUrl = new URL(location, currentUrl).toString()
        continue
      }
      remoteResponse = resp
      break
    }
    if (!remoteResponse) {
      return NextResponse.json({ error: '下载源重定向次数过多' }, { status: 502 })
    }
  } catch (e) {
    clearTimeout(stallTimer)
    if (e instanceof Error && e.message.includes('不允许访问')) {
      logger.warn(`[download] 重定向跳私网被拦 url=${url.slice(0, 120)} → ${currentUrl.slice(0, 120)} ip=${clientIP}`)
      return NextResponse.json({ error: '不允许的下载地址' }, { status: 403 })
    }
    const err = e as Error
    const isTimeout =
      err.name === 'TimeoutError' ||
      err.name === 'AbortError' ||
      (err.message?.includes('aborted') ?? false)
    if (isTimeout) {
      logger.error(`[download] 回源超时 url=${url} ip=${clientIP}:`, err.message)
      return NextResponse.json({ error: '下载超时' }, { status: 504 })
    }
    logger.error(`[download] 回源网络错误 url=${url} ip=${clientIP}:`, err.message)
    return NextResponse.json({ error: '下载源不可用' }, { status: 502 })
  }
  // header 已返回：计时重置，转入 body 阶段的 stall 续期
  stallTimer.refresh()

  if (!remoteResponse.ok) {
    clearTimeout(stallTimer)
    await remoteResponse.body?.cancel().catch(() => {})
    logger.warn(`[download] 远端返回 ${remoteResponse.status} url=${url} ip=${clientIP}`)
    return NextResponse.json(
      { error: `远端服务器错误: ${remoteResponse.status}` },
      { status: remoteResponse.status }
    )
  }

  const contentLength = remoteResponse.headers.get('content-length')
  if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE_BYTES) {
    clearTimeout(stallTimer)
    await remoteResponse.body?.cancel().catch(() => {})
    logger.warn(
      `[download] 文件超限 ${contentLength} bytes > ${MAX_FILE_SIZE_BYTES} url=${url} ip=${clientIP}`
    )
    return NextResponse.json({ error: '文件过大' }, { status: 413 })
  }

  const contentType = remoteResponse.headers.get('content-type') || 'application/octet-stream'
  const finalFilename = sanitizeFilename(filename || 'download.mp3')

  const headers = new Headers()
  headers.set('Content-Type', contentType)
  headers.set('Content-Disposition', buildContentDisposition(finalFilename))

  logger.info(
    `[download] ok(url) url=${url} ip=${clientIP} status=${remoteResponse.status} type=${contentType}`
  )

  return new NextResponse(pumpBodyWithStallTimeout(remoteResponse.body, stallTimer), {
    status: remoteResponse.status,
    headers,
  })
}

/**
 * 把上游 body 包装成带 stall 续期的流：每收到一块数据就续期计时器，
 * 慢速但持续的传输不触发超时；流结束/出错/客户端取消时清理计时器。
 * （直接把 body 交给 NextResponse 时，AbortSignal.timeout 这类全程计时
 * 会把传输超过 30s 的下载拦腰掐断。）
 */
function pumpBodyWithStallTimeout(
  body: ReadableStream<Uint8Array> | null,
  stallTimer: NodeJS.Timeout
): ReadableStream<Uint8Array> | null {
  if (!body) {
    clearTimeout(stallTimer)
    return null
  }
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          clearTimeout(stallTimer)
          controller.close()
          return
        }
        stallTimer.refresh()
        controller.enqueue(value)
      } catch (e) {
        clearTimeout(stallTimer)
        try {
          controller.error(e)
        } catch {
          // 客户端已取消（流已 closed），忽略
        }
      }
    },
    cancel() {
      clearTimeout(stallTimer)
      reader.cancel().catch(() => {})
    },
  })
}

// ============================================================================
// 客户端 IP
// ============================================================================

function getClientIP(request: NextRequest): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ip = (request as any).ip ?? request.headers.get('x-forwarded-for') ?? 'unknown'
  return typeof ip === 'string' ? ip.split(',')[0].trim() : 'unknown'
}

// ============================================================================
// GET handler（两种模式分流）
// ============================================================================

const VALID_QUALITIES: QualityType[] = ['128k', '320k', 'flac', 'flac24bit']

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)

    const { searchParams } = new URL(request.url)
    const uid = searchParams.get('uid')
    const urlParam = searchParams.get('url')
    const filename = searchParams.get('filename')
    const clientIP = getClientIP(request)

    // uid 模式（推荐）：filename 后端组装，不读取前端传入
    if (uid) {
      const quality = (searchParams.get('quality') || '320k') as QualityType
      if (!VALID_QUALITIES.includes(quality)) {
        return NextResponse.json(
          { error: `不支持的音质: ${quality}` },
          { status: 400 }
        )
      }
      return await handleDownloadByUid(request, uid, quality, clientIP)
    }

    // url 模式（兼容）：filename 必须由前端提供
    if (urlParam) {
      let url: string
      try {
        url = decodeURIComponent(urlParam)
      } catch {
        return NextResponse.json({ error: '无效的 URL 编码' }, { status: 400 })
      }
      return await handleDownloadByUrl(url, filename, clientIP)
    }

    return NextResponse.json(
      { error: '缺少参数：需提供 uid 或 url' },
      { status: 400 }
    )
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('[download] GET 未预期错误:', error)
    return NextResponse.json({ error: '下载失败' }, { status: 500 })
  }
}

/**
 * POST /api/download  body: { url: string, filename?: string }
 * 保留 POST url 模式兼容（uid 模式只用 GET，因为 window.location.href 只能 GET）。
 */
export async function POST(request: NextRequest) {
  try {
    await requireUser(request)

    const body = await request.json()
    const { url, filename } = body as { url?: string; filename?: string }

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: '缺少或无效的 url 参数' }, { status: 400 })
    }

    return await handleDownloadByUrl(url, filename ?? null, getClientIP(request))
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('[download] POST 未预期错误:', error)
    return NextResponse.json({ error: '下载失败' }, { status: 500 })
  }
}

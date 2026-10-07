/**
 * 给小爱音箱用的音频流出口（G1）。
 *
 * 为什么不复用 `/api/audio`：那条有"本地秒开优先"——请求 320k 时只要库里有更高档的文件
 * （FLAC/24bit）就直接端出来（`shouldServeLibraryFile`），手机和车机听得懂 FLAC，
 * **音箱听不懂**。这是一条天天在用的热路径，为音箱去改它的裁决规则不值得，
 * 所以这里单独开一条**只认 MP3** 的口：容器不是 MP3 就不给，宁可明确报错。
 *
 * 鉴权：只认 `st` 分享令牌（与分享落地页同一套 HMAC，绑定 uid+quality，见 `lib/services/auth.ts`），
 * 音箱没有会话 cookie，也不该有。
 *
 * **参数顺序是有意的**：`st` 必须放第一个。
 * `songloft-plugin-miot` 与 `xiaomusic` 都记录过部分固件会把 URL 里的 `&` 换成空格，
 * 令牌在前才能靠"第一个空格之前就是令牌"把它还原回来（见 `readParams`）。
 *
 * GET /api/speaker/stream?st=<token>&uid=<source-songmid>&quality=320k
 */
import { NextRequest } from 'next/server'
import fsp from 'fs/promises'
import { logger } from '@/lib/logger'
import { resolveMusicInfoById } from '@/lib/db'
import { musicSourceManager } from '@/lib/music-source-manager'
import { audioServe, buildFullResponse, buildPartialResponse, buildUnsatisfiable, parseRange } from '@/lib/audio-serve'
import type { UpstreamUrlResolver } from '@/lib/audio-serve'
import { verifyShareAudioToken } from '@/lib/services/auth'
import { parseIntervalToSeconds } from '@/lib/types/player'
import { findLibrarySong } from '@/lib/services/music-library'
import { detectContainer, readHeadBytes, mimeFromContainer } from '@/lib/server/audio-sniff'
import type { QualityType } from '@/lib/types/music'

/** 音箱只给 MP3 档（G1.5 的转码上线之前不放开 flac） */
const SPEAKER_QUALITIES: QualityType[] = ['320k', '128k']

function fail(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ success: false, error: { code, message } }), {
    status, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * 读查询参数，顺手处理"固件把 & 换成空格"。
 *
 * 令牌在第一位，所以空格之后的内容一定是被吞掉的分隔符：`st=<jwt> uid=<x> quality=320k`。
 * JWT 自己不含空格（base64url + '.' + hex），可以按空格安全切开还原。
 */
export function readParams(request: NextRequest): URLSearchParams {
  const raw = new URL(request.url).searchParams
  const token = raw.get('st')
  if (!token || !token.includes(' ')) return raw
  const pieces = token.split(/\s+/)
  const fixed = new URLSearchParams(raw)
  fixed.set('st', pieces[0])
  for (const piece of pieces.slice(1)) {
    const eq = piece.indexOf('=')
    if (eq > 0) fixed.set(piece.slice(0, eq), piece.slice(eq + 1))
  }
  logger.info('[speaker/stream] 还原了被固件改写成分隔符的查询参数')
  return fixed
}

/** Range 语义与 `/api/audio` 共用 audio-serve 的那套构造，不另写一份 */
async function serveFile(filePath: string, contentType: string, rangeHeader: string | null, isHead: boolean): Promise<Response> {
  const stat = await fsp.stat(filePath)
  const range = parseRange(rangeHeader, stat.size)
  if (range === 'unsatisfiable') return buildUnsatisfiable(stat.size)
  if (range === null) return buildFullResponse(filePath, stat.size, contentType, isHead)
  return buildPartialResponse(filePath, stat.size, contentType, range, isHead)
}

async function handleSpeakerStream(request: NextRequest, isHead: boolean): Promise<Response> {
  const params = readParams(request)
  const uid = params.get('uid') ?? ''
  const quality = (params.get('quality') || '320k') as QualityType
  const token = params.get('st') ?? ''

  if (!uid) return fail(400, 'INVALID_PARAMS', '缺少 uid')
  if (!SPEAKER_QUALITIES.includes(quality)) {
    // 音箱听不懂 flac，这里不是"降一档"而是直接拒 —— 静默降档会让管理员以为推的是高品
    return fail(400, 'QUALITY_NOT_SUPPORTED', `音箱只支持 MP3 档（320k/128k），请求的是 ${quality}`)
  }
  if (!verifyShareAudioToken(uid, quality, token)) {
    return fail(401, 'UNAUTHORIZED', '分享凭证无效或已过期')
  }

  const musicInfo = await resolveMusicInfoById(uid)
  if (!musicInfo) return fail(404, 'NOT_FOUND', `找不到歌曲信息: ${uid}`)

  const rangeHeader = request.headers.get('range')

  // ① 库里有文件且**容器真是 MP3** 才走本地（扩展名不算证据，读头部字节嗅容器）
  const row = await findLibrarySong(musicInfo)
  if (row) {
    const head = await readHeadBytes(row.filePath)
    const container = detectContainer(head ?? new Uint8Array())
    if (container === 'mp3') {
      return serveFile(row.filePath, mimeFromContainer('mp3') ?? 'audio/mpeg', rangeHeader, isHead)
    }
    logger.info('[speaker/stream] 库内文件不是 MP3，改走在线取 MP3 档', {
      歌曲: `${musicInfo.name}`, 库内: row.quality, 嗅到: container ?? '未知',
    })
  }

  // ② 在线取 320k/128k：走 audioServe（带缓存与进行中重复请求合并），拿到响应后**按字节给的 MIME 再核一次**
  try {
    const cacheKey = `${musicInfo.source}:${musicInfo.songmid}:${quality}`
    const resolver: UpstreamUrlResolver = async excludeProviders => {
      if (!musicSourceManager.isInitialized()) await musicSourceManager.initialize()
      return musicSourceManager.getMusicUrlWithProvider(musicInfo, quality, { excludeProviders })
    }
    const res = await audioServe.serve({
      cacheKey,
      upstreamUrlResolver: resolver,
      rangeHeader,
      isHead,
      intervalSec: parseIntervalToSeconds(musicInfo.interval),
    })
    const served = res.headers.get('content-type') ?? ''
    if (res.ok && !served.includes('audio/mpeg')) {
      // 源把 flac 标成 320k 是发生过的（扩展名撒谎那一类）；给音箱这份必须是 MP3
      return fail(415, 'NOT_MP3', `这一档拿回来的不是 MP3（${served || '未知类型'}），音箱放不了，等转码那期`)
    }
    return res
  } catch (err) {
    const message = err instanceof Error ? err.message : '音箱流出口失败'
    logger.warn('[speaker/stream] 失败:', message.slice(0, 160))
    return fail(502, 'UPSTREAM_FAILED', message.includes('无法获取播放链接') ? '各音源都没给出这一档的可播地址' : message)
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  return handleSpeakerStream(request, false)
}

export async function HEAD(request: NextRequest): Promise<Response> {
  return handleSpeakerStream(request, true)
}

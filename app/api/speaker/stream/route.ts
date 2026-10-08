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
import { audioServe, buildFullResponse, buildPartialResponse, buildUnsatisfiable, parseRange, resolvePaths } from '@/lib/audio-serve'
import type { UpstreamUrlResolver } from '@/lib/audio-serve'
import { verifyShareAudioToken } from '@/lib/services/auth'
import { parseIntervalToSeconds } from '@/lib/types/player'
import { findLibrarySong } from '@/lib/services/music-library'
import { detectContainer, readHeadBytes, readBytesAt, mimeFromContainer } from '@/lib/server/audio-sniff'
import { planMp3Seek, alignToFrameStart, NOMINAL_BYTES_PER_SEC, MP3_HEAD_BYTES } from '@/lib/server/mp3-seek'
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

/**
 * `seek=<秒>`：音箱侧没有设备端 seek（2026-10-08 真机实测：重推一条流会让它**从 0 起播**），
 * 所以"拖进度条"只能重推一条从中间开始的地址。坏值一律当 0（不改位置），不做"猜一个"的事。
 */
export function readSeekSec(params: URLSearchParams): number {
  const raw = params.get('seek')
  if (!raw) return 0
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 名义每秒字节数：只有帧头读不出来时才用（音质档是标签，标签可能撒谎） */
function nominalBytesPerSec(quality: string): number {
  return NOMINAL_BYTES_PER_SEC[quality as '320k' | '128k'] ?? NOMINAL_BYTES_PER_SEC['320k']
}

/** Range 语义与 `/api/audio` 共用 audio-serve 的那套构造，不另写一份 */
async function serveFile(filePath: string, contentType: string, rangeHeader: string | null, isHead: boolean): Promise<Response> {
  const stat = await fsp.stat(filePath)
  const range = parseRange(rangeHeader, stat.size)
  if (range === 'unsatisfiable') return buildUnsatisfiable(stat.size)
  if (range === null) return buildFullResponse(filePath, stat.size, contentType, isHead)
  return buildPartialResponse(filePath, stat.size, contentType, range, isHead)
}

/** 在新起点附近最多找这么远就认输（一帧 1KB 量级，32KB 足够跨过几十帧） */
const ALIGN_WINDOW_BYTES = 32 * 1024

/**
 * 把粗偏移挪到真正的帧首；找不到就原样返回并留下警告。
 *
 * 这不是锦上添花：设备的解码器从半帧开始会反复重连然后放弃播放
 * （2026-10-08 实测：拖动定位后 330ms 内同一地址被拉 5 次，状态停在 status=2 position=0，一声不出）。
 */
async function alignSeekStart(filePath: string, rough: number): Promise<{ start: number; aligned: boolean }> {
  const window = await readBytesAt(filePath, rough, ALIGN_WINDOW_BYTES)
  const delta = window ? alignToFrameStart(window, 0) : null
  return delta === null ? { start: rough, aligned: false } : { start: rough + delta, aligned: true }
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
  const seekSec = readSeekSec(params)

  // ① 库里有文件且**容器真是 MP3** 才走本地（扩展名不算证据，读头部字节嗅容器）
  const row = await findLibrarySong(musicInfo)
  if (row) {
    const head = await readHeadBytes(row.filePath)
    const container = detectContainer(head ?? new Uint8Array())
    if (container === 'mp3') {
      const contentType = mimeFromContainer('mp3') ?? 'audio/mpeg'
      if (seekSec > 0) {
        // seek 优先于请求头里的 Range：seek 定义"这条流从哪儿开始"，Range 只是设备自己的缓冲偏好
        const stat = await fsp.stat(row.filePath)
        const head = await readHeadBytes(row.filePath, MP3_HEAD_BYTES)
        const plan = planMp3Seek(head ?? new Uint8Array(), seekSec, nominalBytesPerSec(row.quality))
        if (plan.offset >= stat.size) return buildUnsatisfiable(stat.size)
        const seek = await alignSeekStart(row.filePath, plan.offset)
        logger.info('[speaker/stream] 按 seek 重推', {
          秒: seekSec, 粗字节: plan.offset, 起字节: seek.start, 对齐: seek.aligned,
          文件字节: stat.size, 码率来源: plan.from, 每秒字节: plan.bytesPerSec,
        })
        if (!seek.aligned) logger.warn('[speaker/stream] 没找到帧首，按粗偏移发（设备可能不出声）', { 歌曲: musicInfo.name })
        // 这条流是"从第 seek 秒开始的一首歌"，本身就不是原文件的某个连续区间：
        // 设备照惯例发的 `Range: bytes=0-` 在这里没有意义（回 206 且起点不是 0，它会不会当成
        // 应答错乱而反复重试，正是要验的事），所以直接按 200 把剩下的部分整条给它。
        void rangeHeader
        return buildFullResponse(row.filePath, stat.size - seek.start, contentType, isHead, seek.start)
      }
      return serveFile(row.filePath, contentType, rangeHeader, isHead)
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
    // 在线这一路的秒→字节只能按音质档名义码率估（文件没落盘时读不到真实码率）；
    // 但缓存过的那份照样能做帧对齐 —— 首次播放就会缓存下来，所以第二次起是准的
    let effectiveRange = rangeHeader
    if (seekSec > 0) {
      const rough = Math.round(seekSec * nominalBytesPerSec(quality))
      const seek = await alignSeekStart(resolvePaths(cacheKey, 'audio/mpeg').filePath, rough)
      logger.info('[speaker/stream] 在线档按 seek 重推', { 秒: seekSec, 粗字节: rough, 起字节: seek.start, 对齐: seek.aligned })
      effectiveRange = `bytes=${seek.start}-`
    }
    const res = await audioServe.serve({
      cacheKey,
      upstreamUrlResolver: resolver,
      rangeHeader: effectiveRange,
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

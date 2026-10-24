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
import { existsSync } from 'fs'
import { logger } from '@/lib/logger'
import { resolveMusicInfoById } from '@/lib/db'
import { musicSourceManager, readSpeakerUrlBudgets } from '@/lib/music-source-manager'
import { audioServe, buildFullResponse, buildPartialResponse, buildUnsatisfiable, parseRange, resolvePaths } from '@/lib/audio-serve'
import type { UpstreamUrlResolver } from '@/lib/audio-serve'
import { verifyShareAudioToken } from '@/lib/services/auth'
import { parseIntervalToSeconds } from '@/lib/types/player'
import { findLibrarySong } from '@/lib/services/music-library'
import { detectContainer, readHeadBytes, readBytesAt, mimeFromContainer } from '@/lib/server/audio-sniff'
import { planMp3Seek, alignToFrameStart, NOMINAL_BYTES_PER_SEC, MP3_HEAD_BYTES } from '@/lib/server/mp3-seek'
import { readParams, readSeekSec } from '@/lib/server/speaker-stream-params'
import type { QualityType } from '@/lib/types/music'

/** 音箱只给 MP3 档。库里是 FLAC 时改走在线取 MP3 档；在线也给不出就明确 415（这一期不做转码） */
const SPEAKER_QUALITIES: QualityType[] = ['320k', '128k']

function fail(status: number, code: string, message: string, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ success: false, error: { code, message } }), {
    status, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store', ...headers },
  })
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

/**
 * 把一条本地 MP3 文件（库内的，或 G1.5 转码出来的）按音箱要的方式发出去。
 *
 * 两种情形都走这同一条：① 没 seek ⇒ 正常 Range（206/200/416 由 audio-serve 那套构造）；
 * ② 有 seek ⇒ 恒按 **200 整发剩余部分**，因为"从中间开始的一条流"不是原文件的某个连续区间，
 * 设备照惯例发的 `Range: bytes=0-` 在这里没有意义（回 206 且起点不是 0 会被它当成应答错乱，
 * 2026-10-08 实测过：改回 200 之后设备才出声）。
 */
async function serveLocalMp3(
  filePath: string, quality: string, seekSec: number,
  rangeHeader: string | null, isHead: boolean, name: string,
): Promise<Response> {
  const contentType = mimeFromContainer('mp3') ?? 'audio/mpeg'
  if (seekSec <= 0) return serveFile(filePath, contentType, rangeHeader, isHead)
  const stat = await fsp.stat(filePath)
  const head = await readHeadBytes(filePath, MP3_HEAD_BYTES)
  const plan = planMp3Seek(head ?? new Uint8Array(), seekSec, nominalBytesPerSec(quality))
  if (plan.offset >= stat.size) return buildUnsatisfiable(stat.size)
  const seek = await alignSeekStart(filePath, plan.offset)
  logger.info('[speaker/stream] 按 seek 重推', {
    秒: seekSec, 粗字节: plan.offset, 起字节: seek.start, 对齐: seek.aligned,
    文件字节: stat.size, 码率来源: plan.from, 每秒字节: plan.bytesPerSec,
  })
  if (!seek.aligned) logger.warn('[speaker/stream] 没找到帧首，按粗偏移发（设备可能不出声）', { 歌曲: name })
  return buildFullResponse(filePath, stat.size - seek.start, contentType, isHead, seek.start)
}

/**
 * 把 audioServe 那份 206 换成与 `serveLocalMp3` 同形的 200 尾巴（只换信封，字节流原样接着用）。
 *
 * 在线那一路是借 `serve()` 的 Range 把字节定位到 seek 处的，它认了 Range 就一定回 206；
 * 而这台固件把"206 且起点不是 0"当成应答错乱（2026-10-11 真机：拖一下进度，同一地址被拉
 * 3 次就翻到同批次的下一首）。库内 MP3 那条 10-08 就改成 200 了，这里是补齐另一半。
 *
 * 只在真是 206 时换。非 206 有两种：整发的 200（字节本来就从 0 起，没信封可换）与 4xx，
 * 都照原样交出去 —— 硬编一个 Content-Length 会把长度说瞎。
 */
function asFullTail(res: Response, start: number, isHead: boolean): Response {
  if (res.status !== 206) return res
  const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1])
  if (!Number.isFinite(total) || total <= start) {
    logger.warn('[speaker/stream] 带 seek 却没拿到可读的 Content-Range，按原样发（位置会从 0 起）',
      { 状态: res.status, 起点字节: start })
    return res
  }
  const headers = new Headers({
    'Content-Type': res.headers.get('content-type') ?? 'audio/mpeg',
    'Content-Length': String(total - start),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
  })
  return new Response(isHead ? null : res.body, { status: 200, headers })
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

  // 设备**约 5.1 秒**拿不到字节就断开、0.1 秒后重拉同一地址 —— 所以"它来拉到、我们备好响应"
  // 这段必须量出来才知道抢播慢在哪一段。起点取在这里：前面那些只是字符串活，量了会稀释数字
  const t0 = Date.now()
  // `交付状态` 只有在线那一路给（它手上就有最终响应）；库内那条要等 serveLocalMp3 构造完才知道，
  // 不在这里硬填一个还没定的数
  const logReady = (route: string, 交付状态?: number) => logger.info('[speaker/stream] 响应准备好了', {
    歌曲: musicInfo.name, 走的路: route, 用时ms: Date.now() - t0, 起点秒: seekSec,
    ...(交付状态 === undefined ? {} : { 交付状态 }),
  })

  // ① 库里有文件且**容器真是 MP3** 才走本地（扩展名不算证据，读头部字节嗅容器）
  const row = await findLibrarySong(musicInfo)
  if (row) {
    const head = await readHeadBytes(row.filePath)
    const container = detectContainer(head ?? new Uint8Array())
    if (container === 'mp3') {
      logReady('库内 MP3')
      return serveLocalMp3(row.filePath, row.quality, seekSec, rangeHeader, isHead, musicInfo.name)
    }
    // ② 库里是 FLAC/wav 之类：音箱听不懂，改走在线取一档 MP3（在线那份本来就带磁盘缓存，
    //    第二次起是直接发盘上的文件，不需要我们再转一份更差的副本）
    logger.info('[speaker/stream] 库内文件不是 MP3，改走在线取 MP3 档', {
      歌曲: `${musicInfo.name}`, 库内: row.quality, 嗅到: container ?? '未知',
    })
  }

  // ③ 在线取 320k/128k：走 audioServe（带缓存与进行中重复请求合并），拿到响应后**按字节给的 MIME 再核一次**
  try {
    const cacheKey = `${musicInfo.source}:${musicInfo.songmid}:${quality}`
    const resolver: UpstreamUrlResolver = async excludeProviders => {
      if (!musicSourceManager.isInitialized()) await musicSourceManager.initialize()
      return musicSourceManager.getMusicUrlWithProvider(musicInfo, quality, {
        excludeProviders,
        // 设备约 5.1s 拿不到字节就挂断重拉，8s 的单源预算对它无效（见 readSpeakerUrlBudgets）
        budgets: readSpeakerUrlBudgets(),
      })
    }
    // 在线这一路的秒→字节只能按音质档名义码率估（文件没落盘时读不到真实码率）；
    // 但缓存过的那份照样能做帧对齐 —— 首次播放就会缓存下来，所以第二次起是准的
    let effectiveRange = rangeHeader
    let seekStart = 0
    if (seekSec > 0) {
      const rough = Math.round(seekSec * nominalBytesPerSec(quality))
      const seek = await alignSeekStart(resolvePaths(cacheKey, 'audio/mpeg').filePath, rough)
      seekStart = seek.start
      logger.info('[speaker/stream] 在线档按 seek 重推', { 秒: seekSec, 粗字节: rough, 起字节: seek.start, 对齐: seek.aligned })
      effectiveRange = `bytes=${seek.start}-`
    }
    // 命中盘上缓存与真要回源，这两条的耗时差一个量级，所以先记下"进来时那份缓存在不在"
    // —— 这是给上面那条计时日志分母用的，不参与任何业务判断
    const cachedBefore = existsSync(resolvePaths(cacheKey, 'audio/mpeg').filePath)
    const res = await audioServe.serve({
      cacheKey,
      upstreamUrlResolver: resolver,
      rangeHeader: effectiveRange,
      isHead,
      intervalSec: parseIntervalToSeconds(musicInfo.interval),
    })
    const served = res.headers.get('content-type') ?? ''
    // 带 seek 的那份先换成 200 尾巴，之后的日志与返回都按**换完的**这条说
    const out = seekSec > 0 ? asFullTail(res, seekStart, isHead) : res
    logReady(out.ok ? (cachedBefore ? '在线档（盘上已有缓存）' : '在线档（回源取）') : `在线档（上游 ${out.status}）`, out.status)
    if (out.ok && !served.includes('audio/mpeg')) {
      // 源把 flac 标成 320k 是发生过的（扩展名撒谎那一类）；给音箱这份必须是 MP3，宁可直接报错
      return fail(415, 'NOT_MP3', `这一档拿回来的不是 MP3（${served || '未知类型'}），音箱放不了`)
    }
    return out
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

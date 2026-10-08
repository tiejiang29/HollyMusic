/**
 * 库内非 MP3 文件 → MP3 的转码出口（G1.5）。
 *
 * 为什么要有它：`/api/speaker/stream` 那道 MP3 闸门遇到库里的 FLAC 会改走在线取 MP3 档，
 * 这条对平台歌曲好使，但对**没有在线源的文件**（本地导入的 `loc-`、平台只剩更高档的）就没退路，
 * 音箱就播不了。转码是唯一的兜底。
 *
 * 三个决定都跟"产物要能复用"有关：
 *
 * 1. **产物落进 `audioServe` 那套缓存**（同一个根目录、同一份 `AudioCache` 表）：
 *    配额、LRU、孤儿扫描都认它，不再造第二套缓存概念。缓存键带 `tc:` 前缀，与在线下载的
 *    `${source}:${songmid}:${quality}` 一眼分得开。
 * 2. **转整曲、不把 `seek` 烘进产物**：seek 由出口那侧按字节偏移处理（见 §4.7.2 的帧对齐）。
 *    烘进产物会让"同一首歌的两个拖动位置"各存一份，复用率直接归零。
 * 3. **不放 ID3/封面**（`-vn` 丢掉封面流，mp3 muxer 默认也不写 ID3v2）：参考实现里那个
 *    `remove_id3tag` 开关防的就是"大封面标签音箱读不了"，而字节偏移起播还要正确跳过标签块。
 *    给音箱那份不需要标签，就不写。
 *
 * 转码是**有损再编码**：FLAC → 320k MP3 会丢信息，不许当无损宣传（面板上就是这么写的）。
 *
 * 并发上限是硬闸：一次 ffmpeg 会吃满一个核，而这条口是"音箱一边等一边拉"的，
 * 不设上限等于让三四个人的拖动把服务器 CPU 打满、所有人的首包一起变慢。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import path from 'path'
import fsp from 'fs/promises'
import { logger } from '@/lib/logger'
import { prisma } from '@/lib/db'
import { resolvePaths, getAudioServeConfig } from '@/lib/audio-serve'

/** 同时在转几首；超了直接 503，不排队（音箱等不了一个队） */
export const MAX_TRANSCODE = 3
/** 单首要转多久——超过就杀掉（NAS 实测 47~51× 实时，3 分钟的歌 4 秒就够，这里是极端保护） */
export const TRANSCODE_TIMEOUT_MS = 180_000

export class TranscodeBusyError extends Error {
  constructor() { super('转码通道已满，稍后再试'); this.name = 'TranscodeBusyError' }
}
export class TranscodeFailedError extends Error {
  constructor(message: string) { super(message); this.name = 'TranscodeFailedError' }
}

/** 缓存键：同一首歌、同一档音质、同一个响度开关 ⇒ 同一份产物 */
export function transcodeCacheKey(uid: string, quality: '320k' | '128k', normalize: boolean): string {
  return `tc:${uid}:${quality}${normalize ? ':loud' : ''}`
}

/** ffmpeg 那串参数：纯函数，单独抽出来是为了能把"参数对不对"钉在测试里 */
export function ffmpegArgs(input: string, output: string, quality: '320k' | '128k', normalize: boolean): string[] {
  const bitrate = quality === '128k' ? '128k' : '320k'
  return [
    // -nostdin：子进程继承了我们的 stdin，不加这个它会去抢标准输入
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', input,
    // 封面流（attached_pic）不要：它是"视频"流，mp3 装不下，也是参考实现剥标签防的那类东西
    '-vn',
    ...(normalize ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : []),
    '-codec:a', 'libmp3lame', '-b:a', bitrate,
    // 明确不写 ID3v2：给音箱那份用不上标签，而字节偏移起播每多一段标签就多想一层
    '-map_metadata', '-1', '-id3v2_version', '0',
    '-f', 'mp3',
    output,
  ]
}

let running = 0
const inflight = new Map<string, Promise<TranscodeResult>>()
/** 探到一次就记住（含"探到没有"），别每个请求都 spawn 一遍 */
const probeCache = new Map<string, string | null>()

export interface TranscodeResult {
  /** 产物绝对路径（可以直接交给 buildFullResponse / 按字节 seek） */
  filePath: string
  size: number
  /** 命中已有缓存（没花 CPU） */
  reused: boolean
}

/**
 * 探一次 ffmpeg 是否可用。返回版本首行（截断）或 null。
 * 按填进来的那个名字分别缓存（含"探到没有"这次结果），改面板上的路径就会重新探一次，
 * 但同一个路径不会每个请求都 spawn 一遍。
 */
export async function probeFfmpeg(bin: string): Promise<string | null> {
  const key = bin.trim()
  if (probeCache.has(key)) return probeCache.get(key)!
  const found = await new Promise<string | null>(resolve => {
    if (!key) return resolve(null)
    let settled = false
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(key, ['-hide_banner', '-version'], { windowsHide: true })
    } catch {
      return resolve(null)
    }
    let out = ''
    const done = (v: string | null) => { if (!settled) { settled = true; try { child.kill() } catch {} resolve(v) } }
    child.stdout.on('data', d => { out += String(d) })
    child.on('error', () => done(null))
    child.on('close', code => done(code === 0 ? out.split(/\r?\n/)[0].slice(0, 80) : null))
    setTimeout(() => done(null), 5000).unref?.()
  })
  probeCache.set(key, found)
  return found
}

/** 只给测试用 */
export function _resetTranscodeProbeForTest(): void {
  probeCache.clear()
  running = 0
  inflight.clear()
}

/**
 * 让面板能"装了再点一下"：探过的结果按名字缓存，管理员刚装完 ffmpeg 后路径没变，
 * 不清掉缓存就只能等进程重启 —— 那句"没探到 ffmpeg"会一直挂在面板上骗人。
 */
export function resetFfmpegProbe(bin?: string): void {
  if (bin === undefined) probeCache.clear()
  else probeCache.delete(bin.trim())
}

/** 已经在转同一首了 ⇒ 跟着等那一次，不重复起进程 */
function joinInflight(key: string, make: () => Promise<TranscodeResult>): Promise<TranscodeResult> {
  const existing = inflight.get(key)
  if (existing) return existing
  const p = make().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/** 查缓存：DB 有行、磁盘也在 ⇒ 直接给 */
async function lookupCached(cacheKey: string): Promise<TranscodeResult | null> {
  const row = await prisma.audioCache.findUnique({ where: { cacheKey } })
  if (!row) return null
  const abs = path.join(getAudioServeConfig().cacheDir, row.filePath)
  try {
    const stat = await fsp.stat(abs)
    if (stat.size <= 0) return null
    await prisma.audioCache.update({ where: { cacheKey }, data: { lastAccessAt: new Date() } }).catch(() => {})
    return { filePath: abs, size: stat.size, reused: true }
  } catch {
    // DB 说在、磁盘没有：这行是脏的，删掉再走转码（留着它下次还是空转）
    await prisma.audioCache.delete({ where: { cacheKey } }).catch(() => {})
    return null
  }
}

/**
 * 容量闸：转码产物总占用超上限时按 `lastAccessAt` 淘汰（先删行再删文件）。
 * 只管 `tc:` 前缀的那些——在线下载的整包归 audioServe 自己的配额逻辑管。
 */
async function enforceCap(capMb: number): Promise<void> {
  const capBytes = Math.max(0, capMb) * 1024 * 1024
  if (capBytes <= 0) return
  const rows = await prisma.audioCache.findMany({
    where: { cacheKey: { startsWith: 'tc:' } },
    orderBy: { lastAccessAt: 'asc' },
    select: { cacheKey: true, filePath: true, size: true },
  })
  let total = rows.reduce((s, r) => s + (r.size || 0), 0)
  if (total <= capBytes) return
  const root = getAudioServeConfig().cacheDir
  for (const r of rows) {
    if (total <= capBytes) break
    await prisma.audioCache.delete({ where: { cacheKey: r.cacheKey } }).catch(() => {})
    await fsp.unlink(path.join(root, r.filePath)).catch(() => {})
    total -= r.size || 0
    logger.info('[transcode] 容量闸淘汰', { 键: r.cacheKey, 字节: r.size })
  }
}

/** 起一次 ffmpeg，转整曲；产物先落 `.part`，成功了才改名（半途而废的不留尸体） */
async function runFfmpeg(
  bin: string, sourceFile: string, destPath: string,
  quality: '320k' | '128k', normalize: boolean, signal?: AbortSignal,
): Promise<number> {
  if (running >= MAX_TRANSCODE) throw new TranscodeBusyError()
  running++
  const partPath = `${destPath}.part`
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(bin, ffmpegArgs(sourceFile, partPath, quality, normalize), { windowsHide: true })
      let errTail = ''
      let settled = false
      const killTimer = setTimeout(() => {
        // 超时/被中断必须**杀掉进程**：僵尸 ffmpeg 是唯一真事故路径（它还在吃 CPU，而我们已经不再等它）
        try { child.kill() } catch {}
        fail(new TranscodeFailedError('转码超时，已终止'))
      }, TRANSCODE_TIMEOUT_MS)
      const fail = (e: Error) => {
        if (settled) return
        settled = true
        clearTimeout(killTimer)
        signal?.removeEventListener('abort', onAbort)
        fsp.unlink(partPath).catch(() => {})
        reject(e)
      }
      const ok = () => {
        if (settled) return
        settled = true
        clearTimeout(killTimer)
        signal?.removeEventListener('abort', onAbort)
        fsp.stat(partPath).then(s => resolve(s.size)).catch(() => fail(new TranscodeFailedError('转码产物不见了')))
      }
      // 音箱挂断（切歌/暂停/超时）时这条转码就没意义了，杀进程比留着跑完更省
      const onAbort = () => { try { child.kill() } catch {} fail(new TranscodeFailedError('请求已断开，转码被取消')) }
      if (signal) {
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      child.stderr.on('data', d => { errTail = (errTail + String(d)).slice(-400) })
      child.on('error', () => fail(new TranscodeFailedError('起不了 ffmpeg（检查面板上的路径装没装）')))
      child.on('close', code => {
        if (code === 0) return ok()
        fail(new TranscodeFailedError(`ffmpeg 退出码 ${code}：${errTail.trim().slice(0, 120) || '没有输出'}`))
      })
    })
  } finally {
    running--
  }
}

export async function transcodeToMp3(input: {
  bin: string
  /** 源：本地文件的绝对路径（FLAC/wav/…都行，ffmpeg 认就行） */
  sourceFile: string
  uid: string
  quality: '320k' | '128k'
  normalize: boolean
  capMb: number
  signal?: AbortSignal
}): Promise<TranscodeResult> {
  const cacheKey = transcodeCacheKey(input.uid, input.quality, input.normalize)
  const hit = await lookupCached(cacheKey)
  if (hit) return hit

  await enforceCap(input.capMb)
  const paths = resolvePaths(cacheKey, 'audio/mpeg')

  return joinInflight(cacheKey, async () => {
    // 排队/并发期间可能已经有人转完了 ⇒ 再看一眼缓存
    const again = await lookupCached(cacheKey)
    if (again) return again
    await fsp.mkdir(paths.shardDir, { recursive: true })
    const size = await runFfmpeg(input.bin, input.sourceFile, paths.filePath, input.quality, input.normalize, input.signal)
    await fsp.rename(`${paths.filePath}.part`, paths.filePath)
    await prisma.audioCache.upsert({
      where: { cacheKey },
      create: { cacheKey, filePath: paths.relativeFilePath, size, contentType: 'audio/mpeg' },
      update: { filePath: paths.relativeFilePath, size, contentType: 'audio/mpeg', lastAccessAt: new Date() },
    })
    logger.info('[transcode] 已转码入库', { 键: cacheKey, 字节: size, 响度: input.normalize })
    return { filePath: paths.filePath, size, reused: false }
  })
}

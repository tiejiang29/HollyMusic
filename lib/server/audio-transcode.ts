/**
 * 库内非 MP3 文件 → MP3 的转码出口（G1.5）。
 *
 * 为什么要有它：`/api/speaker/stream` 那道 MP3 闸门遇到库里的 FLAC 会改走在线取 MP3 档，
 * 这条对平台歌曲好使，但对**没有在线源的文件**（本地导入的 `loc-`、平台只剩更高档的）就没退路，
 * 音箱就播不了。转码是唯一的兜底。
 *
 * 四个决定都跟"产物要能复用"有关：
 *
 * 1. **产物落进 `audioServe` 那套缓存**（同一个根目录、同一份 `AudioCache` 表）：
 *    配额、LRU、孤儿扫描都认它，不再造第二套缓存概念。缓存键带 `tc:` 前缀，与在线下载的
 *    `${source}:${songmid}:${quality}` 一眼分得开。
 * 2. **转整曲、不把 `seek` 烘进产物**：seek 由出口那侧按字节偏移处理（见 §4.7.2 的帧对齐）。
 *    烘进产物会让"同一首歌的两个拖动位置"各存一份，复用率直接归零。
 * 3. **不放 ID3/封面**（`-vn` 丢掉封面流，mp3 muxer 默认也不写 ID3v2）：参考实现里那个
 *    `remove_id3tag` 开关防的就是"大封面标签音箱读不了"，而字节偏移起播还要正确跳过标签块。
 *    给音箱那份不需要标签，就不写。
 * 4. **不在设备面前阻塞，也不因为它挂断就杀进程**。这条是被真机教的（2026-10-08）：
 *    设备**约 5.1 秒**没拿到字节就断开、隔 0.1 秒重拉同一地址。我们"转完才发"的那版
 *    把挂断当成取消去 kill ffmpeg ⇒ 每次都在差一点点时白干，日志里连排七条
 *    `转码没成，退回原路径: 请求已断开`，那首歌永远转不出来。现在的形状是：
 *    命中就直接发产物（实测 20ms）；没命中就**后台起一单**、这次立刻走原来的在线取档；
 *    两头都不行才回 503 + Retry-After，让设备几秒后回来捡现成的。
 *
 * 转码是**有损再编码**：FLAC → 320k MP3 会丢信息，不许当无损宣传（面板上就是这么写的）。
 *
 * 并发上限是硬闸：一次 ffmpeg 会吃满一个核，不设上限等于让三四个人的拖动把服务器 CPU 打满。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import path from 'path'
import fsp from 'fs/promises'
import { logger } from '@/lib/logger'
import { prisma } from '@/lib/db'
import { resolvePaths, getAudioServeConfig } from '@/lib/audio-serve'

/** 同时在转几首；超了这一单不起（让设备先走在线，或稍后重拉） */
export const MAX_TRANSCODE = 3
/** 单首要转多久——超过就杀掉（NAS 实测 47~51× 实时，3 分钟的歌 4 秒就够，这里是极端保护） */
export const TRANSCODE_TIMEOUT_MS = 180_000

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
/** 进行中的后台单：同一首并发只起一个进程 */
const jobs = new Map<string, Promise<void>>()
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
 * `ready` = 产物已经在了，直接发；
 * `started` = 刚起了后台一单（这次别等它，走你原来那条路），稍后再问就变 ready；
 * `busy` = 同时在转的满了，这一单没起。
 */
export type TranscodeState =
  | { state: 'ready'; filePath: string; size: number }
  | { state: 'started' }
  | { state: 'busy' }

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
  jobs.clear()
}

/** 等后台那几单都落地（探针和测试用；业务路径不许等） */
export async function waitForTranscodeJobs(): Promise<void> {
  while (jobs.size > 0) await Promise.allSettled([...jobs.values()])
}

/**
 * 让面板能"装了再点一下"：探过的结果按名字缓存，管理员刚装完 ffmpeg 后路径没变，
 * 不清掉缓存就只能等进程重启 —— 那句"没探到 ffmpeg"会一直挂在面板上骗人。
 */
export function resetFfmpegProbe(bin?: string): void {
  if (bin === undefined) probeCache.clear()
  else probeCache.delete(bin.trim())
}

/** 只看现成的产物、不起新单（调用方"先问一次再决定这次走哪条路"时用） */
export async function findMp3Transcode(
  uid: string, quality: '320k' | '128k', normalize: boolean,
): Promise<{ filePath: string; size: number } | null> {
  const hit = await lookupCached(transcodeCacheKey(uid, quality, normalize))
  return hit ? { filePath: hit.filePath, size: hit.size } : null
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

/**
 * 起一次 ffmpeg。**只有超时这一种情况杀进程**——客户端挂断不杀（见文件头第 4 条：
 * 设备 5.1 秒就不等了，杀掉等于每次都白干、那首歌永远转不出来）。
 * 产物先落 `.part`，成功了才改名，半途而废的不留尸体。
 */
function runFfmpeg(
  bin: string, sourceFile: string, destPath: string,
  quality: '320k' | '128k', normalize: boolean,
): Promise<number> {
  const partPath = `${destPath}.part`
  return new Promise<number>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(bin, ffmpegArgs(sourceFile, partPath, quality, normalize), { windowsHide: true })
    } catch {
      return reject(new TranscodeFailedError('起不了 ffmpeg（检查面板上的路径装没装）'))
    }
    let errTail = ''
    let settled = false
    const fail = (e: Error) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      fsp.unlink(partPath).catch(() => {})
      reject(e)
    }
    const ok = () => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      fsp.stat(partPath).then(r => resolve(r.size)).catch(() => reject(new TranscodeFailedError('转码产物不见了')))
    }
    const killTimer = setTimeout(() => {
      try { child.kill() } catch {}
      fail(new TranscodeFailedError('转码超时，已终止'))
    }, TRANSCODE_TIMEOUT_MS)
    child.stderr.on('data', d => { errTail = (errTail + String(d)).slice(-400) })
    child.on('error', () => fail(new TranscodeFailedError('起不了 ffmpeg（检查面板上的路径装没装）')))
    child.on('close', code => {
      if (code === 0) return ok()
      fail(new TranscodeFailedError(`ffmpeg 退出码 ${code}：${errTail.trim().slice(0, 120) || '没有输出'}`))
    })
  })
}

/**
 * 要一份这首歌的 MP3：**有就给，没有就起一单后台的并说"起了"**。
 * 这条函数永远不等 ffmpeg —— 设备只等得起 5 秒左右，而产物是给下一次用的。
 */
export async function requestMp3Transcode(input: {
  bin: string
  /** 源：本地文件的绝对路径（FLAC/wav/…都行，ffmpeg 认就行） */
  sourceFile: string
  uid: string
  quality: '320k' | '128k'
  normalize: boolean
  capMb: number
}): Promise<TranscodeState> {
  const cacheKey = transcodeCacheKey(input.uid, input.quality, input.normalize)
  const hit = await lookupCached(cacheKey)
  if (hit) return { state: 'ready', filePath: hit.filePath, size: hit.size }
  // 判满与占名额之间不许有 await：早先名额是在 job 内部才 ++ 的，而那之前还有两个 await，
  // 十个并发请求会全部通过判据 ⇒ 真起十个 ffmpeg 把机器吃干
  if (jobs.has(cacheKey)) return { state: 'started' }
  if (running >= MAX_TRANSCODE) return { state: 'busy' }
  running++
  {
    const paths = resolvePaths(cacheKey, 'audio/mpeg')
    const job = (async () => {
      await enforceCap(input.capMb)
      await fsp.mkdir(paths.shardDir, { recursive: true })
      const size = await runFfmpeg(input.bin, input.sourceFile, paths.filePath, input.quality, input.normalize)
      await fsp.rename(`${paths.filePath}.part`, paths.filePath)
      await prisma.audioCache.upsert({
        where: { cacheKey },
        create: { cacheKey, filePath: paths.relativeFilePath, size, contentType: 'audio/mpeg' },
        update: { filePath: paths.relativeFilePath, size, contentType: 'audio/mpeg', lastAccessAt: new Date() },
      })
      logger.info('[transcode] 已转码入库', { 键: cacheKey, 字节: size, 响度: input.normalize })
    })().catch(err => {
      // 失败只记账：这一单没成，下次有人要同一首会重新起一单（不会留个永久坏产物）
      logger.warn('[transcode] 后台转码失败:', (err instanceof Error ? err.message : String(err)).slice(0, 160))
    }).finally(() => { jobs.delete(cacheKey); running-- })
    jobs.set(cacheKey, job)
  }
  return { state: 'started' }
}

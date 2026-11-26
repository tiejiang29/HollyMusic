/**
 * 音频完整性校验（试听片段判定）。
 *
 * 背景：部分音源对无版权/非 VIP 歌曲返回试听片段（如 30s/60s），这些片段
 * 能正常播放，一旦落库会长期占用缓存且换源后无法自愈（缓存 key 不含
 * 音源脚本标识，命中后 0 次上游调用）。
 *
 * 策略：解析音频文件真实时长（music-metadata），与歌曲元数据 interval
 * （期望时长）对比；相差太远判定为试听——仅影响「是否落库」，不中断
 * 交付，用户可正常试听；后台换可用源后重新拉取到完整版才入库。
 */

import { parseFile } from 'music-metadata'
import { logger } from '@/lib/logger'

/** 期望时长低于该值（秒）不校验：短曲与元数据缺失场景直接放行 */
export const MIN_CHECK_INTERVAL_SEC = 120

/** 实际时长低于期望的该比例视为可疑 */
export const TRIAL_DURATION_RATIO = 0.8

/** 时长绝对差低于该值（秒）不判定：容忍平台元数据误差 */
export const TRIAL_ABS_DIFF_SEC = 30

export interface TrialCheckResult {
  /** true 表示判定为试听片段（应跳过落库 / 删除缓存） */
  trial: boolean
  /** 解析出的实际时长（秒）；null 表示未解析或未校验 */
  actualSec: number | null
}

/** 实际时长 vs 期望时长，是否明显不完整（试听片段） */
export function isIncompleteTrial(actualDurationSec: number, intervalSec: number): boolean {
  if (!Number.isFinite(intervalSec) || intervalSec < MIN_CHECK_INTERVAL_SEC) return false
  if (!Number.isFinite(actualDurationSec) || actualDurationSec <= 0) return false
  return (
    actualDurationSec < intervalSec * TRIAL_DURATION_RATIO &&
    intervalSec - actualDurationSec > TRIAL_ABS_DIFF_SEC
  )
}

/** 解析本地音频文件的真实时长（秒）；解析失败返回 null（宁放过不误杀） */
export async function parseDurationFromFile(filePath: string): Promise<number | null> {
  try {
    const meta = await parseFile(filePath)
    const duration = meta.format.duration
    if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
      return duration
    }
    return null
  } catch (e) {
    logger.debug(
      `[AudioIntegrity] 时长解析失败 ${filePath}:`,
      e instanceof Error ? e.message : e
    )
    return null
  }
}

/**
 * 校验音频文件是否为试听片段。
 * intervalSec 无效或过短（<120s）→ 不校验，返回 trial=false。
 */
export async function checkTrialAudio(
  filePath: string,
  intervalSec: number
): Promise<TrialCheckResult> {
  if (!Number.isFinite(intervalSec) || intervalSec < MIN_CHECK_INTERVAL_SEC) {
    return { trial: false, actualSec: null }
  }
  const actualSec = await parseDurationFromFile(filePath)
  if (actualSec === null) return { trial: false, actualSec: null }
  return { trial: isIncompleteTrial(actualSec, intervalSec), actualSec }
}

// --------------------------------------------------------------------------
// Content-Length 早判（2026-11-23 新增）
// --------------------------------------------------------------------------

/**
 * 上面那套要等整段下载完才认得出试听，而认出来只跳过落库、照样交付——用户先听
 * 60 秒再没声，也不会触发换源/换平台。生产实测 `api.vkeys.cn` 对 QQ 的 flac 请求
 * 有 84% 回的就是这种片段（7 首中招、声明 29~46MB、实际约 0.9MB）。
 *
 * 这里改成**拿到 Content-Length 就判**：坏载荷连第一个字节都不下，直接按假地址
 * 排除该源重试，同平台用尽后 `getMusicUrlWithProvider` 现有的跨平台换源自动接手。
 */

/**
 * 声明大小字符串（"4.03M"/"1.2G"/"512K"）→ 字节。
 * 平台按 MiB 计：生产实测声明 `31.48M` 的实际文件是 33010086B = 31.48MiB。
 * 认不出返回 null（不参与判定，宁放过不误杀）。
 */
export function parseDeclaredSizeBytes(size: string | null | undefined): number | null {
  if (!size) return null
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMG]?)\s*$/i.exec(size)
  if (!m) return null
  const num = Number(m[1])
  if (!Number.isFinite(num) || num <= 0) return null
  const unit = m[2].toUpperCase()
  const mult = unit === 'G' ? 1024 ** 3 : unit === 'M' ? 1024 ** 2 : unit === 'K' ? 1024 : 1
  const bytes = num * mult
  return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : null
}

/** 这首歌各声明档位里的最小字节数；一个都认不出 → null（表示没有声明可比） */
export function minDeclaredBytes(
  sizes: (string | null | undefined)[] | null | undefined
): number | null {
  if (!Array.isArray(sizes)) return null
  const parsed = sizes.map(parseDeclaredSizeBytes).filter((n): n is number => n !== null)
  return parsed.length > 0 ? Math.min(...parsed) : null
}

/**
 * 【兜底判据】Content-Length 对最小声明档的比例下限。
 *
 * 只有**首块解不出真实时长**时才用它（m4a 的时长写在文件尾的 moov、或首块没覆盖到
 * 帧头）。主判据见下面 `estimateDurationFromHead`——字节比值随时长漂移，不该当主判据。
 *
 * 为什么是 0.5 而不是 0.35（0.35 已被生产只读干跑证伪）：
 * 128k 整曲字节 ≈ 时长 × 16000B/s ⇒ **比值 ≈ 片段秒数 ÷ 整曲秒数**，歌越短分母越小、
 * 比值越高。vkeys 那段罐头字节恒 960887B（= 128kbps 的 60.06 秒），于是
 * 154s→0.390、159s→0.377、166s→0.362 全都越过 0.35 被放行（7 首里漏 4 首）。
 * 合法交付的最近锚点是 0.628（《小孩儿》整曲 m4a 2559929B ÷ 声明 3.89M），
 * 所以可行窗口是 (0.390, 0.628)，取 0.5 居中。其余好锚点：0.743、0.761、真无损 1.00。
 */
export const TRIAL_SIZE_RATIO = 0.5

/**
 * Content-Length 是否短到不可能是完整曲子（兜底用；主判据是首块解时长）。
 * 无声明（minBytes=null）、时长过短不校验（同 120s 口径）、CL 无效 → 一律放过。
 */
export function isUndersizedByContentLength(
  sizeBytes: number,
  minBytes: number | null,
  intervalSec: number
): boolean {
  if (minBytes === null) return false
  if (!Number.isFinite(intervalSec) || intervalSec < MIN_CHECK_INTERVAL_SEC) return false
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return false
  return sizeBytes < minBytes * TRIAL_SIZE_RATIO
}

// --------------------------------------------------------------------------
// 首块解真实时长（主判据）
// --------------------------------------------------------------------------

/** ID3v2 标签总长（含头本身）；不是 ID3v2 返回 0。synchsafe 大小字段。 */
function id3v2Length(b: Uint8Array): number {
  if (b.length < 10) return 0
  if (!(b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33)) return 0
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f)
  return 10 + size
}

/**
 * FLAC STREAMINFO 里的总样本数 ÷ 采样率 ⇒ 精确时长（无需下载正文）。
 * 实测生产库三个真文件：解出 240.13 / 269.75 / 274.07 秒，库内记账 240.0 / 269.0 / 274.0。
 */
function flacDurationSec(b: Uint8Array): number | null {
  const o0 = id3v2Length(b)
  if (b.length < o0 + 42) return null
  if (String.fromCharCode(b[o0], b[o0 + 1], b[o0 + 2], b[o0 + 3]) !== 'fLaC') return null
  if ((b[o0 + 4] & 0x7f) !== 0) return null // 第一个块必须是 STREAMINFO
  const o = o0 + 8
  const sr = ((b[o + 10] << 16) | (b[o + 11] << 8) | b[o + 12]) >>> 4
  const lo = ((b[o + 14] * 16777216) + ((b[o + 15] << 16) | (b[o + 16] << 8) | b[o + 17])) >>> 0
  const total = ((b[o + 13] & 0x0f) * 4294967296) + lo
  if (!Number.isFinite(sr) || sr <= 0 || !Number.isFinite(total) || total <= 0) return null
  return total / sr
}

/** MPEG-1/2/2.5 Layer-III 的每帧字节速率表（kbps）；索引 0 与 15 无效 */
const MPEG_L3_KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const MPEG_L3_KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]

/**
 * 从首块里找一个 MPEG Layer-III 帧头，返回该码率的字节/秒（即 CBR 假设下的速率）。
 * 解不出返回 null。
 *
 * 用 CBR 假设的依据是生产普查，不是猜测：库里 128k 那 40 行平均 **15568 B/s**
 * （CBR 128k 应为 16000 B/s，差 −2.7%）、320k 那 58 行平均 43294 B/s（≥ 40000，
 * 只会高估时长、方向安全）。vkeys 那段罐头 960887B ÷ 生产实测 60 秒 = 16015 B/s,
 * 正落在 128k CBR 那一档上。
 */
function mpegBytesPerSecond(b: Uint8Array): number | null {
  const from = id3v2Length(b)
  const end = Math.min(b.length - 4, from + 65536)
  for (let i = from; i < end; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue
    const version = (b[i + 1] >> 3) & 0x03
    const layer = (b[i + 1] >> 1) & 0x03
    if (version === 0x01 || layer !== 0x01) continue // 保留版本 / 非 Layer III
    const brIdx = (b[i + 2] >> 4) & 0x0f
    const srIdx = (b[i + 2] >> 2) & 0x03
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) continue
    const kbps = (version === 0x03 ? MPEG_L3_KBPS_V1 : MPEG_L3_KBPS_V2)[brIdx]
    if (!kbps) continue
    return kbps * 125 // kbps × 1000 / 8
  }
  return null
}

const ADTS_SAMPLE_RATES = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350]

/** ADTS AAC 没有总时长字段，用连续帧长的均值折算整文件帧数。 */
function adtsDurationSec(head: Uint8Array, sizeBytes: number): number | null {
  const start = id3v2Length(head)
  if (start + 14 > head.length || sizeBytes <= start) return null
  let offset = start
  let frames = 0
  let frameBytes = 0
  let samples = 0
  let sampleRate: number | null = null
  while (offset + 7 <= head.length && frames < 512) {
    if (head[offset] !== 0xff || (head[offset + 1] & 0xf6) !== 0xf0) break
    const headerLength = (head[offset + 1] & 1) === 1 ? 7 : 9
    if (offset + headerLength > head.length) break
    const rateIndex = (head[offset + 2] >> 2) & 0x0f
    const frameLength = ((head[offset + 3] & 0x03) << 11) | (head[offset + 4] << 3) | (head[offset + 5] >> 5)
    const rawBlocks = head[offset + 6] & 0x03
    if (rateIndex >= ADTS_SAMPLE_RATES.length || frameLength < headerLength || offset + frameLength > sizeBytes) break
    const rate = ADTS_SAMPLE_RATES[rateIndex]
    if (sampleRate === null) sampleRate = rate
    else if (sampleRate !== rate) break
    frames++
    frameBytes += frameLength
    samples += 1024 * (rawBlocks + 1)
    offset += frameLength
  }
  if (frames < 3 || sampleRate === null || frameBytes <= 0) return null
  const audioBytes = Math.max(1, sizeBytes - start)
  return (audioBytes * samples) / (frameBytes * sampleRate)
}

/** 首块解时长的依据；null 表示这条容器路径解不出（交回兜底判据） */
export type HeadDurationBasis = 'flac' | 'cbr-mp3' | 'adts-aac' | null

/**
 * 只看首块就把时长估出来。
 *
 * **必须按已嗅出的容器来走**：mp4 这类容器的字节里偶然撞出 `FF FB…` 的概率不低
 * （64KB 内按 1/256 × 14/256 估算约有 9 处），盲扫帧头会给出一看就信的假码率。
 * 所以只接受嗅探已经判成 flac / mp3 / mpeg-frame 的载荷。
 */
export function estimateDurationFromHead(
  head: Uint8Array | null | undefined,
  sizeBytes: number,
  container: string | null | undefined
): { sec: number | null; basis: HeadDurationBasis } {
  if (!head || head.length < 12 || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { sec: null, basis: null }
  }
  if (container === 'flac') {
    const sec = flacDurationSec(head)
    if (sec !== null) return { sec, basis: 'flac' }
  }
  if (container === 'mp3' || container === 'mpeg-frame') {
    const adtsOffset = id3v2Length(head)
    if (head[adtsOffset] === 0xff && (head[adtsOffset + 1] & 0xf6) === 0xf0) {
      const adtsSec = adtsDurationSec(head, sizeBytes)
      return { sec: adtsSec, basis: adtsSec === null ? null : 'adts-aac' }
    }
    const bps = mpegBytesPerSecond(head)
    if (bps !== null) {
      // ID3v2 那段不是音频，扣掉再折算，否则长标签会把时长抬高
      const audioBytes = Math.max(1, sizeBytes - id3v2Length(head))
      return { sec: audioBytes / bps, basis: 'cbr-mp3' }
    }
  }
  return { sec: null, basis: null }
}

/**
 * 交付长度判据的统一入口。两条判据取**或**，因为它们各有各的盲点：
 *
 * - **时长判据**（能解出时长时用，复用已有的 0.8×/30 秒口径）：mp3 走 CL÷码率，对
 *   截断敏感；flac 走文件自带的总样本数，能识破"给了一首 60 秒的别的曲子"，但
 *   **对截断不敏感**（头里永远写着整曲时长）。
 * - **字节比值兜底**（对最小声明档）：不依赖容器内部结构，所以能补上 flac 截断、
 *   m4a 这类时长解不出的场景。
 *
 * 实测两条互不误伤：12 条合法交付里时长全部对得上、比值最低 0.628（阈值 0.5）；
 * 5 条罐头时长折算 60.1 秒、比值最高 0.390 ⇒ 两条都会判死。
 */
export function judgePayloadLength(opts: {
  head: Uint8Array | null | undefined
  sizeBytes: number
  minDeclaredBytes: number | null
  intervalSec: number
  container?: string | null
}): { reject: boolean; basis: string; detail: string } {
  const { head, sizeBytes, minDeclaredBytes, intervalSec, container } = opts
  const est = estimateDurationFromHead(head, sizeBytes, container)
  const durReject = est.sec !== null && isIncompleteTrial(est.sec, intervalSec)
  const sizeReject = isUndersizedByContentLength(sizeBytes, minDeclaredBytes, intervalSec)
  const ratio =
    minDeclaredBytes !== null && Number.isFinite(sizeBytes) && sizeBytes > 0
      ? (sizeBytes / minDeclaredBytes).toFixed(3)
      : '无声明'
  const detail =
    `时长=${est.sec === null ? '解不出' : est.sec.toFixed(1) + 's'} 期望=${intervalSec}s ` +
    `容器=${container ?? '?'} 字节=${sizeBytes} 对最小声明档比值=${ratio}`
  if (durReject && sizeReject) return { reject: true, basis: `${est.basis}+size-ratio`, detail }
  if (durReject) return { reject: true, basis: String(est.basis), detail }
  if (sizeReject) return { reject: true, basis: 'size-ratio', detail }
  return { reject: false, basis: String(est.basis ?? 'size-ratio'), detail }
}

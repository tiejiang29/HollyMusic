/**
 * 给小爱音箱"改播放位置"用的 MP3 字节偏移。
 *
 * 为什么需要它：小米侧没有设备端 seek 指令（2026-10-08 真机实测：重推一条流会让它**从 0 起播**），
 * 所以拖动进度条只能重推一条"从中间开始"的地址。而我们这一路只出 MP3、且实测全 CBR
 * （库内 MP3 全 CBR，在线取的也只有 320k/128k 两档），于是"秒 → 字节"就是
 * `音频起点 + 秒 × 每秒字节数`。
 *
 * 两个必须处理的细节：
 * - **音频起点要跳过 ID3v2**：不跳就把标签字节当音频切进流里，头几秒会变噪音；
 * - **每秒字节数优先信第一帧头里的码率**：音质档只是标签，标签撒谎（320k 实际是别的码率）时
 *   按名义值算会越拖越偏。帧头读不到才退回名义值。
 */

/** 音质档的名义每秒字节数（320kbps = 40000 B/s） */
export const NOMINAL_BYTES_PER_SEC: Record<'320k' | '128k', number> = { '320k': 40000, '128k': 16000 }

/**
 * 找第一帧时往后扫多少字节。取 100KB 是为了跨过带大封面的 ID3v2（我们入库的 MP3 标签实测接近 0KB，
 * 但别人下的歌可能有几 MB 的图）；调用方按同一个上限去读头部字节。
 */
export const MP3_HEAD_BYTES = 100 * 1024

export interface Mp3SeekPlan {
  /** 从文件的第几个字节开始发 */
  offset: number
  bytesPerSec: number
  /** 码率是从帧头读到的，还是退回音质档名义值 */
  from: 'frame' | 'nominal'
}

/** MPEG1 Layer III 各码率索引对应的 kbps（0=免费/未定义，15=坏值） */
const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
/** MPEG2 / MPEG2.5 Layer III */
const BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
/** 采样率表按版本各一套（索引取自帧头的采样率位） */
const SAMPLE_V1 = [44100, 48000, 32000]
const SAMPLE_V2 = [22050, 24000, 16000]
const SAMPLE_V25 = [11050, 12000, 8000]

/**
 * ID3v2 头部占的字节数：`ID3` + 版本 + 标志 + **4 字节 synchsafe 大小**（每字节只用低 7 位）。
 * 认不出来（不是 ID3 开头、或头部读不全）返回 0，表示音频从文件头开始。
 */
export function id3v2Size(head: Uint8Array): number {
  if (head.length < 10) return 0
  if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0
  const size = (((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f)) >>> 0
  // 扩展头（flag bit6）与页同步（flag bit4）都算在 size 里，不用另加
  return 10 + size
}

/**
 * 从 `from` 往后找第一个 MPEG Layer III 帧头，读出码率（每秒字节数）。
 * `from` 给的是"音频大概从哪开始"（通常是 ID3v2 之后），但也允许它就是 0；
 * 标签尾部常补 0，所以要能跨过这段垃圾找到真帧——扫描窗口跟 readHeadBytes 的读取上限一致。
 */
export function firstFrameBytesPerSec(head: Uint8Array, from: number): number | null {
  // 帧头要 4 个字节才读得全，所以最后一个可起手的位置是 length-4（含）
  const last = Math.min(head.length - 4, from + MP3_HEAD_BYTES)
  for (let i = Math.max(0, from); i <= last; i++) {
    if (head[i] !== 0xff) continue
    const b1 = head[i + 1]
    if ((b1 & 0xe0) !== 0xe0) continue
    const version = (b1 >> 3) & 0x03     // 3=MPEG1，2=MPEG2，0=MPEG2.5
    const layer = (b1 >> 1) & 0x03       // 1=Layer III
    if (layer !== 1) continue
    const bitrateIndex = (head[i + 2] >> 4) & 0x0f
    if (bitrateIndex === 0 || bitrateIndex === 15) continue
    const kbps = (version === 3 ? BITRATE_V1_L3 : BITRATE_V2_L3)[bitrateIndex]
    if (kbps <= 0) continue
    return (kbps * 1000) / 8
  }
  return null
}

/** 一帧的字节数（MPEG1 Layer III 用 144 倍率，MPEG2/2.5 用 72）；不是有效帧返回 null */
export function frameLengthAt(head: Uint8Array, i: number): number | null {
  if (i + 4 > head.length) return null
  if (head[i] !== 0xff || (head[i + 1] & 0xe0) !== 0xe0) return null
  const version = (head[i + 1] >> 3) & 0x03
  const layer = (head[i + 1] >> 1) & 0x03
  if (layer !== 1) return null
  const bitrateIndex = (head[i + 2] >> 4) & 0x0f
  const sampleIndex = (head[i + 2] >> 2) & 0x03
  const padding = (head[i + 2] >> 1) & 0x01
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null
  if (version === 1) return null                 // 保留位
  const kbps = (version === 3 ? BITRATE_V1_L3 : BITRATE_V2_L3)[bitrateIndex]
  // 采样率三档不是对半分：MPEG1 是 44.1/48/32k，MPEG2 与 MPEG2.5 各有一套
  const table = version === 3 ? SAMPLE_V1 : version === 2 ? SAMPLE_V2 : SAMPLE_V25
  const samplerate = table[sampleIndex]
  if (kbps <= 0 || !samplerate) return null
  const perFrame = version === 3 ? 144 : 72
  return Math.floor((perFrame * kbps * 1000) / samplerate) + padding
}

/**
 * 把"秒 × 码率"算出来的粗偏移**往前对齐到真正的帧首**。
 *
 * 不做这件事是真会哑的：320k/44.1kHz 每帧 1044~1045 字节，`秒 × 40000` 几乎必然落在帧中间，
 * 设备的解码器起手找不到同步字就会反复重连然后放弃（2026-10-08 实测：重推后 330ms 内
 * 同一地址被拉了 5 次，设备回报 status=2 position=0，一声不出）。
 * 判据用"这一帧之后恰好一整帧处又是一帧"，单靠 0xFF 同步字会被数据段里的假同步骗到。
 */
export function alignToFrameStart(head: Uint8Array, roughWithinHead: number): number | null {
  const limit = Math.min(head.length - 4, roughWithinHead + 8192)
  for (let i = Math.max(0, roughWithinHead); i <= limit; i++) {
    const len = frameLengthAt(head, i)
    if (len === null) continue
    if (frameLengthAt(head, i + len) !== null) return i
  }
  return null
}

/** 算出"这一秒该从第几个字节开始发" */
export function planMp3Seek(head: Uint8Array, sec: number, nominalBytesPerSec: number): Mp3SeekPlan {
  const start = id3v2Size(head)
  const fromFrame = firstFrameBytesPerSec(head, start)
  const bytesPerSec = fromFrame ?? nominalBytesPerSec
  const safeSec = Math.max(0, Number.isFinite(sec) ? sec : 0)
  return { offset: start + Math.round(safeSec * bytesPerSec), bytesPerSec, from: fromFrame ? 'frame' : 'nominal' }
}

/**
 * 上游载荷真伪判定（假地址 / HTML 错误页 / 防盗链响应）。
 *
 * 背景：音源瀑布只认「脚本返回了非空地址」为成功，不做可播校验（见
 * lib/music-source-manager.ts 的成功分支）；而部分音源对无版权/VIP 歌曲会返回
 * HTML 错误页、JSON 提示或高熵垃圾数据（且是 HTTP 200）。这类地址会被当成成功
 * 结果返回并遮蔽后面真正可用的音源，垃圾字节还会被缓存、甚至被「边听边下」
 * 提升进永久音乐库（音乐库优先于在线源且无自愈路径，见 lib/services/music-library.ts）。
 *
 * 判定分三档（纯函数 + 一个小文件读取器；audio-serve 下载首块与 music-library
 * 入库门槛共用同一套判据）：
 * - `audio`      : 字节匹配已知媒体容器 → 正常交付 / 允许入库
 * - `reject`     : 字节或 Content-Type 证明不是音频（文本/HTML/JSON/图片/压缩包）
 *                  → 由调用方换源重试（audio-serve）或拒绝（入库门槛）
 * - `unverified` : 既不能证实也不能证伪（未知容器 + 非文本 Content-Type）
 *                  → 正常交付（可能是罕见容器），但不进永久库，留在缓存里仍可播放
 *
 * 判据以「字节魔数」为主、「Content-Type」为辅：音源的 Content-Type 经常不可信
 * （如把 MP3 标成 `audio/mpeg; charset=UTF-8`），反过来也有把 MV/MP4 当音频链路
 * 返回的情况（见 music-library 的扩展名处理），故 Content-Type 只作兜底线索。
 */

import fsp from 'fs/promises'

export type PayloadVerdict = 'audio' | 'reject' | 'unverified'

export interface PayloadJudgment {
  verdict: PayloadVerdict
  /** 人类可读的判定依据（写日志用） */
  reason: string
  /** 识别出的容器名；未识别为 null */
  container: string | null
  /** 归一化后的 Content-Type 主类型（去掉参数、转小写）；未提供为 null */
  contentType: string | null
}

/** 判定所需的最大头部字节数（超出部分不参与判定） */
export const SNIFF_HEAD_BYTES = 64

function startsWithAscii(head: Uint8Array, offset: number, ascii: string): boolean {
  if (head.length < offset + ascii.length) return false
  for (let i = 0; i < ascii.length; i++) {
    if (head[offset + i] !== ascii.charCodeAt(i)) return false
  }
  return true
}

/** MPEG 音频帧同步字（11 位全 1 + 版本位非保留值）；MP3 与 ADTS AAC 共用 */
function isMpegFrameSync(head: Uint8Array): boolean {
  if (head.length < 2) return false
  if (head[0] !== 0xff || (head[1] & 0xe0) !== 0xe0) return false
  // 括号必须保留：`&` 的优先级低于 `!==`，省略会变成 (head[1]>>3) & (0x03!==0x01)
  return ((head[1] >> 3) & 0x03) !== 0x01
}

/** 已知媒体容器魔数表（命中即认定可交付） */
const CONTAINER_TESTS: Array<{ name: string; test: (h: Uint8Array) => boolean }> = [
  { name: 'mp3', test: h => startsWithAscii(h, 0, 'ID3') },
  { name: 'flac', test: h => startsWithAscii(h, 0, 'fLaC') },
  { name: 'ogg', test: h => startsWithAscii(h, 0, 'OggS') },
  { name: 'wav', test: h => startsWithAscii(h, 0, 'RIFF') && startsWithAscii(h, 8, 'WAVE') },
  { name: 'avi', test: h => startsWithAscii(h, 0, 'RIFF') && startsWithAscii(h, 8, 'AVI ') },
  { name: 'mp4', test: h => startsWithAscii(h, 4, 'ftyp') },
  {
    name: 'aiff',
    test: h =>
      startsWithAscii(h, 0, 'FORM') &&
      (startsWithAscii(h, 8, 'AIFF') || startsWithAscii(h, 8, 'AIFC')),
  },
  { name: 'ape', test: h => startsWithAscii(h, 0, 'MAC ') },
  { name: 'wavpack', test: h => startsWithAscii(h, 0, 'wvpk') },
  { name: 'tta', test: h => startsWithAscii(h, 0, 'TTA1') },
  { name: 'amr', test: h => startsWithAscii(h, 0, '#!AMR') },
  { name: 'dsf', test: h => startsWithAscii(h, 0, 'DSD ') },
  {
    name: 'asf',
    test: h => h.length >= 4 && h[0] === 0x30 && h[1] === 0x26 && h[2] === 0xb2 && h[3] === 0x75,
  },
  { name: 'realmedia', test: h => startsWithAscii(h, 0, '.RMF') },
  { name: 'au', test: h => startsWithAscii(h, 0, '.snd') },
  { name: 'caf', test: h => startsWithAscii(h, 0, 'caff') },
  { name: 'midi', test: h => startsWithAscii(h, 0, 'MThd') },
  { name: 'ac3', test: h => h.length >= 2 && h[0] === 0x0b && h[1] === 0x77 },
  {
    name: 'dts',
    test: h => h.length >= 4 && h[0] === 0x7f && h[1] === 0xfe && h[2] === 0x80 && h[3] === 0x01,
  },
  { name: 'mpeg-frame', test: isMpegFrameSync },
]

/**
 * 嗅探出的容器 → 权威 MIME 与扩展名。
 *
 * 存在的理由：音源的上游 Content-Type 会撒谎（全库实测有 115/228 个 `.mp3` 命名的
 * 文件真实容器是 FLAC），而下游三处都按 contentType 定名定头——缓存文件名、
 * AudioCache.contentType、响应头与库文件名。既然魔数已经认出了容器，就以字节为准。
 *
 * mp4 / asf / avi / realmedia 可能装视频（源偶尔把 MV 当音频链路返回），
 * midi 不是录制音频——这些一律不覆盖上游声明，交回原逻辑处理。
 */
const CONTAINER_TYPES: Record<string, { mime: string; ext: string }> = {
  mp3: { mime: 'audio/mpeg', ext: '.mp3' },
  'mpeg-frame': { mime: 'audio/mpeg', ext: '.mp3' },
  flac: { mime: 'audio/flac', ext: '.flac' },
  ogg: { mime: 'audio/ogg', ext: '.ogg' },
  wav: { mime: 'audio/wav', ext: '.wav' },
  aiff: { mime: 'audio/aiff', ext: '.aiff' },
  ape: { mime: 'audio/ape', ext: '.ape' },
  wavpack: { mime: 'audio/wavpack', ext: '.wv' },
  tta: { mime: 'audio/x-tta', ext: '.tta' },
  dsf: { mime: 'audio/x-dsf', ext: '.dsf' },
  amr: { mime: 'audio/amr', ext: '.amr' },
  au: { mime: 'audio/basic', ext: '.au' },
  caf: { mime: 'audio/x-caf', ext: '.caf' },
}

/** 容器 → 扩展名；视频可承载或未知容器返回 null */
export function extFromContainer(container: string | null | undefined): string | null {
  return (container && CONTAINER_TYPES[container]?.ext) || null
}

/** 容器 → MIME；视频可承载或未知容器返回 null */
export function mimeFromContainer(container: string | null | undefined): string | null {
  return (container && CONTAINER_TYPES[container]?.mime) || null
}

/** MIME → 扩展名（供 audio-serve 的 extFromContentType 复用，避免两份表漂移） */
export function extFromAudioMime(mime: string | null | undefined): string | null {
  if (!mime) return null
  const hit = Object.values(CONTAINER_TYPES).find(t => t.mime === mime)
  return hit?.ext ?? null
}

/** 扩展名 → MIME（供按扩展名发响应头的下游复用同一张表） */
export function mimeFromAudioExt(ext: string | null | undefined): string | null {
  if (!ext) return null
  const normalized = ext.toLowerCase()
  const hit = Object.values(CONTAINER_TYPES).find(t => t.ext === normalized)
  return hit?.mime ?? null
}

/** 明确「不是音频」的二进制格式（图片/压缩包/文档）：源返回这些必定是坏链路 */
const REJECT_BINARY_TESTS: Array<{ name: string; test: (h: Uint8Array) => boolean }> = [
  {
    name: 'PNG',
    test: h => h.length >= 4 && h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47,
  },
  { name: 'JPEG', test: h => h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  { name: 'GIF', test: h => startsWithAscii(h, 0, 'GIF8') },
  { name: 'WebP', test: h => startsWithAscii(h, 0, 'RIFF') && startsWithAscii(h, 8, 'WEBP') },
  { name: 'TIFF', test: h => startsWithAscii(h, 0, 'II*\x00') || startsWithAscii(h, 0, 'MM\x00*') },
  {
    name: 'ZIP',
    test: h =>
      h.length >= 4 &&
      h[0] === 0x50 &&
      h[1] === 0x4b &&
      (h[2] === 0x03 || h[2] === 0x05 || h[2] === 0x07) &&
      (h[3] === 0x04 || h[3] === 0x06 || h[3] === 0x08),
  },
  { name: 'gzip', test: h => h.length >= 2 && h[0] === 0x1f && h[1] === 0x8b },
  { name: 'RAR', test: h => startsWithAscii(h, 0, 'Rar!') },
  {
    name: '7z',
    test: h =>
      h.length >= 6 &&
      h[0] === 0x37 &&
      h[1] === 0x7a &&
      h[2] === 0xbc &&
      h[3] === 0xaf &&
      h[4] === 0x27 &&
      h[5] === 0x1c,
  },
  { name: 'PDF', test: h => startsWithAscii(h, 0, '%PDF') },
]

/** 跳过 UTF-8 BOM 与空白后的第一个字节下标 */
function firstMeaningfulIndex(head: Uint8Array): number {
  let i = 0
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3
  while (
    i < head.length &&
    (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)
  ) {
    i++
  }
  return i
}

/**
 * 前 32 字节无控制字符且全为可打印 ASCII / 高位字节 → 判为文本。
 * 已知容器在调用前已排除，故随机二进制被误判为文本的概率很低（约 2%），
 * 且误判后果仅是「换下一个源」，代价可接受。
 */
function isPrintableRun(head: Uint8Array): boolean {
  const n = Math.min(head.length, 32)
  if (n === 0) return false
  for (let i = 0; i < n; i++) {
    const c = head[i]
    const ok =
      c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c <= 0x7e) || c >= 0x80
    if (!ok) return false
  }
  return true
}

/** 头部是否呈现文本特征（HTML/XML/JSON/纯文本错误信息） */
export function isTextLike(head: Uint8Array): boolean {
  const start = firstMeaningfulIndex(head)
  if (start >= head.length) return false
  const c = head[start]
  if (c === 0x3c || c === 0x7b || c === 0x5b) return true // '<' '{' '['
  return isPrintableRun(head)
}

/** 识别已知媒体容器；未识别返回 null */
export function detectContainer(head: Uint8Array): string | null {
  for (const t of CONTAINER_TESTS) {
    if (t.test(head)) return t.name
  }
  return null
}

/** 识别「明确非音频」的二进制格式；未识别返回 null */
export function detectRejectBinary(head: Uint8Array): string | null {
  for (const t of REJECT_BINARY_TESTS) {
    if (t.test(head)) return t.name
  }
  return null
}

/** Content-Type 主类型分类（去掉参数后判断） */
export function classifyContentType(
  ct: string | null | undefined
): 'audio' | 'video' | 'text' | 'other' {
  if (!ct) return 'other'
  const main = ct.toLowerCase().split(';')[0].trim()
  if (main.startsWith('audio/')) return 'audio'
  if (main.startsWith('video/')) return 'video'
  if (main.startsWith('text/')) return 'text'
  if (main === 'application/json' || main.endsWith('+json')) return 'text'
  if (main === 'application/xml' || main.endsWith('+xml')) return 'text'
  if (main === 'application/javascript' || main === 'application/x-javascript') return 'text'
  return 'other'
}

/**
 * 综合判定上游载荷。`head` 传响应的首个数据块（内部只看前 SNIFF_HEAD_BYTES 字节）。
 * 字节证据优先于 Content-Type（后者在音源侧普遍不可信）。
 */
export function judgeUpstreamPayload(input: {
  contentType?: string | null
  head: Uint8Array | null
}): PayloadJudgment {
  const head =
    input.head && input.head.length > 0 ? input.head.subarray(0, SNIFF_HEAD_BYTES) : null
  const ctMain = input.contentType
    ? input.contentType.toLowerCase().split(';')[0].trim() || null
    : null
  const ctKind = classifyContentType(input.contentType)
  const base = { container: null, contentType: ctMain } as const

  // ① 字节层面。容器魔数必须先查：isTextLike 里的"整段可打印"判据只看前 32 字节，
  //    而某些合法容器的头部恰好全可打印（如 'fLaC' + ASCII 填充），先查文本会把真音频判成假地址。
  if (head) {
    const container = detectContainer(head)
    if (container) {
      return {
        verdict: 'audio',
        reason: `识别到媒体容器 ${container}`,
        container,
        contentType: ctMain,
      }
    }
    const rejectName = detectRejectBinary(head)
    if (rejectName) {
      return { ...base, verdict: 'reject', reason: `响应是 ${rejectName} 内容，不是音频` }
    }
    if (isTextLike(head)) {
      return { ...base, verdict: 'reject', reason: '响应是文本/HTML/JSON，不是音频' }
    }
  }

  // ② Content-Type 兜底
  if (ctKind === 'text') {
    return { ...base, verdict: 'reject', reason: `Content-Type 是文本类型（${ctMain}）` }
  }
  if (ctKind === 'audio' || ctKind === 'video') {
    return {
      ...base,
      verdict: 'unverified',
      reason: `Content-Type 声明为 ${ctMain}，但字节未匹配已知容器`,
    }
  }
  return {
    ...base,
    verdict: 'unverified',
    reason: `容器无法识别（Content-Type=${ctMain ?? '缺失'}）`,
  }
}

/** 读取文件头部字节（容器判定用）；文件不存在/读失败/空文件返回 null */
export async function readHeadBytes(
  filePath: string,
  bytes = SNIFF_HEAD_BYTES
): Promise<Uint8Array | null> {
  let handle: fsp.FileHandle | null = null
  try {
    handle = await fsp.open(filePath, 'r')
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buf, 0, bytes, 0)
    return bytesRead > 0 ? buf.subarray(0, bytesRead) : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

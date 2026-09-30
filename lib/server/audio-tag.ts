/**
 * FLAC 内嵌标签的读与写（纯函数，不做任何 I/O、不引新依赖）。
 *
 * 为什么只做"块链头部"：FLAC 的元数据全在 `fLaC` 之后的 metadata block 链里，
 * 音频帧从链结束处开始且是**流式解码、不引用绝对偏移**，所以整段替换链头、原样转发
 * 链后字节是安全的（seektable/cuesheet 例外——它们按**样点位置**索引，插入标签后
 * 偏移仍成立，但保守起见连同旧注释/封面一起丢掉，让播放器自行重建，见 §readChain）。
 *
 * 关键安全属性：本模块**从不修改调用方传进来的 buffer**，也不碰磁盘上的缓存原件 ——
 * 调用方只在"交付给客户端的那条流"里替换链头，缓存文件字节不变（音频缓存的
 * `record.size` 从不重新 stat，长度一变 Range/Content-Length 就全错位）。
 */

/** 块类型（FLAC 规范）：0 STREAMINFO 1 PADDING 2 APPLICATION 3 SEEKTABLE 4 VORBIS_COMMENT 5 CUESHEET 6 PICTURE */
export const BLOCK_STREAMINFO = 0
export const BLOCK_PADDING = 1
export const BLOCK_SEEKTABLE = 3
export const BLOCK_VORBIS_COMMENT = 4
export const BLOCK_CUESHEET = 5
export const BLOCK_PICTURE = 6

/** 链头读取上限：真实文件链头都在几 KB 级，超过就放弃改写（宁可少标签，不能给错长度） */
export const FLAC_MAX_HEAD_BYTES = 512 * 1024

/** 改写时丢掉的旧块：注释与封面由我们重写，padding 尺寸要跟着新长度走，
 *  索引类块（seektable/cuesheet）在样点索引之外还可能被某些实现当作字节锚点，保守丢弃 */
const DROPPED_BLOCK_TYPES = new Set<number>([
  BLOCK_PADDING, BLOCK_SEEKTABLE, BLOCK_VORBIS_COMMENT, BLOCK_CUESHEET, BLOCK_PICTURE,
])

export interface FlacBlock {
  type: number
  last: boolean
  /** 块体长度，不含 4 字节块头 */
  length: number
  /** 块头在 head 缓冲里的起始偏移 */
  offset: number
}

export interface FlacChain {
  ok: true
  /** 链末尾（= 音频帧起始偏移） */
  audioStart: number
  blocks: FlacBlock[]
  /** 将被丢掉的旧块总字节（含块头），用于精确算新 Content-Length */
  droppedBytes: number
  /** STREAMINFO 原始字节（含块头），必须原样保留 */
  streamInfo: Buffer
}

export interface FlacChainError {
  ok: false
  reason: string
}

/**
 * 解析 `fLaC` 之后的块链。返回 ok:false 的几种情况都必须让调用方退回原样透传：
 * 魔数不符、块链越界/截断、STREAMINFO 不在第一位或长度不是 34、链超过读取上限。
 */
export function readFlacChain(head: Buffer): FlacChain | FlacChainError {
  if (head.length < 4) return { ok: false, reason: `缓冲不足 4 字节（${head.length}）` }
  if (head.subarray(0, 4).toString('latin1') !== 'fLaC') return { ok: false, reason: '缺少 fLaC 魔数' }

  const blocks: FlacBlock[] = []
  let off = 4
  let droppedBytes = 0
  let streamInfo: Buffer | null = null

  while (off + 4 <= head.length) {
    const flags = head[off]
    const last = (flags & 0x80) !== 0
    const type = flags & 0x7f
    const length = (head[off + 1] << 16) | (head[off + 2] << 8) | head[off + 3]
    if (Number.isNaN(length) || length < 0) return { ok: false, reason: `块 ${type} 长度非法` }
    if (off + 4 + length > head.length) return { ok: false, reason: `块 ${type} 越出已读缓冲（需 ${off + 4 + length}，有 ${head.length}）` }

    if (blocks.length === 0 && (type !== BLOCK_STREAMINFO || length !== 34)) {
      return { ok: false, reason: `首块不是 34 字节的 STREAMINFO（type=${type} len=${length}）` }
    }
    if (type === BLOCK_STREAMINFO && blocks.length > 0) {
      return { ok: false, reason: 'STREAMINFO 出现在非首位' }
    }
    blocks.push({ type, last, length, offset: off })
    if (DROPPED_BLOCK_TYPES.has(type)) droppedBytes += 4 + length
    if (type === BLOCK_STREAMINFO) streamInfo = head.subarray(off, off + 4 + length)
    off += 4 + length
    if (last) {
      if (!streamInfo) return { ok: false, reason: '链里没有 STREAMINFO' }
      return { ok: true, audioStart: off, blocks, droppedBytes, streamInfo }
    }
  }
  return { ok: false, reason: '缓冲读完仍未见链结束标志' }
}

/** Vorbis comment：vendor 串 + `KEY=value`（UTF-8，小写键是社区惯例） */
export function buildFlacCommentBlock(fields: Record<string, string | null | undefined>): Buffer {
  const VENDOR = 'HollyMusic'
  const pairs: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    const v = (value ?? '').trim()
    if (!v) continue
    // 换行会让键值对解析错位，且我们只写单行字段（LYRICS 用 \n 分隔是 Vorbis 的多值惯例，
    // 但会把"一个键"变成可读性争议区，这里按多数播放器的做法保留换行原样）
    pairs.push(`${key}=${v}`)
  }
  const vendor = Buffer.from(VENDOR, 'utf8')
  const body: Buffer[] = [writeLE32(vendor.length), vendor, writeLE32(pairs.length)]
  for (const pair of pairs) {
    const b = Buffer.from(pair, 'utf8')
    body.push(writeLE32(b.length), b)
  }
  return wrapFlacBlock(BLOCK_VORBIS_COMMENT, Buffer.concat(body))
}

/**
 * PICTURE 块（FLAC 原生封面，不是 ID3 的 APIC）。
 * 结构：type(4) + mimeLen(4) + mime + descLen(4) + desc(utf8) + w/h/depth/colors(各4) + dataLen(4) + data
 */
export function buildFlacPictureBlock(mime: string, data: Buffer, description = 'Cover (front)'): Buffer {
  if (!/^image\//.test(mime)) throw new Error(`不是图片 mime：${mime}`)
  const mimeBuf = Buffer.from(mime, 'utf8')
  const descBuf = Buffer.from(description, 'utf8')
  const body = Buffer.concat([
    writeBE32(3),                     // 3 = Cover (front)
    writeBE32(mimeBuf.length), mimeBuf,
    writeBE32(descBuf.length), descBuf,
    writeBE32(0), writeBE32(0),       // width/height：0 表示由解码器决定
    writeBE32(0), writeBE32(0),       // color depth / colors used
    writeBE32(data.length), data,
  ])
  return wrapFlacBlock(BLOCK_PICTURE, body)
}

/**
 * 生成替换后的链头。保留块 = 除 DROPPED_BLOCK_TYPES 之外的原有块（含除 STREAMINFO 外的应用块等），
 * 新注释/封面插在 STREAMINFO 之后，最后统一重算 last-flag。
 *
 * @param head 已读到的文件头缓冲（至少覆盖到链结束，否则返回 ok:false）
 */
export function rewriteFlacHead(
  head: Buffer,
  fields: Record<string, string | null | undefined>,
  picture?: { mime: string; data: Buffer } | null,
): { ok: true; newHead: Buffer; audioStart: number; delta: number } | { ok: false; reason: string } {
  const chain = readFlacChain(head)
  if (!chain.ok) return chain

  const kept: Buffer[] = []
  for (const b of chain.blocks) {
    if (b.type === BLOCK_STREAMINFO) continue
    if (DROPPED_BLOCK_TYPES.has(b.type)) continue
    kept.push(Buffer.from(head.subarray(b.offset, b.offset + 4 + b.length)))
  }

  const newBlocks: Buffer[] = [buildFlacCommentBlock(fields)]
  if (picture && picture.data.length) {
    try {
      newBlocks.push(buildFlacPictureBlock(picture.mime, picture.data))
    } catch { /* 封面 mime 异常就不打封面，别把整次改写带崩 */ }
  }

  // 'fLaC' 魔数不是块，必须放在打 last-flag 的那轮之外——否则第一个块的字节 0
  // 会被当成 flags 改写（魔数恰好没有第 8 位，掩盖了这个错，别照抄）
  const blockPieces = [chain.streamInfo, ...newBlocks, ...kept].map(p => {
    const copy = Buffer.alloc(p.length)
    p.copy(copy)
    return copy
  })
  for (let i = 0; i < blockPieces.length; i++) {
    const b = blockPieces[i]
    b[0] = (i === blockPieces.length - 1 ? 0x80 : 0) | (b[0] & 0x7f)   // 只动 last-flag，保留类型位
  }
  const newHead = Buffer.concat([Buffer.from('fLaC', 'latin1'), ...blockPieces])

  return { ok: true, newHead, audioStart: chain.audioStart, delta: newHead.length - chain.audioStart }
}

function writeLE32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0, 0)
  return b
}

function writeBE32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0, 0)
  return b
}

/** 块头：last-flag(1) + type(7) + 24 位大端长度 */
function wrapFlacBlock(type: number, body: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head[0] = type & 0x7f
  head[1] = (body.length >> 16) & 0xff
  head[2] = (body.length >> 8) & 0xff
  head[3] = body.length & 0xff
  return Buffer.concat([head, body])
}

/** 从注释块里读回键值（给测试和"保留我们没提供的键"用） */
export function parseFlacCommentBlock(block: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  const body = block.subarray(4)
  let p = 0
  if (p + 4 > body.length) return out
  const vendorLen = body.readUInt32LE(p); p += 4 + vendorLen
  if (p + 4 > body.length) return out
  const count = body.readUInt32LE(p); p += 4
  for (let i = 0; i < count; i++) {
    if (p + 4 > body.length) break
    const len = body.readUInt32LE(p); p += 4
    if (p + len > body.length) break
    const pair = body.subarray(p, p + len).toString('utf8'); p += len
    const eq = pair.indexOf('=')
    if (eq > 0) out[pair.slice(0, eq).toUpperCase()] = pair.slice(eq + 1)
  }
  return out
}

// ============================================================================
// MP3 / ID3v2
// ============================================================================
//
// 为什么必须**丢掉尾部的 ID3v1**：它的字段是定长 GBK/latin1 窄空间，中文在这里必然坏掉；
// 我们换了新头部却留着旧尾部，就会出现"新头部说真话、尾部 128 字节说假话"，
// 只读尾部标签的老播放器于是显示乱码歌手名。头部（ID3v2）整段替换、尾部整段丢弃，
// 中间那些 MPEG 帧**一个字节都不动** —— 帧是流式自同步的，不引用绝对偏移，所以安全。
//
// APEv2 一律不改写：它的正文在**尾部**，而它的头字段里存的是相对文件起点的偏移，
// 换头部 = 全部偏移作废，而我们没有把握把所有字段都算对（宁可少一项标签）。

/** ID3v1 恒为 128 字节，'TAG' 开头 */
export const ID3V1_BYTES = 128
/** 找 MPEG 帧起点时要扫的头窗口：足够跨过 ID3v2 + padding + 前若干帧 */
export const MP3_MAX_HEAD_BYTES = 512 * 1024

/** 我们写的 ID3v2 里用到的文本帧：UTF-16LE + BOM（第三方工具写中文歌词都走这条路） */
const ID3_TEXT_FRAME_IDS = ['TIT2', 'TPE1', 'TALB', 'TYER', 'TRCK'] as const

export interface Mp3Layout {
  ok: true
  /** 音频帧在**原文件**里的起始偏移 = 要替换掉的头部字节数（无 ID3v2 时为 0） */
  audioStart: number
  /** 尾部要裁掉的字节数（ID3v1） */
  tailTrim: number
  /** 原头部里的 ID3v2 主版本号（仅用于日志） */
  id3v2Version: number | null
}

export interface Mp3LayoutError {
  ok: false
  reason: string
}

function synchsafe(b: Buffer, off: number): number {
  return ((b[off] & 0x7f) << 21) | ((b[off + 1] & 0x7f) << 14) | ((b[off + 2] & 0x7f) << 7) | (b[off + 3] & 0x7f)
}

const LAYER3_BITRATE_KBPS: Record<number, number[]> = {
  // MPEG1 Layer III（索引 0=free、15=bad 一律拒绝）
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  // MPEG2 / MPEG2.5 Layer III
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
const SAMPLE_RATE: Record<number, number[]> = {
  1: [22050, 24000, 16000],   // MPEG2
  2: [11025, 12000, 8000],    // MPEG2.5
  3: [44100, 48000, 32000],   // MPEG1
}

/**
 * 只看 4 字节头判断"像不像一个 MPEG1/2/2.5 Layer III 帧"，并算出它的字节长度。
 * 返回 0 表示这不是可用的帧头（含 free 码率、reserved 采样率等非确定情形）。
 */
function mpegFrameLength(b: Buffer, i: number): number {
  if (i + 4 > b.length) return 0
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return 0
  const versionBits = (b[i + 1] >> 3) & 0x03      // 0=MPEG2.5 2=MPEG2 3=MPEG1（1=reserved）
  const layerBits = (b[i + 1] >> 1) & 0x03        // 1=LayerIII（2=II 3=I，我们不处理）
  if (versionBits === 1 || layerBits !== 1) return 0
  const bitrateIdx = (b[i + 2] >> 4) & 0x0f
  if (bitrateIdx === 0 || bitrateIdx === 0x0f) return 0
  const rateIdx = (b[i + 2] >> 2) & 0x03
  if (rateIdx === 0x03) return 0
  const pad = (b[i + 2] >> 1) & 0x01
  const kbps = LAYER3_BITRATE_KBPS[versionBits === 3 ? 1 : 2][bitrateIdx]
  const hz = SAMPLE_RATE[versionBits][rateIdx]
  if (!kbps || !hz) return 0
  // MPEG1 Layer III = 144000*kbps/hz；MPEG2/2.5 = 72000*kbps/hz
  return Math.floor((versionBits === 3 ? 144000 : 72000) * kbps / hz) + pad
}

/**
 * 找第一个**真正**的音频帧：光"看着像帧头"会误判（音频里到处是 0xFFE0），
 * 所以要求下一帧头正好落在上一帧的结束处（连续两帧才算）。找不到就返回 -1。
 */
function findFirstMpegFrame(head: Buffer, from: number): number {
  for (let i = Math.max(0, from); i + 4 <= head.length; i++) {
    const len = mpegFrameLength(head, i)
    if (len <= 0) continue
    const next = i + len
    if (next + 4 <= head.length && mpegFrameLength(head, next) > 0) return i
  }
  return -1
}

/** 跳过可能存在的（甚至串接的）ID3v2 标签，返回它结束的偏移 */
function skipId3v2(head: Buffer): { at: number; version: number | null; error?: string } {
  let at = 0
  let version: number | null = null
  for (let round = 0; round < 4; round++) {
    if (head.subarray(at, at + 3).toString('latin1') !== 'ID3') break
    if (at + 10 > head.length) return { at, version, error: 'ID3 头不完整' }
    const major = head[at + 3]
    if (major < 2 || major > 4) return { at, version, error: `不支持的 ID3v2.${major}` }
    const size = synchsafe(head, at + 6)
    const end = at + 10 + size
    if (size < 0 || end > head.length) {
      return { at, version, error: `ID3v2 声明 ${size}B，超出已读窗口 ${head.length}B` }
    }
    at = end
    version = major
  }
  return { at, version }
}

/** 三个定长字段几乎都是可打印字符 —— 用来把真 ID3v1 和"音频字节恰好是 TAG"区分开 */
function looksLikeId3v1(v1: Buffer): boolean {
  if (v1.length < ID3V1_BYTES) return false
  if (v1.subarray(0, 3).toString('latin1') !== 'TAG') return false
  // 布局：TAG(3) + title(30) + artist(30) + album(30) + year(4) + comment(30) + genre(1)
  return [3, 33, 63].every(off => {
    let nonZero = 0
    let printable = 0
    for (let i = off; i < off + 30; i++) {
      const c = v1[i]
      if (c !== 0) nonZero++
      if (c >= 0x20 && c < 0x7f) printable++
    }
    return printable >= nonZero - 1
  })
}

/**
 * 判定 MP3 的头部/尾部该怎么切。任何"算不准"的情况一律 ok:false ——
 * 因为长度必须在响应头之前定死，猜错一位就会让整个文件错位。
 *
 * @param head 文件开头（至少覆盖到 ID3v2 + 前几帧）
 * @param tail 文件结尾（至少 128B，用于查 ID3v1 / APEv2）
 */
export function readMp3Layout(head: Buffer, tail: Buffer): Mp3Layout | Mp3LayoutError {
  if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'fLaC') {
    return { ok: false, reason: '内容是 FLAC，不该走 MP3 分支' }
  }
  if (head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    return { ok: false, reason: '内容是 MP4/M4A，不改写' }
  }

  if (tail.length >= 32 && tail.subarray(tail.length - 32, tail.length - 24).toString('latin1') === 'APETAGEX') {
    return { ok: false, reason: '尾部有 APEv2，它按绝对偏移索引，换头部会全错' }
  }
  const v1 = tail.subarray(Math.max(0, tail.length - ID3V1_BYTES))
  const tailTrim = looksLikeId3v1(v1) ? ID3V1_BYTES : 0

  const skip = skipId3v2(head)
  if (skip.error) return { ok: false, reason: skip.error }

  // 没有 ID3v2 时也必须确认"开头就是音频帧"，否则我们可能在改写别的容器
  const frame = findFirstMpegFrame(head, skip.at)
  if (frame < 0) {
    return { ok: false, reason: `在头部 ${head.length}B 内找不到连续两帧的 MPEG 同步（不是可改写的 MP3）` }
  }
  // ID3v2 之后到第一个帧之间的零填充/垃圾一并丢掉（它们不是音频字节）
  return { ok: true, audioStart: frame, tailTrim, id3v2Version: skip.version }
}

function id3TextFrame(id: string, text: string): Buffer {
  const body = Buffer.concat([Buffer.from([1]), Buffer.from('\uFEFF' + text, 'utf16le')])
  return wrapId3Frame(id, body)
}

/** APIC（v2.3）：编码 + mime(以 0x00 结尾) + 图片类型 + 描述(UTF-16，双 0 结尾) + 数据 */
export function buildId3ApicFrame(mime: string, data: Buffer, description = 'Cover (front)'): Buffer {
  const body = Buffer.concat([
    Buffer.from([1]),
    Buffer.from(mime, 'latin1'), Buffer.from([0]),
    Buffer.from([3]),                         // 3 = Cover (front)
    Buffer.from('\uFEFF' + description, 'utf16le'), Buffer.from([0, 0]),
    data,
  ])
  return wrapId3Frame('APIC', body)
}

/** USLT（v2.3）：编码 + 三字节语言 + 描述(UTF-16，双 0 结尾) + 歌词正文 */
export function buildId3UsltFrame(text: string, language = 'chi'): Buffer {
  const body = Buffer.concat([
    Buffer.from([1]),
    Buffer.from(language, 'latin1').subarray(0, 3),
    Buffer.from([0, 0]),
    Buffer.from('\uFEFF' + text, 'utf16le'),
  ])
  return wrapId3Frame('USLT', body)
}

/** v2.3 的帧长度是普通大端 4 字节（**只有标签头是 synchsafe**，这两者极易搞混） */
function wrapId3Frame(id: string, body: Buffer): Buffer {
  const head = Buffer.alloc(10)
  head.write(id, 0, 4, 'latin1')
  head.writeUInt32BE(body.length, 4)
  return Buffer.concat([head, body])
}

export interface Id3TagBuild {
  ok: true
  tag: Buffer
  frames: string[]
}
export interface Id3TagBuildError {
  ok: false
  reason: string
}

/**
 * 生成一整份 ID3v2.3 标签（不含被替换掉的旧帧——本仓库的策略是整段换新，
 * 实测上游 MP3 的旧帧只有 TLEN/TSSE 这类机器字段，合并没有价值）。
 */
export function buildId3v2Tag(
  fields: Record<string, string | null | undefined>,
  picture?: { mime: string; data: Buffer } | null,
): Id3TagBuild | Id3TagBuildError {
  const map: Record<string, string> = { TITLE: 'TIT2', ARTIST: 'TPE1', ALBUM: 'TALB', DATE: 'TYER', TRACK: 'TRCK' }
  const frames: Buffer[] = []
  const names: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    const id = map[key]
    if (!id || !(ID3_TEXT_FRAME_IDS as readonly string[]).includes(id)) continue
    const v = (value ?? '').trim()
    if (!v) continue
    frames.push(id3TextFrame(id, v))
    names.push(id)
  }
  if (picture && picture.data.length) {
    if (!/^image\//.test(picture.mime)) {
      return { ok: false, reason: `不是图片 mime：${picture.mime}` }
    }
    frames.push(buildId3ApicFrame(picture.mime, picture.data))
    names.push('APIC')
  }
  const lyric = (fields.LYRICS ?? '').trim()
  if (lyric) {
    frames.push(buildId3UsltFrame(lyric))
    names.push('USLT')
  }

  const body = Buffer.concat(frames)
  // synchsafe 只有 28 位可用，超了就写不下（正常封面远到不了这个量级，这里是护栏）
  if (body.length > 0x0ffffff0) return { ok: false, reason: `标签过大 ${body.length}B` }
  const size = Buffer.alloc(4)
  size[0] = (body.length >>> 21) & 0x7f
  size[1] = (body.length >>> 14) & 0x7f
  size[2] = (body.length >>> 7) & 0x7f
  size[3] = body.length & 0x7f
  return { ok: true, tag: Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), size, body]), frames: names }
}

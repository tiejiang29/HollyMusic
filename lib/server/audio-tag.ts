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

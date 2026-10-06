/**
 * 内存内的最小 ZIP 读取器（只为音源发现展开 release 里的压缩包）。
 *
 * 三条不退让的设计：
 * 1. **绝不落地**：条目名只当标签用，我们从不按它创建目录或文件。这一条直接把 Zip Slip
 *    （`../../x.js` 这类条目名）整类消掉 —— 不需要"清洗路径"，因为没有路径。
 * 2. **上限按解压后的真实字节数算**，不是按包里声明的大小：声明值可以撒谎。deflate 一律带
 *    `maxOutputLength`，超了是 zlib 直接失败，而不是先炸开再发现。
 * 3. **能力窄，拒绝要说清**：只认 store(0) 与 deflate(8)。加密条目、ZIP64、别的方法
 *    （bzip2/lzma）一律拒绝，并给出能读的原因，不要静默少收东西。
 *
 * 不引第三方解压依赖：本机现有的 `archiver` 只会打包不会解包，而 Node 自带 `zlib` 够读完
 * 这一份格式，自研这百来行对不可信的包反而更可控（想拒绝什么就拒绝什么）。
 */
import zlib from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CD_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD64_LOCATION_SIGNATURE = 0x07064b50
const MAX_EOCD_SCAN_BYTES = 66_000
const FLAG_ENCRYPTED = 0x01
/**
 * bit 3：local header 里的大小字段是 0，真大小在数据之后的描述符里。
 * 实测 GitHub 上的音源汇总包就是这个形状（`flag=0x808`：UTF-8 名字 + 这一位）。
 * 我们从 central directory 取大小，所以这一位**不是**拒绝理由，恰恰是要照中央目录走的理由。
 */
const FLAG_DATA_DESCRIPTOR = 0x08
/** bit 11：条目名是 UTF-8。没置位不代表不是中文，见 decodeEntryName */
const FLAG_UTF8_NAME = 0x800

export interface ZipEntry {
  /** 包内名字。**只用于展示与当唯一键的一部分**，从不落地成路径 */
  name: string
  /** 0 = stored，8 = deflate；其它方法在 listZipEntries 就被拒掉 */
  method: number
  uncompressedSize: number
  compressedSize: number
  localOffset: number
}

export interface ZipLimits {
  /** 单个条目解压后的上限 */
  maxEntryBytes: number
  /** 整包已解压条目的合计上限（防解压炸弹） */
  maxTotalBytes: number
  /** 条目数上限 */
  maxEntries: number
}

export interface ZipListing {
  /** 可取的普通文件条目（方法合法、未加密、不超限） */
  entries: ZipEntry[]
  /** 被拒的条目数与原因（按原因归并，别把几百条噪声塞进结论） */
  rejected: { count: number; reason: string }[]
  /** 纯目录条目（没有内容，不收也不算被拒） */
  directories: number
  /** 解压后合计用掉了多少预算 */
  totalBytes: number
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipFormatError'
  }
}

function findEocd(buffer: Buffer): number {
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - MAX_EOCD_SCAN_BYTES); i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i
  }
  return -1
}

let utf8Strict: TextDecoder | null = null
let gbkDecoder: TextDecoder | null = null
let utf8Loose: TextDecoder | null = null
let latin1Decoder: TextDecoder | null = null

/**
 * 条目名解码。实测真包的形状是"UTF-8 位没置、名字其实是 GBK"（`V260817` 那个包 27 条里只有 1 条
 * 置了 UTF-8 位），直接按 UTF-8 读会得到一串 U+FFFD —— 面板上就是一堆乱码。
 * 顺序：置了 UTF-8 位就按 UTF-8；否则先严格试 UTF-8（工具没置位但内容真是 UTF-8 的情况不少），
 * 再退 GBK，最后按 latin-1 保底。
 * 名字**只当标签与唯一键的一部分**，从不落地成路径，所以这里判错也不会造成安全问题，只影响可读性。
 */
function decodeEntryName(bytes: Buffer, utf8Flag: boolean): string {
  utf8Loose ??= new TextDecoder('utf-8')
  if (utf8Flag) return utf8Loose.decode(bytes)
  utf8Strict ??= new TextDecoder('utf-8', { fatal: true })
  try {
    return utf8Strict.decode(bytes)
  } catch {
    // 不是合法 UTF-8，按下面的顺序再试
  }
  try {
    gbkDecoder ??= new TextDecoder('gbk')
    return gbkDecoder.decode(bytes)
  } catch {
    latin1Decoder ??= new TextDecoder('latin1')
    return latin1Decoder.decode(bytes)
  }
}

/**
 * 读 central directory。签名不对、ZIP64、条目数超上限都直接抛 `ZipFormatError` ——
 * 调用方要的是"这包我没能力安全地读"，不是半截结果。
 */
export function listZipEntries(buffer: Buffer, limits: ZipLimits): ZipListing {
  if (buffer.length < 22) throw new ZipFormatError('文件太小，不像 zip')
  const eocd = findEocd(buffer)
  if (eocd < 0) throw new ZipFormatError('找不到 zip 结尾记录（EOCD），可能不是常规 zip')
  if (eocd + 22 < buffer.length && buffer.readUInt32LE(eocd - 4) === EOCD64_LOCATION_SIGNATURE) {
    throw new ZipFormatError('ZIP64 格式，本读取器不支持（音源汇总包用不到它，宁可不读也不猜）')
  }

  const declaredEntries = buffer.readUInt16LE(eocd + 10)
  const cdSize = buffer.readUInt32LE(eocd + 12)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  if (declaredEntries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new ZipFormatError('ZIP64 格式，本读取器不支持')
  }
  if (cdOffset + cdSize > eocd) throw new ZipFormatError('central directory 位置越界，包可能是残缺的')
  if (declaredEntries > limits.maxEntries) {
    throw new ZipFormatError(`条目数 ${declaredEntries} 超过上限 ${limits.maxEntries}`)
  }

  const entries: ZipEntry[] = []
  const rejected = new Map<string, number>()
  const reject = (reason: string) => rejected.set(reason, (rejected.get(reason) ?? 0) + 1)

  let cursor = cdOffset
  let totalBytes = 0
  let directories = 0
  for (let index = 0; index < declaredEntries; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CD_SIGNATURE) {
      throw new ZipFormatError(`central directory 第 ${index} 条签名不对`)
    }
    const flag = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const externalAttributes = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = decodeEntryName(buffer.subarray(cursor + 46, cursor + 46 + nameLength), (flag & FLAG_UTF8_NAME) !== 0)

    // 目录条目没有内容，不算被拒，只是不收
    const isDirectory = name.endsWith('/') || (externalAttributes & 0x10) !== 0
    if (isDirectory) {
      directories++
    } else if ((flag & FLAG_ENCRYPTED) !== 0) {
      reject('加密条目')
    } else if (method !== 0 && method !== 8) {
      reject(`不支持的压缩方法 ${method}`)
    } else if (uncompressedSize > 0 && compressedSize === 0) {
      // 大小自相矛盾（带 bit 3 而中央目录也没记上大小）：宁可不读，也不去猜数据边界
      reject('中央目录里的压缩大小为 0，无法定位数据')
    } else if (uncompressedSize > limits.maxEntryBytes) {
      reject(`单条目解压后超过 ${Math.round(limits.maxEntryBytes / 1024)}KB`)
    } else if (totalBytes + uncompressedSize > limits.maxTotalBytes) {
      reject('整包解压后超过上限')
    } else {
      entries.push({ name, method, uncompressedSize, compressedSize, localOffset })
      totalBytes += uncompressedSize
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }

  return {
    entries,
    rejected: [...rejected.entries()].map(([reason, count]) => ({ reason, count })),
    directories,
    totalBytes,
  }
}

/**
 * 取出一个条目的字节。压缩数据按 central directory 的 `compressedSize` 切，
 * 解压一律带 `maxOutputLength`：声明值撒谎时 zlib 会失败，而不是先炸开内存。
 */
export function extractZipEntry(buffer: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  const offset = entry.localOffset
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new ZipFormatError(`条目 ${entry.name} 的 local header 位置不对`)
  }
  const localFlag = buffer.readUInt16LE(offset + 6)
  if ((localFlag & FLAG_ENCRYPTED) !== 0) throw new ZipFormatError(`条目 ${entry.name} 是加密的，取不了`)
  // bit 3 不当拒绝理由（实测真包就是这形状）：它只意味着 local 头里的大小是 0，
  // 而我们切片用的 compressedSize 来自 central directory，边界仍然是对的。
  // 但"带描述符 + 中央目录也没记大小"就真没法定位数据了 —— 那种直接拒。
  if ((localFlag & FLAG_DATA_DESCRIPTOR) !== 0 && entry.compressedSize === 0) {
    throw new ZipFormatError(`条目 ${entry.name} 带数据描述符又没记大小，取不了`)
  }
  const nameLength = buffer.readUInt16LE(offset + 26)
  const extraLength = buffer.readUInt16LE(offset + 28)
  const start = offset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > buffer.length) throw new ZipFormatError(`条目 ${entry.name} 的数据超出文件末尾`)
  const raw = buffer.subarray(start, end)

  if (entry.method === 0) {
    if (entry.compressedSize > maxBytes) throw new ZipFormatError(`条目 ${entry.name} 超过 ${maxBytes} 字节上限`)
    return raw
  }
  if (entry.method !== 8) throw new ZipFormatError(`条目 ${entry.name} 的压缩方法 ${entry.method} 不支持`)
  try {
    return zlib.inflateRawSync(raw, { maxOutputLength: maxBytes })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 实测 Node 24 在超出时抛 `ERR_BUFFER_TOO_LARGE: Cannot create a Buffer larger than N bytes`
    // （消息里没有 "maxOutputLength" 这个词，所以按 code 认，别按文案猜）
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'ERR_BUFFER_TOO_LARGE' || /larger than \d+ bytes/i.test(message)) {
      throw new ZipFormatError(`条目 ${entry.name} 解压后超过 ${maxBytes} 字节上限`)
    }
    throw new ZipFormatError(`条目 ${entry.name} 解压失败：${message.slice(0, 80)}`)
  }
}

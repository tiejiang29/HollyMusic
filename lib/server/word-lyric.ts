/**
 * 逐字歌词（word-level）归一化：把酷狗 KRC、咪咕 MRC 与 QQ QRC 解析成同一个中性行/词
 * 结构，再序列化为增强 LRC。纯函数，不发请求、不碰磁盘；接线是下一步的事。
 *
 * 这个模块存在的唯一理由是三家坐标系不同：
 * - KRC：`[39622,4417]<0,241,0>釉<241,251,0>色` —— 标签在文本**前**，时间是**行内相对**
 * - MRC：`[14416,2145]你(14416,249)的(14665,300)` —— 标签在文本**后**，时间是**绝对**毫秒
 * - QRC：`[368,1088]恶(368,151)作(519,136)` —— 与 MRC 同系，故 parseMrc 直接吃（实测解 55 份真载荷）
 * 出口统一成"绝对毫秒 + 标签在文本前"，客户端不必同时懂两套算术。
 *
 * 实测依据（脚本与真机样本在 gitignored 的 my/）：KRC 的 `<start,dur,len>` 第三字段恒为 0，
 * 不能当字节长度用；块粒度由上游决定（`作词：`、`By2` 会整块出现），我们不强行拆到单字。
 */

import zlib from 'node:zlib'
import { qrcDecryptHex } from './qrc-des'

export interface WordLyricWord {
  /** 绝对毫秒 */
  start: number
  end: number
  text: string
}

export interface WordLyricLine {
  start: number
  end: number
  words: WordLyricWord[]
}

export interface WordLyric {
  lines: WordLyricLine[]
  /** `[ti:]`/`[ar:]`/`[hash:]` 这类头标签，键小写；缺失即无该键 */
  headers: Record<string, string>
}

/** KRC 载荷：base64 → 跳过 4 字节 → 16 字节表循环异或 → zlib deflate */
const KRC_XOR_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105]

const LINE_HEAD = /^\[(\d+),(\d+)\]/
/** 嗅探用：KRC 明文首行实测是 `[id:$00000000]`，所以不能锚定行首 */
const TIMED_LINE = /\[\d+,\d+\]/
const KRC_WORD_TAG = /<(\d+),(\d+)(?:,\d+)?>/g
const MRC_WORD_TAG = /\((\d+),(\d+)\)/g
const HEADER_TAG = /^\[([a-zA-Z][a-zA-Z0-9_]*):([^\]]*)\]/

/** 结构闸门阈值，全部来自实测；改之前先重跑 my/krc-granularity-metrics.py */
const MIN_LINES = 8
/** 多数行应被切成 ≥2 块；整行只有一个时间戳的行级歌词在这里露馅（实测有效样本 4.1~7.8 块/行） */
const MIN_MULTI_WORD_RATIO = 0.6
/** 有效样本末行结束时间覆盖我方时长的 93%~95%，残包远低于此 */
const MIN_END_COVERAGE = 0.4

const toMs = (value: string | undefined): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
}

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high)

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function parseHeaders(rows: string[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const raw of rows) {
    const match = HEADER_TAG.exec(raw.trim())
    if (match) headers[match[1].toLowerCase()] = match[2].trim()
  }
  return headers
}

interface RawChunk { start: number; end: number; text: string }

/**
 * 只丢"没有文本"的块（实测 KRC 有零宽标签）。
 * **不能逐块 trim**：英文块的空格是有效内容且带在块尾（实测 `The `、`rain `），
 * trim 后整行会粘成 `Therainfallsonmywindows`。
 */
function buildLine(start: number, end: number, chunks: RawChunk[]): WordLyricLine | null {
  const words: WordLyricWord[] = []
  for (const chunk of chunks) {
    const text = chunk.text.replace(/[\u200b\ufeff]/g, '')
    if (!text) continue
    const wordStart = clamp(chunk.start, start, end)
    words.push({ start: wordStart, end: clamp(chunk.end, wordStart, end), text })
  }
  return words.length ? { start, end, words } : null
}

export function parseKrc(text: string): WordLyric | null {
  const rows = stripBom(text).split(/\r\n|\r|\n/)
  const lines: WordLyricLine[] = []

  for (const raw of rows) {
    const line = raw.trim()
    const head = LINE_HEAD.exec(line)
    if (!head) continue
    const start = toMs(head[1])
    const end = start + toMs(head[2])
    const rest = line.slice(head[0].length)

    KRC_WORD_TAG.lastIndex = 0
    const marks: Array<{ tagAt: number; textStart: number; start: number; dur: number }> = []
    let match: RegExpExecArray | null
    while ((match = KRC_WORD_TAG.exec(rest)) !== null) {
      marks.push({ tagAt: match.index, textStart: match.index + match[0].length, start: start + toMs(match[1]), dur: toMs(match[2]) })
    }
    if (!marks.length) continue

    const chunks: RawChunk[] = marks.map((mark, index) => ({
      start: mark.start,
      end: mark.start + mark.dur,
      text: rest.slice(mark.textStart, index + 1 < marks.length ? marks[index + 1].tagAt : rest.length),
    }))
    // 首个标签之前的文本没有自己的时间，并入第一块（实测未出现，防御性处理）
    const leading = rest.slice(0, marks[0].tagAt)
    if (leading) chunks[0].text = leading + chunks[0].text

    const parsed = buildLine(start, end, chunks)
    if (parsed) lines.push(parsed)
  }

  return lines.length ? { lines, headers: parseHeaders(rows) } : null
}

export function parseMrc(text: string): WordLyric | null {
  const rows = stripBom(text).split(/\r\n|\r|\n/)
  const lines: WordLyricLine[] = []

  for (const raw of rows) {
    const line = raw.trim()
    const head = LINE_HEAD.exec(line)
    if (!head) continue
    const start = toMs(head[1])
    const duration = toMs(head[2])
    // 咪咕的歌名/作词/作曲行实测全是 [0,0] 且字时间全 0，不是正文
    if (!start && !duration) continue
    const end = start + duration
    const rest = line.slice(head[0].length)

    // 标签在文本**后**：`(start,dur)` 管辖它前面、上一标签结束的文本
    MRC_WORD_TAG.lastIndex = 0
    const chunks: RawChunk[] = []
    let cursor = 0
    let match: RegExpExecArray | null
    while ((match = MRC_WORD_TAG.exec(rest)) !== null) {
      chunks.push({ start: toMs(match[1]), end: toMs(match[1]) + toMs(match[2]), text: rest.slice(cursor, match.index) })
      cursor = match.index + match[0].length
    }
    if (!chunks.length) continue
    // 末标签之后的文本（实测多为空白）并入最后一块，避免凭空造时间
    const trailing = rest.slice(cursor)
    if (trailing) chunks[chunks.length - 1].text += trailing

    const parsed = buildLine(start, end, chunks)
    if (parsed) lines.push(parsed)
  }

  return lines.length ? { lines, headers: parseHeaders(rows) } : null
}

/**
 * XML/HTML 实体反转义（三家上游的歌词载荷都用得到：QQ 的 LyricContent 属性、
 * 酷我与 QQ 的 base64 载荷里都见过数字实体）。原先这份逻辑长在 music-lyric 里，
 * 挪到这里是因为逐字解码也要用，而 music-lyric 是本模块的下游。
 */
export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

/**
 * 解 QQ 云端 QRC 家族的载荷：十六进制密文 → 私有 3DES（见 ./qrc-des）→ zlib → 取
 * `LyricContent` 属性 → 反转义。任何一步坏都返回 null，上层据此静默降级成整行。
 * 这里**不**判断是不是逐字，`trans`（译文）走的也是同一套密文但是纯行级，交给调用方定。
 *
 * 外壳实测是 `<QrcInfos><QrcHeadInfo .../><LyricInfo LyricCount="1"><Lyric_1 LyricType="1"
 * LyricContent="[ti:..]\n[起,时长]字(起,时长)..\r\n"/>` —— 属性值里是**真实换行**，收尾紧跟
 * `\r\n"/>`。截尾用 lastIndexOf('"/>') 而不是非贪婪正则：歌词里出现 `"/>` 的可能，远小于
 * 中途截断把末行字切掉的风险；末尾那点空白统一 trim 掉。
 */
export function decryptQrcField(content: string): string | null {
  try {
    const plain = qrcDecryptHex(content)
    if (plain.length < 8) return null
    const xml = zlib.inflateSync(Buffer.from(plain)).toString('utf8')
    const at = xml.indexOf('LyricContent="')
    let text: string
    if (at < 0) {
      text = xml // 实测 trans 字段就是裸正文，没有 XML 外壳
    } else {
      const from = at + 'LyricContent="'.length
      const end = xml.lastIndexOf('"/>')
      text = end > from ? xml.slice(from, end) : xml.slice(from)
    }
    return decodeXmlEntities(text).trim()
  } catch {
    return null
  }
}

/** 逐字用的那层：解出来还必须真有 `[起,时长]` 字级标签 */
export function decodeQrcPayload(content: string): string | null {
  const text = decryptQrcField(content)
  return text && TIMED_LINE.test(text) ? text : null
}

/**
 * 解酷狗 KRC 载荷。任何一步坏都返回 null 而不是抛 —— 上层据此静默降级。
 * 解法与 my/kg_krc_lib.py 同源（Python 版对 14 份真机载荷全部解出），Node 版另在
 * 测试的真机段解了 3 份（含 1 份串台返回的占位载荷）。
 */
export function decodeKrcPayload(content: string): string | null {
  try {
    const raw = Buffer.from(content, 'base64')
    if (raw.length <= 4) return null
    const body = raw.subarray(4)
    for (let i = 0; i < body.length; i++) body[i] ^= KRC_XOR_KEY[i % KRC_XOR_KEY.length]
    const text = zlib.inflateSync(body).toString('utf8')
    return TIMED_LINE.test(text) ? text : null
  } catch {
    return null
  }
}

export interface WordLyricScreenInput {
  /** 我方记录时长（秒）；≤0 或省略则不做跨度校验 */
  durationSeconds?: number
  /** 请求酷狗时用的 FileHash；KRC 头里带 [hash:] 时必须与它一致 */
  expectedFileHash?: string | null
}

export type WordLyricScreenResult = { ok: true; lineCount: number } | { ok: false; reason: string }

const lineText = (line: WordLyricLine): string => line.words.map(word => word.text).join('')

/**
 * 结构闸门：串台比没歌词更糟，任一条不过就整体拒绝，理由进 reason 供日志归因。
 * 实测拦住过的那条酷狗串台返回的是 `纯音乐，请欣赏`（1 行），被"有效行数"挡住。
 */
export function screenWordLyric(lyric: WordLyric, input: WordLyricScreenInput = {}): WordLyricScreenResult {
  const { lines } = lyric
  if (lines.length < MIN_LINES) return { ok: false, reason: `有效行数 ${lines.length} < ${MIN_LINES}` }

  const ratio = lines.filter(line => line.words.length >= 2).length / lines.length
  if (ratio < MIN_MULTI_WORD_RATIO) return { ok: false, reason: `分块行占比 ${(ratio * 100).toFixed(0)}% < 60%，不是逐字` }

  // 归一化自检：时间必须单调且字不早于行，否则宁可不发
  let previousLineStart = -1
  for (const line of lines) {
    if (line.start < previousLineStart) return { ok: false, reason: `行时间倒退 @${line.start}` }
    previousLineStart = line.start
    let previousWordStart = -1
    for (const word of line.words) {
      if (word.start < line.start) return { ok: false, reason: `首字早于行时间 @${line.start}/${word.start}` }
      if (word.start < previousWordStart) return { ok: false, reason: `字时间倒退 @${word.start}` }
      previousWordStart = word.start
    }
  }

  // [hash:] 存在才校验：实测 14 条真机样本里 10 条没这个字段，缺失不能当否决
  const headerHash = lyric.headers.hash
  if (headerHash && input.expectedFileHash && headerHash.toUpperCase() !== input.expectedFileHash.toUpperCase()) {
    return { ok: false, reason: `KRC 内 hash ${headerHash.slice(0, 8)}… ≠ 请求 FileHash ${String(input.expectedFileHash).slice(0, 8)}…` }
  }

  if (input.durationSeconds && input.durationSeconds > 0) {
    const expectedMs = input.durationSeconds * 1000
    const lastEnd = lines[lines.length - 1].end
    if (lastEnd < expectedMs * MIN_END_COVERAGE) {
      return { ok: false, reason: `末行 ${lastEnd}ms 仅覆盖时长的 ${(lastEnd / expectedMs * 100).toFixed(0)}%` }
    }
  }

  return { ok: true, lineCount: lines.length }
}

/** 跨源借逐字时的本地行：只用到行起点与整行文本（毫秒） */
export interface LocalLyricLine {
  start: number
  text: string
}

export interface AlignOptions {
  /** 行文本对齐率下限（借来的行数与本地行数按顺序能配上的比例） */
  minAlignRate?: number
  /** 允许的整体时间差上限（毫秒）；超过说明不是同一份时间轴 */
  maxMedianShiftMs?: number
}

export type AlignResult =
  | { ok: true; lyric: WordLyric; alignRate: number; medianShiftMs: number }
  | { ok: false; reason: string }

const normalizeLineText = (value: string): string => value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')

/**
 * 把"从兄弟源借来的逐字"挂到"正在播的那个源自己的行时间"上。
 *
 * 关键是 KRC 的字时间本来就是**行内相对偏移**，所以借的时候不平移绝对时间轴，
 * 而是保留行内相对量、把行起点换成本地行起点 —— 逐字天然与本行对齐，行级文本
 * 一个字都不用改（车机/锁屏岛那条"必须是纯行级 LRC"的红线因此不受影响）。
 *
 * 借不借由数据说了算：按顺序配对行文本（副歌重复行必须按出现顺序配，
 * 用文本首现映射会把 20 秒的那句配到 200 秒上，造出上百秒的假偏移），
 * 对齐率和整体时间差两道闸门过不了就返回 null。
 * 配不上的行退化成"整行一个块"，行数与本地完全一致，客户端同源校验仍成立。
 */
export function alignWordLyricToLines(borrowed: WordLyric, local: LocalLyricLine[], options: AlignOptions = {}): AlignResult {
  const minAlignRate = options.minAlignRate ?? 0.7
  const maxMedianShiftMs = options.maxMedianShiftMs ?? 300
  if (!local.length) return { ok: false, reason: '本地整行歌词为空' }
  const pool = borrowed.lines
    .map(line => ({ line, key: normalizeLineText(line.words.map(word => word.text).join('')) }))
    .filter(item => item.key)
  if (!pool.length) return { ok: false, reason: '借来的歌词没有可配对的行' }

  const picked: (WordLyricLine | null)[] = []
  const shifts: number[] = []
  let cursor = 0
  for (const line of local) {
    const key = normalizeLineText(line.text)
    let hit = -1
    if (key) {
      for (let j = cursor; j < pool.length && j < cursor + 12; j++) {
        if (pool[j].key === key) { hit = j; break }
      }
    }
    if (hit < 0) { picked.push(null); continue }
    picked.push(pool[hit].line)
    shifts.push(line.start - pool[hit].line.start)
    cursor = hit + 1
  }

  const alignRate = shifts.length / local.length
  if (alignRate < minAlignRate) return { ok: false, reason: `行对齐率 ${(alignRate * 100).toFixed(0)}% < ${(minAlignRate * 100).toFixed(0)}%（可能不是同一版本）` }
  const sorted = [...shifts].sort((a, b) => a - b)
  const medianShiftMs = sorted[Math.floor(sorted.length / 2)]
  if (Math.abs(medianShiftMs) > maxMedianShiftMs) return { ok: false, reason: `整体时间差 ${medianShiftMs}ms 超出 ±${maxMedianShiftMs}ms` }

  const lines: WordLyricLine[] = local.map((line, index) => {
    // 行尾取下一行的起点；末行按 5s 兜底。至少留 250ms，避免相邻行挤成零宽
    const end = index + 1 < local.length
      ? Math.max(line.start + 250, local[index + 1].start)
      : line.start + 5000
    const source = picked[index]
    if (!source) return { start: line.start, end, words: [{ start: line.start, end, text: line.text.trim() }] }
    const rels = source.words.map(word => word.start - source.start)
    const words = source.words
      .map((word, k) => {
        const start = clamp(line.start + rels[k], line.start, end)
        const nextRel = k + 1 < rels.length ? rels[k + 1] : rels[k] + 1
        return { start, end: clamp(line.start + Math.max(nextRel, rels[k]), start, end), text: word.text }
      })
      .filter(word => word.text)
    return { start: line.start, end, words: words.length ? words : [{ start: line.start, end, text: line.text.trim() }] }
  })

  return { ok: true, lyric: { lines, headers: {} }, alignRate, medianShiftMs }
}

function formatTimestamp(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds))
  const minutes = Math.floor(total / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(total % 1000).padStart(3, '0')}`
}

/**
 * 头标签按白名单带上：行级文本会落进 `.lrc` sidecar，而下载打标的 LYRICS 就读它，
 * 静默丢掉 [ti:]/[ar:] 会让文件里的歌词比改动前少信息。KRC 内部的 [id:]/[hash:]/
 * [total:]/[language:] 属实现细节，不透传。
 *
 * 两个序列化都带同一份头，**[offset:] 尤其关键**：客户端对行级和逐字都套用这个偏移，
 * 只有一侧带就会导致两侧时间不一致，逐字被判定为不可用而退化成整行。
 */
const PLAIN_LRC_HEADER_ORDER = ['ti', 'ar', 'al', 'by', 'offset']

function renderHeaders(lyric: WordLyric): string[] {
  return PLAIN_LRC_HEADER_ORDER
    .filter(key => lyric.headers[key])
    .map(key => `[${key}:${lyric.headers[key]}]`)
}

/**
 * 增强 LRC：行首 `[mm:ss.xxx]`，每块文本前跟它的绝对起始，行尾再补一个结束时间。
 * 只给起始不给时长：实测相邻块满足「下一块 start == 上一块 start+dur」，末块由行尾收口。
 */
export function toEnhancedLrc(lyric: WordLyric): string {
  const body = lyric.lines.map(line => {
    const words = line.words.map(word => `<${formatTimestamp(word.start)}>${word.text}`).join('')
    return `[${formatTimestamp(line.start)}]${words}<${formatTimestamp(line.end)}>`
  }).join('\n')
  return [...renderHeaders(lyric), body].join('\n')
}

/**
 * 与增强 LRC **同源**的行级文本。必须出自同一次解析：实测同一首 KRC 的行时间与酷狗
 * 另一条 fmt=lrc 通道差 10ms 级（青花瓷 16 行、Come Back To Me 42 行），混用会让高亮抖。
 */
export function toPlainLrc(lyric: WordLyric): string {
  const body = lyric.lines
    .map(line => `[${formatTimestamp(line.start)}]${lineText(line).trim()}`)
    .join('\n')
  return [...renderHeaders(lyric), body].join('\n')
}

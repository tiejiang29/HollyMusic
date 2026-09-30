/**
 * 客户端 LRC 歌词解析（时间单位：秒）
 */

export interface LrcWord {
  time: number // 秒，该字（块）的绝对起始
  text: string
}

export interface LrcLine {
  time: number // 秒
  text: string
  /** 逐字（增强 LRC）才有；整行歌词为 undefined */
  words?: LrcWord[]
  /** 行结束时间（秒），来自增强 LRC 行尾的收尾时间戳 */
  endTime?: number
}

const LRC_TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const LRC_OFFSET_TAG = /\[offset:\s*(-?\d+)\]/i
/** 增强 LRC 的字标签：<mm:ss.xxx>，与行标签同格式，只是用尖括号 */
const LRC_WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g

/**
 * 解析 LRC 文本为按时间升序的行数组。
 * - 支持一行多时间标签
 * - 解析全局 [offset:] 偏移（毫秒，正数提前）
 * - 忽略 [ti:]/[ar:]/[al:]/[by:] 等 ID 标签
 */
export function parseLrc(lrcText: string | null | undefined): LrcLine[] {
  if (!lrcText) return []

  const offsetMatch = LRC_OFFSET_TAG.exec(lrcText)
  const offsetMs = offsetMatch ? parseInt(offsetMatch[1], 10) || 0 : 0

  const tagStrip = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g
  const lines: LrcLine[] = []

  for (const raw of lrcText.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line) continue

    LRC_TIME_TAG.lastIndex = 0
    const times: number[] = []
    let m: RegExpExecArray | null
    while ((m = LRC_TIME_TAG.exec(line)) !== null) {
      const min = parseInt(m[1], 10) || 0
      const sec = parseInt(m[2], 10) || 0
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) || 0 : 0
      times.push(min * 60 + sec + frac / 1000)
    }
    if (times.length === 0) continue

    const text = line.replace(tagStrip, '').trim()
    if (!text) continue
    for (const t of times) lines.push({ time: Math.max(0, t + offsetMs / 1000), text })
  }

  lines.sort((a, b) => a.time - b.time)
  return lines
}

const tagToSeconds = (m: RegExpExecArray): number =>
  parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + (m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0)

/**
 * 解析增强 LRC（逐字）：行首 `[mm:ss.xxx]`，每块文本前一个 `<mm:ss.xxx>` 起始，
 * 行尾那个后面没有文本的 `<mm:ss.xxx>` 是行结束时间。
 *
 * 只解析逐字，不合并行：调用方拿到 words 后自行决定渲染粒度；没有逐字标签的行
 * 返回空数组，由调用方回落到 parseLrc 的整行结果。
 */
export function parseEnhancedLrc(lrcText: string | null | undefined): LrcLine[] {
  if (!lrcText) return []
  const offsetMatch = LRC_OFFSET_TAG.exec(lrcText)
  const offsetSec = offsetMatch ? (parseInt(offsetMatch[1], 10) || 0) / 1000 : 0
  const lines: LrcLine[] = []

  for (const raw of lrcText.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    const head = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(line)
    if (!head) continue
    const rest = line.slice(head[0].length)
    LRC_WORD_TAG.lastIndex = 0
    const marks: Array<{ time: number; textStart: number; tagStart: number }> = []
    let m: RegExpExecArray | null
    while ((m = LRC_WORD_TAG.exec(rest)) !== null) {
      marks.push({ time: tagToSeconds(m), textStart: m.index + m[0].length, tagStart: m.index })
    }
    if (!marks.length) continue

    // 末尾那个标签后面没有文本 = 行结束时间，不是一个字
    const last = marks[marks.length - 1]
    const isTrailingEnd = last.textStart >= rest.length
    const wordMarks = isTrailingEnd ? marks.slice(0, -1) : marks
    if (!wordMarks.length) continue
    // 最后一个字的文本终点是行尾标签的起点，不能一路取到行末（否则把 `<mm:ss>` 当正文吃进来）
    const textLimit = isTrailingEnd ? last.tagStart : rest.length

    const words = wordMarks.map((mark, i) => ({
      time: Math.max(0, mark.time + offsetSec),
      // 不逐块 trim：英文块的空格是有效内容且带在块尾，去掉整行就粘成一坨
      text: rest.slice(mark.textStart, i + 1 < wordMarks.length ? wordMarks[i + 1].tagStart : textLimit).replace(/[\u200b\ufeff]/g, ''),
    })).filter(word => word.text)
    const text = words.map(word => word.text).join('').trim()
    if (!text) continue

    lines.push({
      time: Math.max(0, tagToSeconds(head) + offsetSec),
      text,
      endTime: isTrailingEnd ? Math.max(0, last.time + offsetSec) : undefined,
      words,
    })
  }

  lines.sort((a, b) => a.time - b.time)
  return lines
}

/**
 * 纯文本歌词回退：tx/kw/mg 等音源常返回无时间轴文本（[!text] 前缀整体纯文本）， * parseLrc 会全部丢弃导致「暂无歌词」。这里按行展示，time 置 NaN——
 * findActiveLineIndex 的比较对 NaN 恒为 false，永不高亮/滚动跟随。
 */
export function parsePlainText(lrcText: string | null | undefined): LrcLine[] {
  if (!lrcText) return []
  const lines: LrcLine[] = []
  for (const raw of lrcText.split(/\r\n|\r|\n/)) {
    const line = raw.trim().replace(/^\[!text\]/i, '').trim()
    if (line) lines.push({ time: Number.NaN, text: line })
  }
  return lines
}

/**
 * 二分查找当前时间对应的歌词行索引（time <= currentTime 的最后一行）。
 */
export function findActiveLineIndex(lines: LrcLine[], currentTime: number): number {
  if (lines.length === 0) return -1
  let lo = 0
  let hi = lines.length - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].time <= currentTime) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

/**
 * 当前应高亮到第几个字：words[i].time <= currentTime 的最后一块。
 * 一行的块数只有几十个，线性扫描比分治更划算。
 */
export function findActiveWordIndex(line: LrcLine | undefined, currentTime: number): number {
  const words = line?.words
  if (!words?.length || !Number.isFinite(currentTime)) return -1
  let index = -1
  for (let i = 0; i < words.length; i++) {
    if (words[i].time <= currentTime) index = i
    else break
  }
  return index
}

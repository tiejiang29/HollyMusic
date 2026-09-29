/**
 * 下载交付侧的"换链头"工具。
 *
 * 只在**文件已在本地**时可用：必须在响应头发出之前把 Content-Length 算准，而算准需要
 * 先读旧链头的长度 —— 缓存 miss 时字节还在跟随回源进度产出，读不到完整块链，就不该改写。
 *
 * 铁律：不改磁盘上的缓存原件。audioServe 的长度取自 DB 的 `record.size` 且从不重新
 * `stat()`，文件一变长，`Content-Length` 与所有 Range 边界就整体错位。
 */

import { createReadStream } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { readFlacChain, rewriteFlacHead, FLAC_MAX_HEAD_BYTES } from './audio-tag'

export interface TagPlan {
  container: 'flac'
  /** 替换进去的新链头（含 'fLaC' 魔数） */
  newHead: Buffer
  /** 原文件中音频字节的起点 = 旧链末尾 */
  audioStart: number
  /** 打开时的原文件长度，交付区间右界（原件可能比记账长度长，必须按记账长度收口） */
  fileSize: number
  /** 我们要交付的总长度 */
  totalLength: number
}

export interface TagSkip {
  reason: string
}

/**
 * @param fileSize 交付的原始总长度（缓存走 DB 的 record.size，库正本走 fstat.size），
 *                 与磁盘真实大小不一致时以它为准收口，保证 Content-Length 与实际字节相等
 */
export async function planTaggedDelivery(
  filePath: string,
  fileSize: number,
  fields: Record<string, string | null | undefined>,
  picture?: { mime: string; data: Buffer } | null,
): Promise<TagPlan | TagSkip> {
  const ext = path.extname(filePath).toLowerCase()
  if (ext !== '.flac') return { reason: `容器 ${ext || '未知'} 本轮不改写（MP3/ID3v2 是第二阶段）` }
  if (!Number.isFinite(fileSize) || fileSize <= 0) return { reason: `长度不可信：${fileSize}` }

  let handle
  try {
    handle = await openFile(filePath, 'r')
  } catch {
    return { reason: '文件打不开' }
  }
  try {
    const buf = Buffer.alloc(Math.min(FLAC_MAX_HEAD_BYTES, fileSize))
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    const head = buf.subarray(0, bytesRead)

    const chain = readFlacChain(head)
    if (!chain.ok) return { reason: `块链不可解析：${chain.reason}` }

    const r = rewriteFlacHead(head.subarray(0, chain.audioStart), fields, picture)
    if (!r.ok) return { reason: `链头重写失败：${r.reason}` }

    return {
      container: 'flac',
      newHead: r.newHead,
      audioStart: chain.audioStart,
      fileSize,
      totalLength: fileSize + r.delta,
    }
  } catch (err) {
    return { reason: `预读异常：${err instanceof Error ? err.message : String(err)}` }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * 交付流 = 新链头 ‖ 原文件从 audioStart 起的字节，但**按"改写后的字节空间"寻址**：
 * 参数 [start, end] 是客户端看到的偏移（含端点），内部映射成
 * "新链头的一段 + 原文件 [audioStart + (start-newHeadLen), …] 的一段"。
 *
 * 为什么要支持分片而不是只支持整文件：续传请求若走"未改写的原件"，就会把
 * 打过标签的前半和没打的后半拼在一起，两边偏移差着链头增量 → 静默产出坏文件。
 * 右界也一律按 `fileSize` 收口（不是文件真实大小），否则 Content-Length 会小于实际字节数。
 */
export function createTaggedFileRead(
  filePath: string,
  plan: TagPlan,
  start = 0,
  end = plan.totalLength - 1,
): Readable {
  const headLen = plan.newHead.length
  const lastFileByte = plan.fileSize - 1

  const headFrom = Math.min(Math.max(start, 0), headLen)
  const headTo = Math.min(Math.max(end + 1, 0), headLen)
  const headSlice = plan.newHead.subarray(headFrom, headTo)

  const crossesIntoTail = end >= headLen
  const tailFrom = plan.audioStart + Math.max(start - headLen, 0)
  const tailTo = Math.min(plan.audioStart + (end - headLen + 1) - 1, lastFileByte)

  return Readable.from((async function* () {
    if (headSlice.length) yield headSlice
    if (!crossesIntoTail || tailTo < tailFrom) return
    const tail = createReadStream(filePath, { start: tailFrom, end: tailTo })
    try {
      for await (const chunk of tail) yield chunk
    } finally {
      tail.destroy()
    }
  })())
}

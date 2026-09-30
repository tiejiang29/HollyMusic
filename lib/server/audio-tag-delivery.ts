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
import {
  readFlacChain, rewriteFlacHead, FLAC_MAX_HEAD_BYTES,
  readMp3Layout, buildId3v2Tag, MP3_MAX_HEAD_BYTES,
} from './audio-tag'

/** 尾部探测窗口：够覆盖 ID3v1(128) 与 APEv2 页脚(32) */
const TAIL_SCAN_BYTES = 512

export interface TagPlan {
  container: 'flac' | 'mp3'
  /** 替换进去的新头部：FLAC 是 `fLaC`+块链，MP3 是一整份 ID3v2 */
  newHead: Buffer
  /** 原文件中音频字节的起点（MP3 = 第一个帧的偏移；FLAC = 旧链末尾） */
  audioStart: number
  /** 打开时的原文件长度，交付区间右界（原件可能比记账长度长，必须按记账长度收口） */
  fileSize: number
  /** 原文件里**最后一个还属于音频的字节**下标 = fileSize-1-tailTrim */
  fileLastByte: number
  /** 被裁掉的尾部字节数（ID3v1；FLAC 恒为 0） */
  tailTrim: number
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
  const container = ext === '.flac' ? 'flac' : ext === '.mp3' ? 'mp3' : null
  if (!container) return { reason: `容器 ${ext || '未知'} 不改写（只处理 .flac / .mp3）` }
  if (!Number.isFinite(fileSize) || fileSize <= 0) return { reason: `长度不可信：${fileSize}` }

  let handle
  try {
    handle = await openFile(filePath, 'r')
  } catch {
    return { reason: '文件打不开' }
  }
  try {
    const headCap = container === 'flac' ? FLAC_MAX_HEAD_BYTES : MP3_MAX_HEAD_BYTES
    const buf = Buffer.alloc(Math.min(headCap, fileSize))
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    const head = buf.subarray(0, bytesRead)

    const tailLen = Math.min(TAIL_SCAN_BYTES, fileSize)
    const tailBuf = Buffer.alloc(tailLen)
    const { bytesRead: tailRead } = await handle.read(tailBuf, 0, tailLen, fileSize - tailLen)
    const tail = tailBuf.subarray(0, tailRead)

    if (container === 'flac') {
      const chain = readFlacChain(head)
      if (!chain.ok) return { reason: `块链不可解析：${chain.reason}` }
      const r = rewriteFlacHead(head.subarray(0, chain.audioStart), fields, picture)
      if (!r.ok) return { reason: `链头重写失败：${r.reason}` }
      return {
        container: 'flac',
        newHead: r.newHead,
        audioStart: chain.audioStart,
        fileSize,
        tailTrim: 0,
        fileLastByte: fileSize - 1,
        totalLength: fileSize + r.delta,
      }
    }

    const layout = readMp3Layout(head, tail)
    if (!layout.ok) return { reason: `MP3 结构不可改写：${layout.reason}` }
    const built = buildId3v2Tag(fields, picture)
    if (!built.ok) return { reason: `ID3v2 生成失败：${built.reason}` }

    const fileLastByte = fileSize - 1 - layout.tailTrim
    return {
      container: 'mp3',
      newHead: built.tag,
      audioStart: layout.audioStart,
      fileSize,
      tailTrim: layout.tailTrim,
      fileLastByte,
      totalLength: built.tag.length + (fileLastByte - layout.audioStart + 1),
    }
  } catch (err) {
    return { reason: `预读异常：${err instanceof Error ? err.message : String(err)}` }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * 交付流 = 新头部 ‖ 原文件 `[audioStart, fileLastByte]`，但**按"改写后的字节空间"寻址**：
 * 参数 [start, end] 是客户端看到的偏移（含端点），内部映射成
 * "新头部的一段 + 原文件对应的一段"。
 *
 * 为什么要支持分片而不是只支持整文件：续传请求若走"未改写的原件"，就会把
 * 打过标签的前半和没打的后半拼在一起，两边偏移差着头部增量 → 静默产出坏文件。
 * 右界一律按 `fileLastByte`（已扣掉 ID3v1）收口，否则 Content-Length 会小于实际字节数。
 */
export function createTaggedFileRead(
  filePath: string,
  plan: TagPlan,
  start = 0,
  end = plan.totalLength - 1,
): Readable {
  const headLen = plan.newHead.length

  const headFrom = Math.min(Math.max(start, 0), headLen)
  const headTo = Math.min(Math.max(end + 1, 0), headLen)
  const headSlice = plan.newHead.subarray(headFrom, headTo)

  const crossesIntoTail = end >= headLen
  const tailFrom = plan.audioStart + Math.max(start - headLen, 0)
  const tailTo = Math.min(plan.audioStart + (end - headLen + 1) - 1, plan.fileLastByte)

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

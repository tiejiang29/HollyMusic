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
 * 交付流 = 新链头 ‖ 原文件从 audioStart 到 fileSize-1 的字节。
 * 右界必须显式给：只按 start 读会跑到文件真实末尾，长度就和 Content-Length 不符了。
 */
export function createTaggedFileRead(filePath: string, plan: TagPlan): Readable {
  return Readable.from((async function* () {
    yield plan.newHead
    const tail = createReadStream(filePath, { start: plan.audioStart, end: plan.fileSize - 1 })
    try {
      for await (const chunk of tail) yield chunk
    } finally {
      tail.destroy()
    }
  })())
}

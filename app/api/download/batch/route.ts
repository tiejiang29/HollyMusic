import { NextRequest, NextResponse } from 'next/server'
import { Readable } from 'stream'
import { ZipArchive } from 'archiver'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { logger } from '@/lib/logger'
import { resolveMusicInfoById } from '@/lib/db'
import { musicSourceManager } from '@/lib/music-source-manager'
import { audioServe } from '@/lib/audio-serve'
import { cacheNativeLyricForMusic } from '@/lib/services/lyrics'
import { parseIntervalToSeconds } from '@/lib/types/player'
import { buildFilenameFromMusicInfo, buildContentDisposition, sanitizeFilename } from '@/lib/server/download-utils'
import { resolveQuality } from '@/lib/quality-options'
import type { QualityType } from '@/lib/types/music'

/**
 * 批量下载 API（ZIP 流式打包）
 * GET /api/download/batch?uids=a,b,c&quality=320k
 *
 * 设计：
 * - GET + window.location.href 触发（与单曲下载一致，规避 transient user activation），
 *   uids 走查询参数（≤100 首，URL 长度安全）
 * - 逐首串行：命中磁盘缓存直接读盘，未命中回源下载并落盘（多用户共享缓存）
 * - ZIP store 模式：音频本身已压缩，不再 deflate，CPU 零开销
 * - archiver 边收边输出，Response 流式回传，浏览器原生下载管理器接管进度
 * - 同用户同时只允许一个打包任务（429），防止叠加回源
 * - 部分歌曲失败不中断整体：结束后附「下载失败清单.txt」
 */

const MAX_BATCH = 100
const VALID_QUALITIES = new Set(['128k', '320k', 'flac', 'flac24bit'])

/** 用户级打包并发锁 */
const busyUsers = new Set<string>()

export async function GET(request: NextRequest) {
  let username = ''
  try {
    const user = await requireUser(request)
    username = user.username
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 })
    }
    throw err
  }

  if (busyUsers.has(username)) {
    return NextResponse.json({ error: '已有打包任务进行中，请等待完成后再试' }, { status: 429 })
  }

  const params = new URL(request.url).searchParams
  const uids = [...new Set((params.get('uids') || '').split(',').map(s => s.trim()).filter(Boolean))]
  const qualityParam = params.get('quality') || '320k'
  if (!VALID_QUALITIES.has(qualityParam)) {
    return NextResponse.json({ error: '不支持的音质' }, { status: 400 })
  }
  const preference: QualityType = qualityParam as QualityType

  if (uids.length === 0) {
    return NextResponse.json({ error: '缺少 uids 参数' }, { status: 400 })
  }
  if (uids.length > MAX_BATCH) {
    return NextResponse.json({ error: `单次最多打包 ${MAX_BATCH} 首` }, { status: 400 })
  }

  // 预解析歌曲信息：全部找不到则直接拒绝（部分找不到则跳过）
  const songs = (
    await Promise.all(uids.map(async uid => ({ uid, musicInfo: await resolveMusicInfoById(uid) })))
  ).filter((s): s is { uid: string; musicInfo: NonNullable<Awaited<ReturnType<typeof resolveMusicInfoById>>> } => {
    if (!s.musicInfo) logger.warn(`[download/batch] uid 未找到，跳过: ${s.uid}`)
    return Boolean(s.musicInfo)
  })
  if (songs.length === 0) {
    return NextResponse.json({ error: '找不到任何歌曲信息' }, { status: 404 })
  }

  if (!musicSourceManager.isInitialized()) {
    await musicSourceManager.initialize()
  }
  await audioServe.ensureInitialized()

  // store 模式：音频本身已压缩，不再 deflate，CPU 零开销
  const archive = new ZipArchive({ store: true })
  busyUsers.add(username)
  const release = () => busyUsers.delete(username)
  archive.once('close', release)
  archive.once('end', release)
  archive.once('error', (err: unknown) => {
    logger.error('[download/batch] archiver error:', err)
    release()
  })

  // 后台逐首取流并追加进 zip（不 await：先把流式 Response 返回给客户端）
  void (async () => {
    const usedNames = new Set<string>()
    const failed: string[] = []

    for (const song of songs) {
      const mi = song.musicInfo
      // 与单曲下载一致：按歌曲可用音质对偏好就近降级
      const quality: QualityType = resolveQuality(preference, mi.types)
      try {
        const cacheKey = `${mi.source}:${mi.songmid}:${quality}`
        const resp = await audioServe.serve({
          cacheKey,
          upstreamUrlResolver: () => musicSourceManager.getMusicUrl(mi, quality),
          rangeHeader: null,
          isHead: false,
          intervalSec: parseIntervalToSeconds(mi.interval),
          onCached: () => cacheNativeLyricForMusic(mi),
        })
        if (!resp.ok || !resp.body) {
          failed.push(`${buildFilenameFromMusicInfo(mi, quality)}（HTTP ${resp.status}）`)
          continue
        }
        // 文件名去重：同名追加序号
        let name = sanitizeFilename(buildFilenameFromMusicInfo(mi, quality))
        let counter = 2
        while (usedNames.has(name)) {
          const dot = name.lastIndexOf('.')
          name = `${name.slice(0, dot)}(${counter})${name.slice(dot)}`
          counter++
        }
        usedNames.add(name)

        // 等本首写完再取下一首：限制上游并发为 1，内存占用最小
        const entryDone = new Promise<void>(resolve => archive.once('entry', resolve))
        archive.append(Readable.fromWeb(resp.body as import('stream/web').ReadableStream), { name })
        await entryDone
      } catch (err) {
        failed.push(`${buildFilenameFromMusicInfo(mi, quality)}（${err instanceof Error ? err.message : '获取失败'}）`)
      }
    }

    if (failed.length > 0) {
      archive.append(Buffer.from(`以下 ${failed.length} 首打包失败：\n${failed.join('\n')}\n`, 'utf-8'), {
        name: '下载失败清单.txt',
      })
    }
    logger.info(`[download/batch] 完成: ${songs.length - failed.length}/${songs.length} 首 user=${username}`)
    await archive.finalize()
  })().catch(err => {
    logger.error('[download/batch] 打包流程异常:', err)
    archive.abort?.()
  })

  const zipName = `hollymusic-${songs.length}首-${new Date().toISOString().slice(0, 10)}.zip`
  return new NextResponse(Readable.toWeb(archive) as unknown as ReadableStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': buildContentDisposition(zipName),
      'Cache-Control': 'no-store',
    },
  })
}

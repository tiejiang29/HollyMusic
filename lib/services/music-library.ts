/**
 * 音乐库服务：边听边下的持久化正本层。
 *
 * 架构（2026-09 设计，与用户讨论定案）：
 * - 单卷双目录：cache/（audio-serve 中转区）+ library/（正本，歌手/专辑两级目录）
 * - 下载完成 + 完整性校验通过 → ingestFromCache：去重检查（同录音更高音质已存在则放弃）
 *   → 配额检查（默认 20G，满则跳过并提示）→ rename 原子移入 library/ + 写登记表
 *   + 删除 cache 侧记录/文件（cache 只剩进行中的下载，配额失去意义故不再关心）
 * - 一首录音只留一份：dedupeKey（归一化歌名|主歌手）+ 时长容差 ±4s 判定同一录音；
 *   更高音质到达时替换低档文件；跨平台（wy/kg/tx…）同录音复用同一文件
 * - 播放本地优先：uid 精确命中 → dedupeKey+时长模糊命中（跨平台）→ cache/旧缓存 → 在线
 * - 多歌手：实体存主歌手目录，浏览页按完整 singer 串筛选（文件系统不做链接）
 *
 * 环境变量：
 * - AUDIO_LIBRARY_DIR       库根目录（默认 data/library）
 * - AUDIO_LIBRARY_QUOTA_GB  库配额 GB（默认 20，最小 1）
 */

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { prisma, getStorageSongmidForMusicInfo } from '@/lib/db'
import type { LibrarySong } from '@/lib/generated/prisma'
import { logger } from '@/lib/logger'
import { checkTrialAudio } from '@/lib/server/audio-integrity'
import { getAudioServeConfig, buildFullResponse, buildPartialResponse, buildUnsatisfiable, parseRange, removeAudioCacheFiles } from '@/lib/audio-serve'
import { sanitizeFilename, extForQuality } from '@/lib/server/download-utils'
import { QUALITY_ORDER, getAvailableQualities } from '@/lib/quality-options'
import type { QualityInfo } from '@/lib/types/music'
import type { MusicInfo, QualityType } from '@/lib/types/music'
import { parseIntervalToSeconds } from '@/lib/types/player'

// ============================================================================
// 配置
// ============================================================================

export interface MusicLibraryConfig {
  libraryDir: string
  quotaBytes: number
}

let cachedCfg: MusicLibraryConfig | null = null

export function getLibraryConfig(): MusicLibraryConfig {
  if (cachedCfg) return cachedCfg
  const quotaGbRaw = process.env.AUDIO_LIBRARY_QUOTA_GB
  let quotaGb = 20
  if (quotaGbRaw) {
    const n = Number(quotaGbRaw)
    if (Number.isFinite(n) && n >= 1) quotaGb = Math.floor(n)
  }
  cachedCfg = {
    libraryDir: process.env.AUDIO_LIBRARY_DIR?.trim() || path.resolve(process.cwd(), 'data/library'),
    quotaBytes: quotaGb * 1024 * 1024 * 1024,
  }
  return cachedCfg
}

/** 库满标志：ingest 失败时置位，成功后复位；供 /api/library/stats 展示 */
let libraryFull = false

// ============================================================================
// 去重键 / 目录命名
// ============================================================================

/** 归一化：去 HTML 实体残留、合并空白（用于跨平台同名判定） */
function normalizeText(s: string | undefined): string {
  return (s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

/** 主歌手：按分隔符切分取第一个，再剥掉尾部 feat./ft. 标注。
 *  注意不能用懒惰正则 + $ 锚定的写法——"灯叔、方大树"这类串会整体匹配失败
 *  回退成完整串，导致目录名/去重键变成合并歌手名。 */
function primarySinger(singer: string): string {
  const normalized = normalizeText(singer)
  if (!normalized) return '未知歌手'
  const first = normalized
    .split(/[、,，/／&\uFF06;；]/)[0]
    .replace(/\s*(?:feat|ft)\..*$/i, '')
    .trim()
  return first || '未知歌手'
}

function buildDedupeKey(name: string, singer: string): string {
  return `${normalizeText(name).toLowerCase()}|${primarySinger(singer).toLowerCase()}`
}

function qualityRank(q: string): number {
  const i = QUALITY_ORDER.indexOf(q as QualityType)
  return i === -1 ? QUALITY_ORDER.length : i
}

function contentTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
  }
  return map[ext] || 'audio/mpeg'
}

/** 目录名 sanitize：复用文件名规则（保留中文，去非法字符，限长） */
function sanitizeDirName(s: string): string {
  return sanitizeFilename(s, 80) || 'unknown'
}

// ============================================================================
// 入库（audio-serve onCached 后台任务调用）
// ============================================================================

export interface IngestResult {
  status: 'ingested' | 'skip-lower' | 'skip-quota' | 'skip-error'
  message?: string
}

/**
 * 把 cache/ 中已完成的文件移入音乐库。
 * 调用时机：audio-serve 下载完成且试听校验通过后的 post-cache 后台任务。
 * 任何失败不影响播放（文件留在 cache/ 继续当缓存用）。
 */
export async function ingestFromCache(cacheKey: string, musicInfo: MusicInfo, quality: QualityType): Promise<IngestResult> {
  try {
    const record = await prisma.audioCache.findUnique({ where: { cacheKey } })
    if (!record || !record.size) return { status: 'skip-error', message: '缓存记录不存在' }

    const srcPath = path.join(getAudioServeConfig().cacheDir, record.filePath)
    const srcStat = await fsp.stat(srcPath).catch(() => null)
    if (!srcStat) return { status: 'skip-error', message: '缓存文件不存在' }

    // 实际时长（试听校验会再跑一遍，取 actualSec；拿不到退回元数据 interval）
    const intervalSec = parseIntervalToSeconds(musicInfo.interval)
    const trialCheck = await checkTrialAudio(srcPath, intervalSec || 0)
    if (trialCheck.trial) return { status: 'skip-error', message: '试听片段，不入库' }
    const durationSec = trialCheck.actualSec || intervalSec || 0

    const dedupeKey = buildDedupeKey(musicInfo.name, musicInfo.singer)

    // 去重：同 key 候选中时长容差 ±4s 视为同一录音
    const candidates = await prisma.librarySong.findMany({ where: { dedupeKey } })
    const sameRecording = candidates.filter(row => Math.abs(row.durationSec - durationSec) <= 4)

    // 已有同录音的更高或同档音质 → 放弃入库（新文件留在 cache/ 当缓存）
    if (sameRecording.some(row => qualityRank(row.quality) <= qualityRank(quality))) {
      return { status: 'skip-lower', message: '库内已有更高音质' }
    }

    // 配额检查
    const cfg = getLibraryConfig()
    const agg = await prisma.librarySong.aggregate({ _sum: { fileSize: true } })
    const usedBytes = agg._sum.fileSize || 0
    if (usedBytes + srcStat.size > cfg.quotaBytes) {
      libraryFull = true
      logger.warn(
        `[music-library] 配额已满，跳过入库: ${musicInfo.name} ` +
          `used=${(usedBytes / 1024 / 1024 / 1024).toFixed(2)}GB quota=${(cfg.quotaBytes / 1024 / 1024 / 1024).toFixed(0)}GB`
      )
      return { status: 'skip-quota', message: '音乐库配额已满' }
    }

    // 目标路径：library/主歌手/专辑|other/歌手 - 歌名.ext
    const albumDir = sanitizeDirName(normalizeText(musicInfo.albumName) || 'other')
    const singerDir = sanitizeDirName(primarySinger(musicInfo.singer))
    const destDir = path.join(cfg.libraryDir, singerDir, albumDir)
    await fsp.mkdir(destDir, { recursive: true })

    let destName = sanitizeFilename(`${normalizeText(musicInfo.singer)} - ${normalizeText(musicInfo.name)}${extForQuality(quality)}`)
    // 同名冲突：同录音（将替换）外，追加序号
    const replacingIds = sameRecording.map(r => r.id)
    const nameTaken = async (n: string) => {
      const exists = await fsp.stat(path.join(destDir, n)).then(() => true).catch(() => false)
      if (!exists) return false
      const row = await prisma.librarySong.findUnique({ where: { filePath: path.join(destDir, n) } })
      // 属于将被替换的同录音条目 → 视为可用（写入时覆盖）
      return !row || !replacingIds.includes(row.id)
    }
    let counter = 2
    while (await nameTaken(destName)) {
      const dot = destName.lastIndexOf('.')
      destName = `${destName.slice(0, dot)}(${counter})${destName.slice(dot)}`
      counter++
    }
    const destPath = path.join(destDir, destName)

    // 移动：同卷 rename 原子且不中断已打开的读句柄（Linux）；
    // Windows 下文件被占用会 EBUSY → 延迟重试；跨卷 EXDEV → 复制后删
    const moved = await moveFileWithRetry(srcPath, destPath)
    if (!moved) return { status: 'skip-error', message: '移动文件失败（可能被占用）' }

    // 删除被替换的同录音旧文件与登记行（新音质更高才走到这里）
    for (const old of sameRecording) {
      if (old.filePath !== destPath) {
        await removeAudioCacheFiles(old.filePath).catch(() => {})
      }
      await prisma.librarySong.delete({ where: { id: old.id } }).catch(() => {})
    }

    await prisma.librarySong.create({
      data: {
        dedupeKey,
        uid: `${musicInfo.source}-${storageSongmidOf(musicInfo)}`,
        name: normalizeText(musicInfo.name) || '未知歌曲',
        singer: normalizeText(musicInfo.singer) || '未知歌手',
        album: normalizeText(musicInfo.albumName) || '',
        quality,
        filePath: destPath,
        fileSize: srcStat.size,
        durationSec,
      },
    })

    // 清掉 cache 侧记录与残留（文件已移走；歌词边车随 removeAudioCacheFiles 一并清理）
    await prisma.audioCache.delete({ where: { cacheKey } }).catch(() => {})
    await removeAudioCacheFiles(srcPath).catch(() => {})

    libraryFull = false
    logger.info(`[music-library] 入库: ${destName} (${quality}, ${(srcStat.size / 1024 / 1024).toFixed(1)}MB)`)
    return { status: 'ingested' }
  } catch (e) {
    logger.error('[music-library] ingest 失败:', e)
    return { status: 'skip-error', message: e instanceof Error ? e.message : String(e) }
  }
}

/** HollyMusic 存储 uid 用的 songmid（kg 为 FileHash 等，规则与 db 层一致） */
function storageSongmidOf(mi: MusicInfo): string {
  return getStorageSongmidForMusicInfo(mi)
}

/** rename + 重试；EXDEV 跨卷退化为复制；Windows 占用（EPERM/EBUSY）延迟重试 */
async function moveFileWithRetry(src: string, dest: string, retries = 3): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      await fsp.rename(src, dest)
      return true
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EXDEV') {
        // 跨卷：复制后删源（删失败由 cache 侧自愈回收）
        try {
          await fsp.copyFile(src, dest)
          await fsp.unlink(src).catch(() => {})
          return true
        } catch {
          return false
        }
      }
      if (code === 'EPERM' || code === 'EBUSY') {
        await new Promise(r => setTimeout(r, 2000))
        continue
      }
      logger.warn(`[music-library] move 失败 ${code}:`, e)
      return false
    }
  }
  return false
}

// ============================================================================
// 查找与播放服务（本地优先）
// ============================================================================

/**
 * 为一次播放请求查找库内文件。
 * 命中规则：uid 精确（任意音质，库内只留最高档）→ dedupeKey+时长模糊（跨平台同录音）。
 * 返回 null 表示未命中（调用方走 cache/在线）。
 */
export async function findLibrarySong(musicInfo: MusicInfo): Promise<LibrarySong | null> {
  const uid = `${musicInfo.source}-${storageSongmidOf(musicInfo)}`
  const exact = await prisma.librarySong.findFirst({ where: { uid } })
  if (exact && (await fileExists(exact.filePath))) return exact

  const intervalSec = parseIntervalToSeconds(musicInfo.interval)
  const dedupeKey = buildDedupeKey(musicInfo.name, musicInfo.singer)
  const candidates = await prisma.librarySong.findMany({ where: { dedupeKey } })
  for (const row of candidates) {
    if (!(await fileExists(row.filePath))) continue
    // 重建索引生成的条目时长未知（0）→ 懒探测回填一次
    if (row.durationSec === 0) {
      const probe = await checkTrialAudio(row.filePath, intervalSec || 0)
      if (probe.actualSec) {
        await prisma.librarySong.update({ where: { id: row.id }, data: { durationSec: probe.actualSec } }).catch(() => {})
        row.durationSec = probe.actualSec
      }
    }
    if (intervalSec > 0 && Math.abs(row.durationSec - intervalSec) <= 4) return row
  }
  return null
}

/**
 * 本地优先的音质裁决：库内文件是否应当被服务。
 * - 库内 ≥ 请求档 → 服务（含库内比请求更好的情形，省带宽不降体验）
 * - 库内 < 请求档时看平台可用音质（musicInfo.types）：
 *   · 平台最高档也不超过库内 → 服务（在线拿不到更好的，不白跑回源）
 *   · 平台确有更高档 → 不服务，走在线拉取，完成后自动替换库内低档
 *   · 音质列表未知/为空 → 不服务，在线试探（有机会升库，代价一次回源）
 */
export function shouldServeLibraryFile(
  row: Pick<LibrarySong, 'quality'>,
  requestedQuality: QualityType,
  types?: QualityInfo[]
): boolean {
  const libRank = qualityRank(row.quality)
  if (libRank <= qualityRank(requestedQuality)) return true
  const available = getAvailableQualities(types)
  if (available.length === 0) return false
  // available 已按高→低排序；最高档仍不高于库内 → 平台无更好
  return qualityRank(available[0]) >= libRank
}

/**
 * 用库内文件构建音频响应（支持 Range seek / HEAD）。
 * 音质策略：库内文件音质 ≥ 请求档时直接服务（同录音只留最高档，请求更低档也
 * 服务库内文件——本地秒开优先；库内更低则交回调用方走在线）。
 */
export async function serveFromLibrary(
  musicInfo: MusicInfo,
  requestedQuality: QualityType,
  rangeHeader: string | null,
  isHead: boolean
): Promise<Response | null> {
  const row = await findLibrarySong(musicInfo)
  if (!row) return null
  // 音质裁决：库内满足请求、或平台确无更高档时才本地服务（见 shouldServeLibraryFile）
  if (!shouldServeLibraryFile(row, requestedQuality, musicInfo.types)) return null

  const stat = await fsp.stat(row.filePath).catch(() => null)
  if (!stat) return null
  const contentType = contentTypeForFile(row.filePath)
  const range = parseRange(rangeHeader, stat.size)
  if (range === 'unsatisfiable') return buildUnsatisfiable(stat.size)
  if (range === null) return buildFullResponse(row.filePath, stat.size, contentType, isHead)
  return buildPartialResponse(row.filePath, stat.size, contentType, range, isHead)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

// ============================================================================
// 管理：统计 / 删除 / 重建索引
// ============================================================================

export interface LibraryStats {
  count: number
  totalBytes: number
  quotaBytes: number
  full: boolean
}

export async function getLibraryStats(): Promise<LibraryStats> {
  const [countAgg, sumAgg] = await Promise.all([
    prisma.librarySong.count(),
    prisma.librarySong.aggregate({ _sum: { fileSize: true } }),
  ])
  const totalBytes = sumAgg._sum.fileSize || 0
  const quotaBytes = getLibraryConfig().quotaBytes
  return { count: countAgg, totalBytes, quotaBytes, full: libraryFull || totalBytes >= quotaBytes }
}

export async function deleteLibrarySong(id: number): Promise<boolean> {
  const row = await prisma.librarySong.findUnique({ where: { id } })
  if (!row) return false
  await removeAudioCacheFiles(row.filePath).catch(() => {})
  await prisma.librarySong.delete({ where: { id } })
  // 目录清理：专辑/歌手目录空了顺手删掉（保守：只删空目录）
  const albumDir = path.dirname(row.filePath)
  const singerDir = path.dirname(albumDir)
  await removeDirIfEmpty(albumDir)
  await removeDirIfEmpty(singerDir)
  logger.info(`[music-library] 删除: ${row.filePath}`)
  return true
}

async function removeDirIfEmpty(dir: string): Promise<void> {
  try {
    const entries = await fsp.readdir(dir)
    if (entries.length === 0) await fsp.rmdir(dir)
  } catch {
    // 目录不存在或非空，忽略
  }
}

/**
 * 重建索引：扫描 library/ 目录，为未登记的文件补登记行（uid 空，仅模糊命中）。
 * 用途：DB 丢失 / 手动放入文件后的修复。耗时探测惰性化（时长首次命中时补）。
 */
export async function rebuildLibraryIndex(): Promise<{ scanned: number; added: number }> {
  const cfg = getLibraryConfig()
  const existing = new Set((await prisma.librarySong.findMany({ select: { filePath: true } })).map(r => r.filePath))
  let scanned = 0
  let added = 0

  const walk = async (dir: string, singer: string | null, album: string | null): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, singer ?? entry.name, singer ? (album ?? entry.name) : null)
      } else if (/\.(mp3|flac|m4a|aac|ogg|wav)$/i.test(entry.name)) {
        scanned++
        if (existing.has(full)) continue
        // 文件名约定：`歌手 - 歌名.ext`
        const ext = path.extname(entry.name)
        const base = entry.name.slice(0, -ext.length)
        const dashIdx = base.indexOf(' - ')
        const fileSinger = dashIdx > 0 ? base.slice(0, dashIdx) : (singer ?? '未知歌手')
        const fileName = dashIdx > 0 ? base.slice(dashIdx + 3) : base
        const quality = ext === '.flac' ? 'flac' : '320k'
        const stat = await fsp.stat(full).catch(() => null)
        if (!stat) continue
        await prisma.librarySong.create({
          data: {
            dedupeKey: buildDedupeKey(fileName, fileSinger),
            uid: '',
            name: fileName,
            singer: fileSinger,
            album: album && album !== singer ? album : '',
            quality,
            filePath: full,
            fileSize: stat.size,
            durationSec: 0,
          },
        }).catch(() => {})
        added++
      }
    }
  }

  await walk(cfg.libraryDir, null, null)
  logger.info(`[music-library] 重建索引: 扫描 ${scanned}，新增 ${added}`)
  return { scanned, added }
}

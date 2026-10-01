/**
 * 歌词 service
 *
 * 独立实现（不依赖 lib/subsonic-*.ts），复用 musicSourceManager.getLyric
 * 与第三方 API（api.lrc.cx）回退。逻辑与 subsonic-metadata.ts 的私有函数保持一致。
 */

import fsp from 'fs/promises'
import path from 'path'
import { getAudioServeConfig } from '@/lib/audio-serve'
import { lyricCache } from '@/lib/cache-manager'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { musicSourceManager } from '@/lib/music-source-manager'
import { songIdentity } from '@/lib/song-identity'
import { getLyricSidecarPath, getTranslationLyricSidecarPath, getWordLyricSidecarPath } from '@/lib/server/lyric-cache'
import { decodeLyricEntities } from '@/lib/server/lyric-decode'
import { normalizeStructuredLyricText } from '@/lib/server/lyric-normalize'
import { fetchKugouWordLyric, fetchNativeLyric } from '@/lib/server/music-lyric'
import { alignWordLyricToLines, toEnhancedLrc } from '@/lib/server/word-lyric'
import type { MusicInfo } from '@/lib/types/music'

export interface ParsedLyricLine {
  time: number // 毫秒
  text: string
}
export interface ParsedLyric {
  offset: number // 毫秒
  lines: ParsedLyricLine[]
}

type LyricResult = { lyric: string; tlyric: string | null; wordLyric: string | null }

const nativeLyricInflight = new Map<string, Promise<LyricResult | null>>()

/**
 * 「整行已缓存、逐字缺失」时的补取账本：每首歌每个进程最多试一次。
 * 没有它会有两种坏结果 —— 要么老 .lrc 把这首歌永久挡在逐字之外，
 * 要么每次播放都为拿不到的逐字白打一遍上游。
 */
const wordLyricRetried = new Set<string>()
const WORD_RETRY_LEDGER_LIMIT = 2000

function claimWordLyricRetry(key: string): boolean {
  if (wordLyricRetried.has(key)) return false
  if (wordLyricRetried.size >= WORD_RETRY_LEDGER_LIMIT) wordLyricRetried.clear()
  wordLyricRetried.add(key)
  return true
}

/**
 * 允许"跨源借逐字"的源：播的是这儿的歌，但库里同一首有酷狗副本时，用那行的 hash 取
 * KRC 的字时间，再挂回本行自己的行时间上 —— 行级文本一个字节都不改。
 *
 * 放开谁、不放谁都是实测结论（14 首抽样，同一 identity + 时长±2.5s 配对）：
 * - tx：与酷狗行时间中位差 4~5ms，本就是同一份时间轴。
 * - kw：青花/最熟悉的陌生人/浮夸 三首偏移直接 0ms、对齐率 98~100%，千千阕歌 −251ms 残余 p90 82ms；
 *   库里 1219 条酷我行有可借兄弟行的 18%（按播放加权 33%），比 tx 的约 9% 更值钱。
 * - wy：中位差 200~500ms 且常是另一个版本（对齐率低到 22%）⇒ 不放。
 * 闸门照旧不放宽：行对齐率 ≥70% 且整体时间差 ≤300ms，配不上就不借。
 */
const BORROWABLE_SOURCES = new Set(['tx', 'kw'])

/** 这行记录本身有没有拿到逐字的可能 —— 没可能就别打上游 */
async function mayHaveWordLyric(musicInfo: MusicInfo): Promise<boolean> {
  if (musicInfo.source === 'kg') return Boolean(musicInfo.hash)
  if (musicInfo.source === 'mg') return Boolean(musicInfo.mrcUrl)
  if (BORROWABLE_SOURCES.has(musicInfo.source)) {
    const identity = songIdentity(musicInfo)
    if (identity === '|') return false
    const donor = await prisma.musicInfo.findFirst({
      where: { identity, source: 'kg', hash: { gt: '' } },
      select: { songmid: true },
    })
    return Boolean(donor)
  }
  return false
}

function getAudioCacheKeyPrefix(musicInfo: MusicInfo): string {
  return `${musicInfo.source}:${musicInfo.songmid}:`
}

function resolveSidecarPaths(
  cacheDir: string,
  relativeAudioPath: string
): { audioPath: string; lyricPath: string; translationPath: string; wordPath: string } | null {
  const audioPath = path.resolve(cacheDir, relativeAudioPath)
  const relative = path.relative(cacheDir, audioPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return {
    audioPath,
    lyricPath: getLyricSidecarPath(audioPath),
    translationPath: getTranslationLyricSidecarPath(audioPath),
    wordPath: getWordLyricSidecarPath(audioPath),
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath)
    return true
  } catch {
    return false
  }
}

async function getCachedNativeLyric(musicInfo: MusicInfo): Promise<LyricResult | null> {
  const config = getAudioServeConfig()
  if (!config.enabled) return null

  try {
    const records = await prisma.audioCache.findMany({
      where: { cacheKey: { startsWith: getAudioCacheKeyPrefix(musicInfo) } },
      orderBy: { lastAccessAt: 'desc' },
      select: { filePath: true },
    })
    for (const record of records) {
      const paths = resolveSidecarPaths(config.cacheDir, record.filePath)
      if (!paths) continue
      try {
        if (!(await fileExists(paths.audioPath))) continue
        const lyric = (await fsp.readFile(paths.lyricPath, 'utf-8')).trim()
        if (lyric) {
          const tlyric = await fsp.readFile(paths.translationPath, 'utf-8').catch(() => '')
          // 逐字与整行必须同源，所以只读同一目录的配对文件：persist 时两者同写同删。
          const wordLyric = await fsp.readFile(paths.wordPath, 'utf-8').catch(() => '')
          logger.debug('[lyrics] disk cache hit', { source: musicInfo.source, songId: musicInfo.songmid })
          return { lyric, tlyric: tlyric.trim() || null, wordLyric: wordLyric.trim() || null }
        }
      } catch {
        // 未缓存、缓存文件被删除或内容损坏时，继续检查其他音质及网络回退。
      }
    }
  } catch (err) {
    logger.debug('[lyrics] disk cache read failed', { source: musicInfo.source, songId: musicInfo.songmid, err })
  }
  return null
}

async function persistNativeLyric(musicInfo: MusicInfo, lyric: LyricResult): Promise<void> {
  const config = getAudioServeConfig()
  if (!config.enabled) return

  try {
    const records = await prisma.audioCache.findMany({
      where: { cacheKey: { startsWith: getAudioCacheKeyPrefix(musicInfo) } },
      orderBy: { lastAccessAt: 'desc' },
      select: { filePath: true },
    })
    if (!records.length) return

    const existingPaths = (await Promise.all(records.map(async record => {
      const paths = resolveSidecarPaths(config.cacheDir, record.filePath)
      return paths && await fileExists(paths.audioPath) ? paths : null
    }))).filter((paths): paths is NonNullable<ReturnType<typeof resolveSidecarPaths>> => paths !== null)
    if (!existingPaths.length) return

    // 首次缓存只写入一份歌词，放在当前最近使用且实际存在的音频旁。
    const targetPaths = existingPaths[0]

    await writeTextAtomically(targetPaths.lyricPath, lyric.lyric)
    if (lyric.tlyric) {
      await writeTextAtomically(targetPaths.translationPath, lyric.tlyric)
    } else {
      await fsp.unlink(targetPaths.translationPath).catch(() => {})
    }
    // 逐字要么与这次的整行一起写，要么一起删；留着旧 .wlrc 就会与新的 .lrc 不同源
    if (lyric.wordLyric) {
      await writeTextAtomically(targetPaths.wordPath, lyric.wordLyric)
    } else {
      await fsp.unlink(targetPaths.wordPath).catch(() => {})
    }

    logger.info('[lyrics] cached precise source lyric to disk', { source: musicInfo.source, songId: musicInfo.songmid })
  } catch (err) {
    // 歌词缓存失败不应影响播放或正常的歌词响应。
    logger.warn('[lyrics] disk cache write failed', { source: musicInfo.source, songId: musicInfo.songmid, err })
  }
}

async function writeTextAtomically(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tempPath, content, 'utf-8')
  try {
    await fsp.rename(tempPath, filePath)
  } catch (error) {
    await fsp.unlink(tempPath).catch(() => {})
    throw error
  }
}

async function borrowWordLyric(musicInfo: MusicInfo, lyric: string): Promise<string | null> {
  if (!BORROWABLE_SOURCES.has(musicInfo.source)) return null
  const identity = songIdentity(musicInfo)
  if (identity === '|') return null

  const parsedLocal = parseLrc(lyric)
  if (parsedLocal.lines.length < 8) return null

  try {
    const rows = await prisma.musicInfo.findMany({
      where: { identity, source: 'kg' },
      select: { data: true, songmid: true },
      take: 5,
    })
    for (const row of rows) {
      if (row.songmid === musicInfo.songmid) continue
      let donor: MusicInfo | null = null
      try {
        donor = JSON.parse(row.data ?? '') as MusicInfo
      } catch {
        continue // data 列损坏的行跳过
      }
      if (!donor?.hash) continue
      const borrowed = await fetchKugouWordLyric(donor)
      if (!borrowed) continue
      const aligned = alignWordLyricToLines(borrowed, parsedLocal.lines.map(line => ({ start: line.time, text: line.text })))
      if (!aligned.ok) {
        logger.info('[lyrics] 跨源逐字配不上，不借', { songId: musicInfo.songmid, donor: row.songmid, reason: aligned.reason })
        continue
      }
      logger.info('[lyrics] 跨源借到逐字', {
        songId: musicInfo.songmid, donor: row.songmid,
        对齐率: `${(aligned.alignRate * 100).toFixed(0)}%`, 时间差: `${aligned.medianShiftMs}ms`,
      })
      // 整行歌词带 [offset:] 时要在逐字里带上同一个值：客户端对两侧都套这个偏移，
      // 只有一侧带就会判定行时间不一致而退回整行渲染
      return parsedLocal.offset ? `[offset:${parsedLocal.offset}]\n${toEnhancedLrc(aligned.lyric)}` : toEnhancedLrc(aligned.lyric)
    }
  } catch (err) {
    logger.debug('[lyrics] 跨源借逐字失败（忽略）:', err)
  }
  return null
}

async function getNativeLyricWithDiskCache(musicInfo: MusicInfo): Promise<LyricResult | null> {
  const key = `${musicInfo.source}:${musicInfo.songmid}`
  const cached = await getCachedNativeLyric(musicInfo)
  if (cached) {
    // 早退缺陷的修补：整行命中缓存不等于逐字命中。缺失时补取一次，并且让网络路径
    // **同时重写** .lrc 与 .wlrc —— 只把新逐字配到旧 .lrc 上，正是实测过的 10ms 混用
    if (cached.wordLyric || !claimWordLyricRetry(key) || !(await mayHaveWordLyric(musicInfo))) return cached
    logger.info('[lyrics] 整行已缓存但缺逐字，补取一次', { source: musicInfo.source, songId: musicInfo.songmid })
  }

  const running = nativeLyricInflight.get(key)
  if (running) return running

  const task = (async () => {
    const nativeLyric = await fetchNativeLyric(musicInfo)
    if (!nativeLyric) return null
    const lyric = normalizeLyricPayload(nativeLyric.lyric)
    if (!lyric) return null
    let wordLyric = nativeLyric.wordLyric ? normalizeLyricPayload(nativeLyric.wordLyric) : ''
    // 本源没有逐字时，才去库里找同款兄弟行借一份（本轮只对 tx 开放）
    if (!wordLyric) wordLyric = (await borrowWordLyric(musicInfo, lyric)) ?? ''
    // 上游给逐字时整行本应出自同一次解析；不信任到这一步，对不上就只丢逐字，
    // 整行照常落盘，同时把磁盘上残留的旧 .wlrc 删掉（否则它将与新 .lrc 错配）
    const paired = !!wordLyric && isWordLyricConsistent(lyric, wordLyric)
    if (wordLyric && !paired) {
      logger.warn('[lyrics] 逐字与整行不同源，丢弃逐字', { source: musicInfo.source, songId: musicInfo.songmid })
    }
    const result = {
      lyric,
      tlyric: nativeLyric.tlyric ? normalizeLyricPayload(nativeLyric.tlyric) || null : null,
      wordLyric: paired ? wordLyric : null,
    }
    await persistNativeLyric(musicInfo, result)
    return result
  })()
  nativeLyricInflight.set(key, task)
  try {
    return await task
  } finally {
    nativeLyricInflight.delete(key)
  }
}

/**
 * 从已配置的渠道音源脚本取词。脚本调用携带当前 source + MusicInfo，
 * 结果可作为渠道内歌词缓存；不包含按标题搜索的公共 API 回退。
 */
async function getSourceLyricWithDiskCache(musicInfo: MusicInfo): Promise<LyricResult | null> {
  try {
    const result = await musicSourceManager.getLyric(musicInfo, 5000)
    if (!result?.lyric) return null

    const lyric = normalizeLyricPayload(result.lyric)
    if (!lyric) return null

    const tlyric = result.tlyric ? normalizeLyricPayload(result.tlyric) : ''
    // 渠道脚本回答的是 lx 协议的 lyric 字段，没有逐字通道
    const resolved = { lyric, tlyric: tlyric || null, wordLyric: null }
    await persistNativeLyric(musicInfo, resolved)
    return resolved
  } catch (err) {
    logger.debug('[lyrics] musicSourceManager.getLyric failed:', err)
    return null
  }
}

/** 音频完整落盘后触发：仅缓存所属渠道精确歌词，不使用标题搜索回退。 */
export async function cacheNativeLyricForMusic(musicInfo: MusicInfo): Promise<void> {
  // 仅缓存渠道唯一标识精确取得的歌词；标题搜索等第三方回退结果可能错配，
  // 可以临时返回给页面，但绝不能落盘固化。
  const cached = await getCachedNativeLyric(musicInfo)
  if (cached?.wordLyric) return
  if (await getNativeLyricWithDiskCache(musicInfo)) return
  await getSourceLyricWithDiskCache(musicInfo)
}

function normalizeLyricPayload(value: string): string {
  return normalizeStructuredLyricText(decodeLyricEntities(value).trim()).trim()
}

/**
 * 逐字与整行必须出自同一次解析：行数与每行时间戳全等才允许一起下发/落盘。
 * 上游若哪天只给逐字或两者来源不同，这里宁可不给逐字，也不让客户端拿到对不上的两套时间。
 */
function isWordLyricConsistent(lyric: string, wordLyric: string): boolean {
  const plain = parseLrc(lyric).lines
  const word = parseLrc(wordLyric).lines
  if (!plain.length || plain.length !== word.length) return false
  return plain.every((line, index) => line.time === word[index].time)
}

/**
 * 调用第三方歌词 API 获取 LRC 文本。
 * 优先使用 title + artist，避免同名歌曲命中错误歌词；缺失歌名时再降级使用专辑或歌手。
 */
async function fetchLyricsFromAPI(title: string, album: string, artist: string): Promise<string | null> {
  try {
    const params: Record<string, string> = {}
    const titleTrimmed = title.trim()
    const albumTrimmed = album.trim()
    const artistTrimmed = artist.trim()

    if (titleTrimmed) {
      params.title = titleTrimmed
      if (artistTrimmed) params.artist = artistTrimmed
    } else if (albumTrimmed && albumTrimmed !== '[Unknown Album]') {
      params.album = albumTrimmed
      if (artistTrimmed) params.artist = artistTrimmed
    } else if (artistTrimmed) {
      params.artist = artistTrimmed
    } else {
      return null
    }

    const url = `https://api.lrc.cx/lyrics?${new URLSearchParams(params).toString()}`
    logger.info('[lyrics] fetching from API:', url)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000)

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    })
    clearTimeout(timeoutId)

    if (!response.ok) {
      logger.warn('[lyrics] API returned status:', response.status)
      return null
    }

    const text = await response.text()
    if (!text || text.trim().length === 0) return null
    // 回退源同样可能返回实体编码歌词（不经过 extractLyric，此处解码）
    return decodeLyricEntities(text)
  } catch (err) {
    logger.warn('[lyrics] API error:', err)
    return null
  }
}

/**
 * 统一歌词获取：音源优先，第三方 API 回退。
 * 返回 { lyric, tlyric, wordLyric } 或 null。
 *
 * 最前面这层 90 秒内存缓存是因为一次播放会有多个入口同要一首歌的歌词
 * （底栏当前行、全屏歌词页各订阅了时间，实测生产日志同一首连着打三次上游）。
 * 只记成功结果：取词失败要留给下次播放重试，不能把一次网络抖动固化成"这首歌没歌词"。
 */
const LYRIC_MEMO_TTL_MS = 90_000

export async function fetchLyricForMusic(musicInfo: MusicInfo): Promise<LyricResult | null> {
  const key = `${musicInfo.source}:${musicInfo.songmid}`
  const memo = lyricCache.get(key) as LyricResult | null
  if (memo) return memo

  const title = musicInfo.name || ''
  const artist = musicInfo.singer || ''
  const album = musicInfo.albumName || ''

  // 1) 平台原生接口按歌曲唯一标识取词，避免同名歌曲被标题搜索误配。
  // 2) 已配置的渠道音源脚本（以 source + MusicInfo 查询，可作为精确结果缓存）
  // 3) 回退第三方标题搜索（可返回给页面，但绝不落盘固化）
  let result = await getNativeLyricWithDiskCache(musicInfo)
  if (!result) result = await getSourceLyricWithDiskCache(musicInfo)
  if (!result) {
    const text = await fetchLyricsFromAPI(title, album || title, artist)
    const lyric = text ? normalizeLyricPayload(text) : ''
    if (lyric) result = { lyric, tlyric: null, wordLyric: null }
  }

  if (result) lyricCache.set(key, result, LYRIC_MEMO_TTL_MS)
  return result
}

// 匹配单个时间标签：[mm:ss] / [mm:ss.xx] / [mm:ss.xxx] / [h:mm:ss.xxx]
const LRC_TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
// 全局 offset 标签：[offset:毫秒]（正数表示歌词提前）
const LRC_OFFSET_TAG = /\[offset:\s*(-?\d+)\]/i

/**
 * 将 LRC 文本解析为带时间戳的行数组。
 * - 支持一行多时间标签
 * - 解析全局 [offset:] 偏移（毫秒）
 * - 忽略 [ti:]/[ar:]/[al:]/[by:] 等 ID 标签
 * - 结果按 time 升序，time 单位为毫秒
 */
export function parseLrc(lrcText: string): ParsedLyric {
  const result: ParsedLyric = { offset: 0, lines: [] }
  if (!lrcText) return result

  const offsetMatch = LRC_OFFSET_TAG.exec(lrcText)
  if (offsetMatch) result.offset = parseInt(offsetMatch[1], 10) || 0

  const tagStrip = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g

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
      times.push(min * 60000 + sec * 1000 + frac)
    }
    if (times.length === 0) continue

    const text = line.replace(tagStrip, '').trim()
    if (!text) continue

    for (const time of times) result.lines.push({ time, text })
  }

  result.lines.sort((a, b) => a.time - b.time)
  return result
}

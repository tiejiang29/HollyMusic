/**
 * 批量曲目解析（专辑/歌手详情专用）
 *
 * 与逐首 resolveLocalTrack 的区别：搜索阶段完全不做 DB 写入（绕过 searchOneSource
 * 的 per-page upsert），全并发拿回候选后在内存中做三重校验+优先级挑选；
 * 整张专辑解析完一次性 upsertMusicInfosInTransaction + 计算 uid。
 *
 * SQLite 单写者模型下，per-page upsert 是并发瓶颈（30 并发搜索 × 每次写事务
 * = 排队 1.5s+，实测 P1008 超时）。批量写入把 N 次事务压缩为 1 次，
 * 搜索阶段零锁争抢，实测 30 曲专辑从 4.8s → 3.7s。
 */

import { searchCache } from '@/lib/cache-manager'
import { upsertMusicInfosInTransaction, getStorageSongmidForMusicInfo } from '@/lib/db'
import { logger } from '@/lib/logger'
import type { MusicInfo, Song, SourceType } from '@/lib/types/music'
import * as musicSearch from '@/lib/music-core/music-search'
import { appleT2S } from '@/lib/services/itunes-service'

/** 源优先序（tx 最优先；wy 搜索通道被翻唱污染放最后） */
export const RESOLVE_SOURCE_ORDER: SourceType[] = ['tx', 'kw', 'kg', 'mg', 'wy']

function normText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function normalizeName(v: string | null | undefined): string {
  return normText(appleT2S(v || '').replace(/妳/g, '你'))
}

function singerMatches(singer: string | undefined, artist: string): boolean {
  const s = normText(singer || '')
  const a = normText(artist)
  if (!a) return true
  if (s.includes(a)) return true
  return a.split(/\s+/).filter(t => t.length >= 2).some(t => s.includes(t))
}

function durationMatches(interval: string | undefined, secs: number | null): boolean {
  if (!secs) return true
  const raw = (interval || '').trim()
  if (!raw) return true
  let dur = 0
  if (raw.includes(':')) {
    for (const part of raw.split(':')) dur = dur * 60 + Number(part)
  } else {
    dur = Number(raw)
  }
  if (!Number.isFinite(dur) || dur <= 0) return true
  return Math.abs(dur - secs) <= 8
}

/** 无写入搜索：走缓存或直连上游，不做 upsert（批量写入时统一入库） */
async function searchNoWrite(source: SourceType, keyword: string, limit = 10): Promise<Song[]> {
  const cacheKey = `search:${source}:${keyword}:1:${limit}`
  const cached = searchCache.get(cacheKey) as { list?: Song[] } | null
  if (cached?.list) return cached.list

  const result = await musicSearch.search(source, keyword, 1, limit)
  // 只附 uid（纯内存计算），不写库不入缓存（写入阶段统一处理）
  return (result.list || []).map((mi: MusicInfo) => ({
    ...mi,
    uid: `${mi.source}-${getStorageSongmidForMusicInfo(mi)}`,
  }))
}

/** 候选三重校验：歌手 + 歌名（简繁归一双向包含）+ 时长 ±8s */
function passes(s: Song, titleNorm: string, artist: string, secs: number | null): boolean {
  if (!singerMatches(s.singer, artist)) return false
  const candName = normalizeName(s.name)
  if (!candName || (!candName.includes(titleNorm) && !titleNorm.includes(candName))) return false
  if (secs != null) return durationMatches(s.interval, secs)
  return true
}

/**
 * 单首曲目全并发解析：5 源同时发请求，按优先序挑合格候选。
 * 返回 MusicInfo（不写库），调用方批量入库后自行计算 uid。
 */
export async function resolveTrackNoWrite(
  track: { title: string; secs: number | null },
  artist: string,
  albumTitle?: string,
): Promise<MusicInfo | null> {
  const keyword = `${track.title} ${artist}`
  const titleNorm = normalizeName(track.title)
  const albumNorm = albumTitle ? normalizeName(albumTitle) : null

  // 5 源全并发（搜索阶段零 DB 写入，无锁争抢）
  const settled = await Promise.allSettled(
    RESOLVE_SOURCE_ORDER.map(src => searchNoWrite(src, keyword)),
  )

  // 按源优先序检查结果，第一个有合格候选的即用
  for (let i = 0; i < RESOLVE_SOURCE_ORDER.length; i++) {
    const r = settled[i]
    if (r.status !== 'fulfilled') continue
    const candidates = r.value.filter(s => passes(s, titleNorm, artist, track.secs))
    if (candidates.length === 0) continue
    if (albumNorm) {
      const albumHit = candidates.find(s => {
        const candAlbum = normalizeName(s.albumName)
        return !!candAlbum && (candAlbum.includes(albumNorm) || albumNorm.includes(candAlbum))
      })
      if (albumHit) return albumHit as MusicInfo
    }
    return candidates[0] as MusicInfo
  }
  return null
}

/**
 * 批量解析 + 批量入库：
 * 1. 全并发解析所有曲目（零 DB 写入）
 * 2. 一次 upsertMusicInfosInTransaction（单事务）
 * 3. 失败降级逐条写入（只丢坏数据不丢整批）
 * 4. 计算 uid 返回 Song[]
 */
export async function batchResolveAndUpsert(
  tracks: Array<{ title: string; secs: number | null }>,
  artist: string,
  albumTitle: string | undefined,
  concurrency = 6,
): Promise<Song[]> {
  // 阶段1：全并发搜索+校验（无 DB 写入）
  const results: Array<MusicInfo | null> = new Array(tracks.length)
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, tracks.length) }, async () => {
    while (index < tracks.length) {
      const current = index++
      results[current] = await resolveTrackNoWrite(tracks[current], artist, albumTitle).catch(() => null)
    }
  })
  await Promise.all(workers)

  const musicInfos = results.filter((mi): mi is MusicInfo => mi !== null)
  if (musicInfos.length === 0) return []

  // 阶段2：一次批量入库
  try {
    await upsertMusicInfosInTransaction(musicInfos)
  } catch (batchError) {
    logger.warn('[batch-resolve] 批量入库失败，降级逐条:', batchError instanceof Error ? batchError.message : batchError)
    // 降级：逐条写入，跳过坏数据
    const survivors: MusicInfo[] = []
    for (const mi of musicInfos) {
      try {
        await upsertMusicInfosInTransaction([mi])
        survivors.push(mi)
      } catch {
        logger.debug('[batch-resolve] 单条入库失败（跳过）:', (mi as { name?: string }).name)
      }
    }
    if (survivors.length === 0) {
      logger.warn('[batch-resolve] 全部入库失败')
      return []
    }
    musicInfos.length = 0
    musicInfos.push(...survivors)
  }

  // 阶段3：附 uid（入库完成后，保证 resolveMusicInfoById 能命中）
  return musicInfos.map(mi => ({
    ...mi,
    uid: `${mi.source}-${getStorageSongmidForMusicInfo(mi)}`,
  }))
}

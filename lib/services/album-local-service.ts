/**
 * 本地专辑库服务（MusicBrainz 中文派生 SQLite，只读）
 *
 * 两个库文件（随服务部署，路径可用环境变量覆盖）：
 * - albums_cn_simp.db：专辑表 albums(gid BLOB16, title, artist)，title 前缀索引
 * - album_tracks_cn_simp.db：曲目表 album_tracks(rg_gid, disc, position, title, title_norm, length_ms, recording_id)
 *
 * 库文件缺失时自动降级：所有本地查询一律未命中，不影响在线专辑路径。
 * 数据特点：简体中文、含时长（78% 覆盖）、噪声已滤（伴奏/MV/现场等）。
 */

import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { searchCache } from '@/lib/cache-manager'
import { logger } from '@/lib/logger'
import { buildAffinityContext, dayKey } from './guess-service'

// 库文件随仓库分发（album-db/），Docker 镜像构建时 COPY 进 /app/album-db；
// 服务以项目根为工作目录，路径相对 cwd 解析；可用环境变量覆盖。
const ALBUM_DB_PATH = process.env.ALBUM_DB_PATH || path.join(process.cwd(), 'album-db', 'albums_cn_simp.db')
const TRACKS_DB_PATH = process.env.ALBUM_TRACKS_DB_PATH || path.join(process.cwd(), 'album-db', 'album_tracks_cn_simp.db')

export interface LocalAlbum {
  /** MB release-group UUID（带横杠） */
  gid: string
  title: string
  artist: string
  /** 曲目数（有曲目表时回填） */
  trackCount?: number
}

export interface LocalAlbumTrack {
  disc: number
  position: number
  title: string
  titleNorm: string
  /** 秒；无时长数据时为 null */
  secs: number | null
}

// undefined = 尚未尝试打开；null = 打开失败（降级）
let albumsDb: DatabaseSync | null | undefined
let tracksDb: DatabaseSync | null | undefined

function openReadOnly(path: string, label: string): DatabaseSync | null {
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    logger.warn(`[album-local] ${label}库打开失败（本地专辑功能降级）: ${path}`, error instanceof Error ? error.message : error)
    return null
  }
}

function getAlbumsDb(): DatabaseSync | null {
  if (albumsDb === undefined) albumsDb = openReadOnly(ALBUM_DB_PATH, '专辑')
  return albumsDb
}

function getTracksDb(): DatabaseSync | null {
  if (tracksDb === undefined) tracksDb = openReadOnly(TRACKS_DB_PATH, '曲目')
  return tracksDb
}

export function isLocalAlbumDbAvailable(): boolean {
  return !!getAlbumsDb() && !!getTracksDb()
}

export function gidToUuid(gid: Uint8Array | Buffer): string {
  const h = Buffer.from(gid).toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

function uuidToBuffer(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

/** 前缀范围扫描上界：末字符码点 +1 */
function upperBound(prefix: string): string {
  if (!prefix) return '\u{10FFFF}'
  const cps = Array.from(prefix)
  const last = cps[cps.length - 1]
  return cps.slice(0, -1).join('') + String.fromCodePoint(last.codePointAt(0)! + 1)
}

/** 卡片名/歌手与本地库比对的归一化：只保留字母数字与 CJK（去空白标点），小写 */
export function normalizeAlbumText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function rowToAlbum(row: { gid: Uint8Array; title: string; artist: string }): LocalAlbum {
  return { gid: gidToUuid(row.gid), title: row.title, artist: row.artist }
}

/** 专辑名前缀联想（走索引，毫秒级） */
export function suggestLocalAlbums(keyword: string, limit = 10): LocalAlbum[] {
  const db = getAlbumsDb()
  const k = keyword.trim()
  if (!db || !k) return []
  const rows = db.prepare('SELECT gid,title,artist FROM albums WHERE title>=? AND title<? ORDER BY title LIMIT ?').all(k, upperBound(k), Math.max(1, Math.min(limit, 20)))
  return rows.map(r => rowToAlbum(r as { gid: Uint8Array; title: string; artist: string }))
}

/** 专辑搜索：前缀命中优先，补标题包含 + 歌手包含（2.4 万行全表扫本地无压力），gid 去重 */
export function searchLocalAlbums(keyword: string, limit = 30): LocalAlbum[] {
  const db = getAlbumsDb()
  const k = keyword.trim()
  if (!db || !k) return []
  const cap = Math.max(1, Math.min(limit, 50))
  const merged = new Map<string, LocalAlbum>()
  const push = (row: { gid: Uint8Array; title: string; artist: string }) => {
    const album = rowToAlbum(row)
    if (!merged.has(album.gid) && merged.size < cap) merged.set(album.gid, album)
  }
  for (const row of db.prepare('SELECT gid,title,artist FROM albums WHERE title>=? AND title<? ORDER BY title LIMIT ?').all(k, upperBound(k), cap)) push(row as { gid: Uint8Array; title: string; artist: string })
  for (const row of db.prepare('SELECT gid,title,artist FROM albums WHERE title LIKE ? LIMIT ?').all(`%${k}%`, cap)) push(row as { gid: Uint8Array; title: string; artist: string })
  for (const row of db.prepare('SELECT gid,title,artist FROM albums WHERE artist LIKE ? ORDER BY title LIMIT ?').all(`%${k}%`, cap)) push(row as { gid: Uint8Array; title: string; artist: string })
  return [...merged.values()]
}

/** 随机专辑（本地专辑板块"随便听听"） */
export function randomLocalAlbums(size = 20): LocalAlbum[] {
  const db = getAlbumsDb()
  if (!db) return []
  const cap = Math.max(1, Math.min(size, 50))
  const rows = db.prepare('SELECT gid,title,artist FROM albums ORDER BY RANDOM() LIMIT ?').all(cap)
  const result = rows.map(r => rowToAlbum(r as { gid: Uint8Array; title: string; artist: string }))
  const tdb = getTracksDb()
  if (tdb) {
    for (const album of result) {
      album.trackCount = tdb.prepare('SELECT COUNT(DISTINCT disc || char(45) || position) AS n FROM album_tracks WHERE rg_gid=?').get(uuidToBuffer(album.gid))?.n ?? 0
    }
  }
  return result
}

/** 画像推荐专辑：用户画像 top 歌手 → 本地库这些歌手的专辑洗牌；画像为空回退随机 */
export async function recommendLocalAlbums(username: string, userId: number, size = 20): Promise<{ list: LocalAlbum[]; personalized: boolean }> {
  const cap = Math.max(1, Math.min(size, 50))
  const cacheKey = `album-local:recommend:${username}:${cap}:${dayKey()}`
  const cached = searchCache.get(cacheKey) as { list: LocalAlbum[]; personalized: boolean } | null
  if (cached) return cached

  const db = getAlbumsDb()
  if (!db) return { list: [], personalized: false }

  let artists: Array<{ name: string; weight: number }> = []
  try {
    const ctx = await buildAffinityContext(username, userId)
    artists = [...ctx.artistAffinity.entries()]
      .map(([name, weight]) => ({ name, weight }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 30)
  } catch (error) {
    logger.warn('[album-local] 用户画像构建失败，回退随机:', error instanceof Error ? error.message : error)
  }

  const merged = new Map<string, LocalAlbum>()
  const tdb = getTracksDb()
  for (const artist of artists) {
    if (merged.size >= cap * 2) break
    const rows = db.prepare('SELECT gid,title,artist FROM albums WHERE artist=? ORDER BY title LIMIT ?').all(artist.name, 10)
    for (const row of rows) {
      const album = rowToAlbum(row as { gid: Uint8Array; title: string; artist: string })
      if (!merged.has(album.gid)) {
        if (tdb) album.trackCount = tdb.prepare('SELECT COUNT(DISTINCT disc || char(45) || position) AS n FROM album_tracks WHERE rg_gid=?').get(uuidToBuffer(album.gid))?.n ?? 0
        merged.set(album.gid, album)
      }
    }
  }
  // 确定性洗牌（种子=用户名+当天），同一天刷新不变
  const seed = `${username}:${dayKey()}`
  let state = 0
  for (const ch of seed) state = (state * 31 + ch.codePointAt(0)!) >>> 0
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
  const personalizedList = [...merged.values()].sort(() => rand() - 0.5).slice(0, cap)

  if (personalizedList.length >= Math.min(cap, 5)) {
    const result = { list: personalizedList, personalized: true }
    searchCache.set(cacheKey, result, 30 * 60 * 1000)
    return result
  }

  // 画像覆盖不足 → 随机兜底
  const fallback = { list: randomLocalAlbums(cap), personalized: false }
  searchCache.set(cacheKey, fallback, 30 * 60 * 1000)
  return fallback
}

/** 按卡片名+歌手查本地库（详情倒查入口）：归一化精确匹配优先，标题命中再比对歌手 */
export function findLocalAlbum(title: string, artist: string): LocalAlbum | null {
  const db = getAlbumsDb()
  const a = normalizeAlbumText(artist)
  if (!db || !title.trim()) return null

  const candidates = db.prepare('SELECT gid,title,artist FROM albums WHERE title=? LIMIT 20').all(title.trim())
    .concat(db.prepare('SELECT gid,title,artist FROM albums WHERE title LIKE ? LIMIT 20').all(`%${title.trim()}%`)) as Array<{ gid: Uint8Array; title: string; artist: string }>
  for (const row of candidates) {
    const album = rowToAlbum(row)
    const rowArtist = normalizeAlbumText(album.artist)
    if (!a || !rowArtist || rowArtist.includes(a) || a.includes(rowArtist)) return album
  }
  return null
}

/** 按 gid 查本地专辑（含曲目数） */
export function findLocalAlbumByGid(gid: string): LocalAlbum | null {
  const db = getAlbumsDb()
  if (!db || !/^[0-9a-f-]{36}$/i.test(gid)) return null
  const row = db.prepare('SELECT gid,title,artist FROM albums WHERE gid=?').get(uuidToBuffer(gid)) as { gid: Uint8Array; title: string; artist: string } | undefined
  if (!row) return null
  const album = rowToAlbum(row)
  const tdb = getTracksDb()
  if (tdb) album.trackCount = tdb.prepare('SELECT COUNT(DISTINCT disc || char(45) || position) AS n FROM album_tracks WHERE rg_gid=?').get(uuidToBuffer(gid))?.n ?? 0
  return album
}

/** 本地曲目表（按碟内序号去重——特殊版附加曲常与正曲目同碟位），按时长排序输出 */
export function getLocalAlbumTracks(gid: string): LocalAlbumTrack[] {
  const tdb = getTracksDb()
  if (!tdb || !/^[0-9a-f-]{36}$/i.test(gid)) return []
  const rows = tdb.prepare('SELECT disc,position,title,title_norm,length_ms FROM album_tracks WHERE rg_gid=? ORDER BY disc,position').all(uuidToBuffer(gid)) as Array<{ disc: number; position: number; title: string; title_norm: string; length_ms: number | null }>
  const seen = new Set<string>()
  const result: LocalAlbumTrack[] = []
  for (const r of rows) {
    const key = `${r.disc}-${r.position}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      disc: r.disc,
      position: r.position,
      title: r.title,
      titleNorm: r.title_norm || '',
      secs: r.length_ms ? Math.round(r.length_ms / 1000) : null,
    })
  }
  return result
}

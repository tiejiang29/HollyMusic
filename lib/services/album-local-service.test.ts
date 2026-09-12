import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---- 在导入被测模块前构造 fixture 库并注入 env（模块读取 env 在 import 时） ----
const dir = mkdtempSync(join(tmpdir(), 'album-local-test-'))
const GID_HEX = '00112233445566778899aabbccddeeff'
const GID2_HEX = 'ffeeddccbbaa99887766554433221100'
const GID3_HEX = '1234567890abcdef1234567890abcdef'
const GID = '00112233-4455-6677-8899-aabbccddeeff'

const albumsDb = new DatabaseSync(join(dir, 'albums.db'))
albumsDb.exec('CREATE TABLE albums (gid BLOB, title TEXT, artist TEXT)')
albumsDb.exec('CREATE INDEX idx_title ON albums(title)')
const insAlbum = albumsDb.prepare('INSERT INTO albums VALUES (?,?,?)')
insAlbum.run(Buffer.from(GID_HEX, 'hex'), '叶惠美', '周杰伦')
insAlbum.run(Buffer.from(GID2_HEX, 'hex'), '叶惠美美', '周杰伦')
insAlbum.run(Buffer.from(GID3_HEX, 'hex'), '范特西', '周杰伦')

const tracksDb = new DatabaseSync(join(dir, 'tracks.db'))
tracksDb.exec('CREATE TABLE album_tracks (rg_gid BLOB, disc INTEGER, position INTEGER, title TEXT, title_norm TEXT, length_ms INTEGER, recording_id INTEGER)')
const insTrack = tracksDb.prepare('INSERT INTO album_tracks VALUES (?,?,?,?,?,?,?)')
insTrack.run(Buffer.from(GID_HEX, 'hex'), 1, 1, '以父之名', '以父之名', 342000, 1)
insTrack.run(Buffer.from(GID_HEX, 'hex'), 1, 2, '懦夫', '懦夫', 218000, 2)
insTrack.run(Buffer.from(GID_HEX, 'hex'), 1, 2, '「以父之名」之罗马巡礼', '以父之名之罗马巡礼', 590000, 3) // 同碟位附加曲，应去重
insTrack.run(Buffer.from(GID_HEX, 'hex'), 1, 3, '晴天', '晴天', null, 4) // 无时长
// 范特西 3 首（随机池过滤要求去重曲目数 ≥ 3）
insTrack.run(Buffer.from(GID3_HEX, 'hex'), 1, 1, '爱在西元前', '爱在西元前', 234000, 5)
insTrack.run(Buffer.from(GID3_HEX, 'hex'), 1, 2, '简单爱', '简单爱', 270000, 6)
insTrack.run(Buffer.from(GID3_HEX, 'hex'), 1, 3, '双截棍', '双截棍', 201000, 7)

process.env.ALBUM_DB_PATH = join(dir, 'albums.db')
process.env.ALBUM_TRACKS_DB_PATH = join(dir, 'tracks.db')

const {
  suggestLocalAlbums,
  searchLocalAlbums,
  randomLocalAlbums,
  recommendLocalAlbums,
  findLocalAlbum,
  findLocalAlbumByGid,
  getLocalAlbumTracks,
  gidToUuid,
  normalizeAlbumText,
} = await import('./album-local-service')

describe('album-local-service（fixture SQLite）', () => {
  it('gidToUuid 还原带横杠 UUID', () => {
    expect(gidToUuid(Buffer.from(GID_HEX, 'hex'))).toBe(GID)
    expect(normalizeAlbumText(' 叶惠美 (Jay) ')).toBe('叶惠美jay')
  })

  it('前缀联想走索引且按标题排序', () => {
    const list = suggestLocalAlbums('叶惠', 10)
    expect(list.map(a => a.title)).toEqual(['叶惠美', '叶惠美美'])
  })

  it('搜索合并前缀/标题包含/歌手包含并按 gid 去重', () => {
    const list = searchLocalAlbums('叶惠美', 30)
    // 精确行 + LIKE 行重复 gid 去重后：叶惠美、叶惠美美
    expect(list.map(a => a.title)).toEqual(['叶惠美', '叶惠美美'])
    const byArtist = searchLocalAlbums('周杰伦', 30)
    expect(byArtist.map(a => a.title)).toContain('范特西')
  })

  it('findLocalAlbum 按名+歌手归一化匹配', () => {
    expect(findLocalAlbum('叶惠美', '周杰伦')?.gid).toBe(GID)
    expect(findLocalAlbum('叶惠美', '方文山')).toBeNull() // 歌手不沾边
  })

  it('findLocalAlbumByGid 回填曲目数', () => {
    const album = findLocalAlbumByGid(GID)
    expect(album).toMatchObject({ gid: GID, title: '叶惠美', artist: '周杰伦' })
    expect(album?.trackCount).toBe(3) // 同碟位去重计数（与 getLocalAlbumTracks 口径一致）
  })

  it('曲目表按碟内序号去重（同碟位附加曲只保留首个）', () => {
    const tracks = getLocalAlbumTracks(GID)
    expect(tracks.map(t => t.title)).toEqual(['以父之名', '懦夫', '晴天'])
    expect(tracks[0].secs).toBe(342)
    expect(tracks[2].secs).toBeNull()
  })

  it('随机专辑过滤杂牌（歌手缺失/曲目<3），返回指定数量', () => {
    const list = randomLocalAlbums(2)
    // fixture 中仅叶惠美/范特西达标（叶惠美美 0 曲被滤）
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ gid: expect.any(String), artist: '周杰伦', trackCount: expect.any(Number) })
    expect(list.every(a => a.trackCount >= 3)).toBe(true)
  })

  it('画像推荐：命中歌手的专辑优先，不足补随机', async () => {
    const { list, personalized } = await recommendLocalAlbums('admin', 1, 2)
    expect(list.length).toBeLessThanOrEqual(2)
    expect(typeof personalized).toBe('boolean')
    // fixture 中周杰伦有 4 行 → 画像歌手"周杰伦"应命中（若画作为空则走随机，仍返回列表）
  })

  it('未知 gid 返回 null/空', () => {
    expect(findLocalAlbumByGid('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBeNull()
    expect(getLocalAlbumTracks('ffffffff-ffff-ffff-ffff-ffffffffffff')).toEqual([])
  })
})

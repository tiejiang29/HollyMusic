import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findUnique, create, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}))

vi.mock('./generated/prisma', () => ({
  PrismaClient: class {
    musicInfo = { findUnique, create, update }
  },
  Prisma: {},
}))
vi.mock('./logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))

const { upsertMusicInfo, getMusicInfo, mergeMusicInfoPreserving, computeChecksum, intervalToSeconds } = await import('./db')

const musicInfo = {
  source: 'kw' as const,
  songmid: '123',
  name: '测试歌曲',
  singer: '测试歌手',
  interval: '3:00',
  types: [],
  _types: {},
  typeUrl: {},
}

import type { MusicInfo } from '@/lib/types/music'

/** 库里那种"发现页/歌单入库"的完整行：带封面、带源标识、带音质表 */
const richRow: MusicInfo = {
  source: 'tx', songmid: '002NmjQb', name: '曹操', singer: '林俊杰', interval: '04:04',
  img: 'https://cover/tx/1.jpg', strMediaMid: '003abc', albumId: 'al-1',
  types: [{ type: 'flac', size: '34M' }],
  _types: { flac: { size: '34M' } } as MusicInfo['_types'],
  typeUrl: {},
}

/** 模拟 music-core 搜索映射那种载荷：img 恒 null、types 可能空、别的源的字段干脆不带 */
const thinFromSearch: MusicInfo = {
  ...richRow, interval: '244', img: null, types: [],
  _types: {} as MusicInfo['_types'],
}

describe('upsertMusicInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('并发插入触发 P2002 时重新读取并更新，而不是记录为入库错误', async () => {
    findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ checksum: 'outdated-checksum' })
    create.mockRejectedValueOnce(Object.assign(new Error('unique constraint'), { code: 'P2002' }))
    update.mockResolvedValueOnce({})

    await expect(upsertMusicInfo(musicInfo)).resolves.toEqual({ action: 'update' })

    expect(findUnique).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenCalledTimes(1)
  })
})

describe('getMusicInfo 读库边界归一化', () => {
  it('data 里缺 types 的历史行补成空数组（下游 .map 不再抛），其余字段原样透出', async () => {
    // 重建索引 / push-music-info 批量导入 / 老版本写入都可能留下这种行
    findUnique.mockResolvedValueOnce({
      data: JSON.stringify({ source: 'tx', songmid: '002NmjQb', name: '曹操', singer: '林俊杰' }),
    })

    const mi = await getMusicInfo('tx', '002NmjQb')

    expect(mi?.types).toEqual([])
    expect(mi?.name).toBe('曹操')
    expect(mi?.songmid).toBe('002NmjQb')
  })

  it('types 形态异常（非数组）同样归零，合法数组原样保留', async () => {
    findUnique.mockResolvedValueOnce({
      data: JSON.stringify({ source: 'kw', songmid: 'a', types: null }),
    })
    expect((await getMusicInfo('kw', 'a'))?.types).toEqual([])

    findUnique.mockResolvedValueOnce({
      data: JSON.stringify({ source: 'kw', songmid: 'b', types: [{ type: '320k', size: '7MB' }] }),
    })
    expect((await getMusicInfo('kw', 'b'))?.types).toEqual([{ type: '320k', size: '7MB' }])
  })
})

describe('mergeMusicInfoPreserving：只补不减', () => {
  it('新载荷缺的字段（img null / types 空数组 / 压根没有的键）一律保留库里那份', () => {
    const merged = mergeMusicInfoPreserving(richRow, thinFromSearch)
    expect(merged.img).toBe(richRow.img)
    expect(merged.types).toEqual(richRow.types)
    expect(merged.strMediaMid).toBe(richRow.strMediaMid)
    expect(merged.albumId).toBe(richRow.albumId)
    // 新载荷带的值以新的为准
    expect(merged.interval).toBe('244')
  })

  it('上游真改了值（换封面 / 改名）时新值生效，不会被旧值挡掉', () => {
    const merged = mergeMusicInfoPreserving(richRow, { ...richRow, img: 'https://cover/tx/new.jpg', name: '曹操 (Live)' })
    expect(merged.img).toBe('https://cover/tx/new.jpg')
    expect(merged.name).toBe('曹操 (Live)')
  })

  it('空串/空对象也算没值', () => {
    const merged = mergeMusicInfoPreserving(
      { ...richRow, albumName: '建安七年', lrcUrl: 'https://lrc/1' },
      { ...richRow, albumName: '', lrcUrl: undefined },
    )
    expect(merged.albumName).toBe('建安七年')
    expect(merged.lrcUrl).toBe('https://lrc/1')
  })
})

describe('upsertMusicInfo 的 update 分支不再把完整行改薄', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const storedJson = JSON.stringify(richRow)

  it('薄载荷进来：写回的仍是合并后的完整值（合并带来变化时才真写）', async () => {
    findUnique.mockResolvedValueOnce({ checksum: 'stored-checksum', data: storedJson })
    update.mockResolvedValueOnce({})

    await expect(upsertMusicInfo(thinFromSearch)).resolves.toEqual({ action: 'update' })

    const arg = update.mock.calls[0][0]
    expect(arg.data.img).toBe('https://cover/tx/1.jpg')
    expect(arg.data.strMediaMid).toBe('003abc')
    expect(arg.data.typesJson).toBe('[{"type":"flac","size":"34M"}]')
    expect(JSON.parse(arg.data.data).img).toBe('https://cover/tx/1.jpg')
  })

  it('合并后与库里完全一致 → noop，不白写一遍（否则每次搜索都刷新 updatedAt）', async () => {
    // 载荷只是"缺字段"、没有真变化时，整条写入应该省掉
    const onlyMissingFields: MusicInfo = { ...richRow, img: null, types: [], _types: {} as MusicInfo['_types'] }
    findUnique.mockResolvedValueOnce({ checksum: computeChecksum(richRow), data: storedJson })

    await expect(upsertMusicInfo(onlyMissingFields)).resolves.toEqual({ action: 'noop' })
    expect(update).not.toHaveBeenCalled()
  })

  it('库里 data 是坏 JSON 时退回按新载荷写，不抛错', async () => {
    findUnique.mockResolvedValueOnce({ checksum: 'x', data: '{oops' })
    update.mockResolvedValueOnce({})

    await expect(upsertMusicInfo(thinFromSearch)).resolves.toEqual({ action: 'update' })
    expect(update).toHaveBeenCalledTimes(1)
  })
})

describe('intervalToSeconds：mm:ss 也得算出秒数', () => {
  it('三种写法都能解，脏值与空值给 null', () => {
    expect(intervalToSeconds('03:47')).toBe(227)
    expect(intervalToSeconds('1:02:03')).toBe(3723)
    expect(intervalToSeconds('297')).toBe(297)
    expect(intervalToSeconds(297)).toBe(297)
    expect(intervalToSeconds('0:45')).toBe(45)
    expect(intervalToSeconds('')).toBeNull()
    expect(intervalToSeconds(null)).toBeNull()
    expect(intervalToSeconds(undefined)).toBeNull()
    expect(intervalToSeconds('0:00')).toBeNull()        // 零时长等于不知道
    expect(intervalToSeconds('N/A')).toBeNull()
    expect(intervalToSeconds('3:4:5:6')).toBeNull()
    expect(intervalToSeconds('abc:def')).toBeNull()
  })

  it('建形时 mm:ss 会真的落进 durationSeconds 列（旧实现 Number() 得 NaN ⇒ 整源为空）', async () => {
    findUnique.mockResolvedValueOnce(null)
    create.mockResolvedValueOnce({})
    await upsertMusicInfo({ ...musicInfo, interval: '03:47' })
    expect(create.mock.calls[0][0].data.durationSeconds).toBe(227)
  })
})

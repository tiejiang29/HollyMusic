import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findUnique, findMany, create, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}))

vi.mock('./generated/prisma', () => ({
  PrismaClient: class {
    musicInfo = { findUnique, findMany, create, update }
  },
  Prisma: {},
}))
vi.mock('./logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))

const { upsertMusicInfo, getMusicInfo, getMusicInfoMapByIds, getMusicInfoRowIdsByUids, resolveMusicInfoById, mergeMusicInfoPreserving, computeChecksum, intervalToSeconds } = await import('./db')

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

describe('intervalToSeconds：mm:ss 也得算出秒数', () => {  it('三种写法都能解，脏值与空值给 null', () => {
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

describe('getMusicInfoMapByIds：列表接口的批量反查（消 N+1）', () => {
  const kwRow = (songmid: string, over: Record<string, unknown> = {}) => ({
    source: 'kw', songmid, data: JSON.stringify({ source: 'kw', songmid, name: '歌' + songmid, ...over }),
  })

  beforeEach(() => {
    findUnique.mockReset()
    findMany.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('按源分组，每源一条查询，Map 的键就是传进来的原 id', async () => {
    findMany.mockImplementation(async ({ where }: { where: { source: string; songmid: { in: string[] } } }) =>
      [...where.songmid.in].map(m => ({
        source: where.source, songmid: m,
        data: JSON.stringify({ source: where.source, songmid: m, name: '歌' + m }),
      })))

    const map = await getMusicInfoMapByIds(['kw-1', 'kw-2', 'tx-002NmjQb', 'kg-C4904D4E3BBA872D41D3BDBF597E2B18'])

    expect(findUnique).not.toHaveBeenCalled()
    expect(findMany).toHaveBeenCalledTimes(3)
    expect(new Set(findMany.mock.calls.map(c => c[0].where.source))).toEqual(new Set(['kw', 'tx', 'kg']))
    expect(findMany.mock.calls.find(c => c[0].where.source === 'kw')[0].where.songmid.in).toEqual(['1', '2'])
    // kg 的存储键是 FileHash，复合格式里第一段是 source，剩下全是 songmid
    expect(findMany.mock.calls.find(c => c[0].where.source === 'kg')[0].where.songmid.in).toEqual(['C4904D4E3BBA872D41D3BDBF597E2B18'])
    expect([...map.keys()].sort()).toEqual(['kg-C4904D4E3BBA872D41D3BDBF597E2B18', 'kw-1', 'kw-2', 'tx-002NmjQb'])
    // 与单条路径同一套归一化：data 缺 types 的旧行补成空数组，下游 .map 不炸
    expect(map.get('kw-1')?.types).toEqual([])
  })

  it('重复 id 只查一次，songmid 里含 "-" 的（本地文件路径）不被切坏', async () => {
    findMany.mockImplementation(async ({ where }: { where: { source: string; songmid: { in: string[] } } }) =>
      [...where.songmid.in].map(m => ({ source: where.source, songmid: m, data: JSON.stringify({ source: where.source, songmid: m }) })))

    await getMusicInfoMapByIds(['kw-1', 'kw-1', 'kw-1'])
    expect(findMany.mock.calls[0][0].where.songmid.in).toEqual(['1'])

    const map = await getMusicInfoMapByIds(['localfile-/music/a-b.mp3'])
    expect(findMany.mock.calls[1][0].where).toEqual({ source: 'localfile', songmid: { in: ['/music/a-b.mp3'] } })
    expect(map.get('localfile-/music/a-b.mp3')?.songmid).toBe('/music/a-b.mp3')
  })

  it('解析不了的 id 直接跳过，不发无谓的查询', async () => {
    findMany.mockResolvedValue([])
    const map = await getMusicInfoMapByIds(['noseparator', '-开头', '结尾-', '', null, undefined])
    expect(findMany).not.toHaveBeenCalled()
    expect(map.size).toBe(0)
  })

  it('坏 JSON 的行跳过且不抛，同批正常行照常返回', async () => {
    findMany.mockResolvedValue([
      { source: 'kw', songmid: 'bad', data: '{不是 JSON' },
      { source: 'kw', songmid: 'empty', data: '' },
      kwRow('ok'),
    ])
    const map = await getMusicInfoMapByIds(['kw-bad', 'kw-empty', 'kw-ok'])
    expect([...map.keys()]).toEqual(['kw-ok'])
  })

  it('单条入口 resolveMusicInfoById 与批量共用同一口径（畸形 id 两边都不查库）', async () => {
    findUnique.mockResolvedValue(null)
    expect(await resolveMusicInfoById('noseparator')).toBeNull()
    expect(await resolveMusicInfoById('结尾-')).toBeNull()
    expect(await resolveMusicInfoById('')).toBeNull()
    expect(findUnique).not.toHaveBeenCalled()

    await resolveMusicInfoById('kw-1')
    expect(findUnique).toHaveBeenCalledWith({ where: { source_songmid: { source: 'kw', songmid: '1' } } })
  })
})

describe('getMusicInfoRowIdsByUids：只要行主键的批量反查', () => {
  beforeEach(() => {
    findMany.mockReset()
  })

  it('每源一条查询，且 select 里不带 data（这正是它区别于 getMusicInfoMapByIds 的地方）', async () => {
    findMany.mockImplementation(async ({ where }: { where: { source: string; songmid: { in: string[] } } }) =>
      [...where.songmid.in].map((m, i) => ({ id: 1000 + i, songmid: m })))

    const ids = await getMusicInfoRowIdsByUids(['kw-1', 'kw-2', 'tx-002NmjQb', 'kg-ABC'])

    expect(findMany).toHaveBeenCalledTimes(3)
    for (const call of findMany.mock.calls) {
      expect(call[0].select).toEqual({ id: true, songmid: true })
      expect(call[0].where.data).toBeUndefined()
    }
    expect([...ids.entries()].sort()).toEqual([['kg-ABC', 1000], ['kw-1', 1000], ['kw-2', 1001], ['tx-002NmjQb', 1000]])
  })

  it('库里没有这首歌的 id 不会出现在 Map 里（调用方据此落 null，而不是把不存在的行挂上）', async () => {
    findMany.mockImplementation(async ({ where }: { where: { source: string; songmid: { in: string[] } } }) =>
      where.source === 'kw' ? [{ id: 7, songmid: '1' }] : [])

    const ids = await getMusicInfoRowIdsByUids(['kw-1', 'kw-404', 'tx-999'])

    expect([...ids.keys()]).toEqual(['kw-1'])
    expect(ids.get('kw-404')).toBeUndefined()
  })

  it('畸形 id 与空输入都不发查询', async () => {
    expect(await getMusicInfoRowIdsByUids([])).toEqual(new Map())
    const ids = await getMusicInfoRowIdsByUids(['noseparator', '-开头', '结尾-', ''])
    expect(ids.size).toBe(0)
    expect(findMany).not.toHaveBeenCalled()
  })
})

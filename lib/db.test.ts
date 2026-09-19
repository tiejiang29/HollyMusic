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

const { upsertMusicInfo, getMusicInfo } = await import('./db')

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

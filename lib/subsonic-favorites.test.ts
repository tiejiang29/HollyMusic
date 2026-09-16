/**
 * lib/subsonic-favorites.ts 测试
 *
 * 守 Subsonic 星标的三组参数口径（id=歌曲 / albumId=专辑 / artistId=艺术家）：
 * - 专辑星标要按 albumId 走 itemType='album'，并借 id（= 代表曲存储键）取一份展示快照；
 * - 快照取不到不能影响收藏本身；
 * - 三组参数全空才报错（50 / 10），保持旧客户端只传 id 时的行为不变。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { starItems, unstarItems } = vi.hoisted(() => ({
  starItems: vi.fn(async () => ({ created: 1 })),
  unstarItems: vi.fn(async () => ({ deleted: 1 })),
}))

vi.mock('./favorites', () => ({
  default: { starItems, unstarItems },
  starItems,
  unstarItems,
}))

const { resolveMusicInfoById } = vi.hoisted(() => ({ resolveMusicInfoById: vi.fn() }))
vi.mock('./db', () => ({ resolveMusicInfoById }))

const { handleStar, handleUnstar } = await import('./subsonic-favorites')

const auth = { user: { id: 1, username: 'tester' } } as never

function req(qs: string): NextRequest {
  return new NextRequest(`http://localhost/rest/star.view?f=json&${qs}`)
}

async function errorCode(response: Response): Promise<number | undefined> {
  const payload = await response.json() as { 'subsonic-response': { error?: { code: number } } }
  return payload['subsonic-response'].error?.code
}

beforeEach(() => {
  starItems.mockClear()
  starItems.mockResolvedValue({ created: 1 })
  unstarItems.mockClear()
  resolveMusicInfoById.mockReset()
})

describe('handleStar', () => {
  it('albumId 走 itemType=album，并用 albumId 取展示快照', async () => {
    resolveMusicInfoById.mockResolvedValueOnce({
      albumName: '范特西',
      singer: '周杰伦',
      img: 'http://img/f.jpg',
    })

    const res = await handleStar(req('albumId=t1-album-9'), auth)

    expect(res.status).toBe(200)
    // 本站专辑 id 就是代表曲的存储键，借它回查快照
    expect(resolveMusicInfoById).toHaveBeenCalledWith('t1-album-9')
    expect(starItems).toHaveBeenCalledWith(1, [{
      itemType: 'album',
      itemId: 't1-album-9',
      source: 't1',
      name: '范特西',
      singer: '周杰伦',
      img: 'http://img/f.jpg',
    }])
  })

  it('快照取不到时仍然收藏成功，只存 id（读取侧用 id 兜底显示）', async () => {
    resolveMusicInfoById.mockResolvedValueOnce(null)

    const res = await handleStar(req('albumId=kw-album-1'), auth)

    expect(res.status).toBe(200)
    expect(starItems.mock.calls[0][1][0]).toEqual({
      itemType: 'album',
      itemId: 'kw-album-1',
      source: 'kw',
    })
  })

  it('解析快照抛错也不阻断收藏', async () => {
    resolveMusicInfoById.mockRejectedValueOnce(new Error('boom'))

    const res = await handleStar(req('albumId=mg-album-2'), auth)

    expect(res.status).toBe(200)
    expect(starItems).toHaveBeenCalledTimes(1)
  })

  it('artistId 走 itemType=artist，不带 source', async () => {
    await handleStar(req('artistId=ar-77'), auth)

    expect(starItems.mock.calls[0][1][0]).toEqual({ itemType: 'artist', itemId: 'ar-77', source: null })
  })

  it('id（歌曲）行为不变：仍按 source-songmid 解析 source', async () => {
    await handleStar(req('id=tx-abc'), auth)

    expect(starItems.mock.calls[0][1]).toEqual([{ itemType: 'song', itemId: 'tx-abc', source: 'tx' }])
    expect(resolveMusicInfoById).not.toHaveBeenCalled()
  })

  it('三种参数可同时传，混合成一个批次', async () => {
    resolveMusicInfoById.mockResolvedValue({ albumName: 'A', singer: 'S', img: 'I' })

    await handleStar(req('id=tx-abc&albumId=t1-album-9&artistId=ar-77'), auth)

    expect(starItems.mock.calls[0][1]).toEqual([
      { itemType: 'song', itemId: 'tx-abc', source: 'tx' },
      { itemType: 'album', itemId: 't1-album-9', source: 't1', name: 'A', singer: 'S', img: 'I' },
      { itemType: 'artist', itemId: 'ar-77', source: null },
    ])
  })

  it('三组参数全空时报 50', async () => {
    const res = await handleStar(req(''), auth)

    expect(await errorCode(res)).toBe(50)
    expect(starItems).not.toHaveBeenCalled()
  })
})

describe('handleUnstar', () => {
  it('albumId 按 album 类型删除，不传 source（删该 id 下全部平台记录）', async () => {
    const res = await handleUnstar(new NextRequest('http://localhost/rest/unstar.view?f=json&albumId=t1-album-9'), auth)

    expect(res.status).toBe(200)
    expect(unstarItems).toHaveBeenCalledWith(1, [{ itemType: 'album', itemId: 't1-album-9', source: null }])
  })

  it('歌曲取消收藏行为不变', async () => {
    await handleUnstar(new NextRequest('http://localhost/rest/unstar.view?f=json&id=tx-abc'), auth)

    expect(unstarItems).toHaveBeenCalledWith(1, [{ itemType: 'song', itemId: 'tx-abc', source: null }])
  })

  it('三组参数全空时报 10', async () => {
    const res = await handleUnstar(new NextRequest('http://localhost/rest/unstar.view?f=json'), auth)

    expect(await errorCode(res)).toBe(10)
    expect(unstarItems).not.toHaveBeenCalled()
  })
})

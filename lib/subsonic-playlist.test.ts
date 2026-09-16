import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { findMany, findUnique, findFavoriteMany, create } = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findFavoriteMany: vi.fn(),
  create: vi.fn(),
}))

vi.mock('./generated/prisma', () => ({
  PrismaClient: class {
    playlist = { findMany, findUnique, create }
    favorite = { findMany: findFavoriteMany }
  },
  Prisma: {},
}))

const { handleGetPlaylist, handleGetPlaylists, handleCreatePlaylist } = await import('./subsonic-playlist')

describe('handleGetPlaylists', () => {
  it('在 JSON 模式下始终将 playlist 返回为数组', async () => {
    findMany.mockResolvedValueOnce([
      {
        id: 1,
        name: '测试歌单',
        comment: null,
        owner: 'tester',
        username: 'tester',
        isPublic: false,
        songCount: 0,
        duration: 0,
        createdAt: new Date('2026-08-22T00:00:00Z'),
        coverArt: null,
        allowedUsers: [],
      },
    ])

    const response = await handleGetPlaylists(
      new NextRequest('http://localhost/rest/getPlaylists.view?f=json'),
      { user: { id: 1, username: 'tester' } } as never,
    )
    const payload = await response.json() as {
      'subsonic-response': { playlists: { playlist: Array<{ id: number }> } }
    }

    expect(response.headers.get('content-type')).toContain('application/json')
    expect(payload['subsonic-response'].playlists.playlist).toEqual([
        expect.objectContaining({ id: '1' }),
    ])
  })

  it('在 JSON 模式下始终将歌单条目返回为 entry 数组', async () => {
    findUnique.mockResolvedValueOnce({
      id: 1,
      name: '测试歌单',
      comment: null,
      owner: 'tester',
      username: 'tester',
      isPublic: false,
      songCount: 1,
      duration: 180,
      createdAt: new Date('2026-08-22T00:00:00Z'),
      coverArt: null,
      allowedUsers: [{ username: 'tester' }],
      entries: [{
        id: 1,
        songmid: 'tx-song-id',
        addedAt: new Date('2026-08-22T00:00:00Z'),
        snapshotJson: null,
        musicInfo: {
          source: 'tx',
          songmid: 'song-id',
          name: '测试歌曲',
          singer: '测试歌手',
          albumName: '测试专辑',
          durationSeconds: 180,
        },
      }],
    })
    findFavoriteMany.mockResolvedValueOnce([
      { itemId: 'tx-song-id', createdAt: new Date('2026-08-22T01:02:03Z') },
    ])

    const response = await handleGetPlaylist(
      new NextRequest('http://localhost/rest/getPlaylist.view?f=json&id=1'),
      { user: { id: 1, username: 'tester' } } as never,
    )
    const payload = await response.json() as {
      'subsonic-response': { playlist: { entry: Array<{ id: string }> } }
    }

    expect(response.headers.get('content-type')).toContain('application/json')
    expect(payload['subsonic-response'].playlist.entry).toEqual([
      expect.objectContaining({ id: 'tx-song-id', starred: '2026-08-22T01:02:03' }),
    ])
  })
})

describe('handleCreatePlaylist', () => {
  it('新建歌单写入 collected=true（第三方客户端推来的歌单归「收藏歌单」分组）', async () => {
    create.mockResolvedValueOnce({
      id: 7,
      name: '客户端歌单',
      owner: 'tester',
      username: 'tester',
      isPublic: false,
      songCount: 0,
    })

    const response = await handleCreatePlaylist(
      new NextRequest('http://localhost/rest/createPlaylist.view?f=json&name=' + encodeURIComponent('客户端歌单')),
      { user: { id: 1, username: 'tester' } } as never,
    )
    const payload = await response.json() as { 'subsonic-response': { playlist: { id: string } } }

    expect(response.status).toBe(200)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: '客户端歌单', username: 'tester', collected: true }),
    }))
    expect(payload['subsonic-response'].playlist.id).toBe('7')
  })
})

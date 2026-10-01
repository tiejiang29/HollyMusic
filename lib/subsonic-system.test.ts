import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { resolveMusicInfoById, reportPlay, updateLastSeen } = vi.hoisted(() => ({
  resolveMusicInfoById: vi.fn(),
  reportPlay: vi.fn(),
  updateLastSeen: vi.fn(),
}))

vi.mock('./generated/prisma', () => ({
  PrismaClient: class {},
}))
// prisma 现由 lib/db 统一提供（本模块不再自建客户端）；本用例覆盖的
// getLicense/scrobble 分支不触库，空对象即可
vi.mock('./db', () => ({ prisma: {}, resolveMusicInfoById }))
vi.mock('./services/history-service', () => ({ reportPlay }))
// Subsonic 客户端不发心跳，scrobble 是它唯一的活跃信号，因此这里要记一次最近活跃
vi.mock('./user', () => ({
  updateLastSeenByUsername: updateLastSeen,
  getClientIp: () => '172.16.1.49',
  getUa: () => 'Symfonium/6.0',
}))

const { handleGetLicense, handleScrobble } = await import('./subsonic-system')

describe('handleGetLicense', () => {
  it('向传统 Subsonic 客户端声明无需商业许可证', async () => {
    const response = handleGetLicense(
      new NextRequest('http://localhost/rest/getLicense.view?f=json'),
    )

    expect(await response.json()).toEqual({
      'subsonic-response': {
        status: 'ok',
        version: '1.16.1',
        license: { valid: true },
      },
    })
  })
})

describe('handleScrobble', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('将缺省 submission 的 Subsonic 客户端上报写入当前用户播放历史', async () => {
    const musicInfo = {
      source: 'kw', songmid: '123', name: '测试歌曲', singer: '测试歌手',
      interval: '3:00', types: [], _types: {}, typeUrl: {},
    }
    resolveMusicInfoById.mockResolvedValueOnce(musicInfo)

    const response = await handleScrobble(
      new NextRequest('http://localhost/rest/scrobble.view?id=kw-123'),
      { user: { id: 1, username: 'tester' }, verified: true },
    )

    expect(resolveMusicInfoById).toHaveBeenCalledWith('kw-123')
    expect(reportPlay).toHaveBeenCalledWith('tester', musicInfo)
    expect(updateLastSeen).toHaveBeenCalledWith('tester', '172.16.1.49', 'Symfonium/6.0')
    expect(await response.text()).toContain('status="ok"')
  })

  it('submission=false 的正在播放通知不写入播放历史', async () => {
    const response = await handleScrobble(
      new NextRequest('http://localhost/rest/scrobble.view?id=kw-123&submission=false'),
      { user: { id: 1, username: 'tester' }, verified: true },
    )

    expect(resolveMusicInfoById).not.toHaveBeenCalled()
    expect(reportPlay).not.toHaveBeenCalled()
    expect(updateLastSeen).not.toHaveBeenCalled()
    expect(await response.text()).toContain('status="ok"')
  })
})

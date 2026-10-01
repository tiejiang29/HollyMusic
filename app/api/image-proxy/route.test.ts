/**
 * app/api/image-proxy/route.ts 的白名单测试
 *
 * 盯两件生产上真出过的事：① QQ 用户上传歌单封面落在 music-file.y.qq.com，
 * 白名单当时只有具体主机 qpic.y.qq.com → 同族子域一律 403，车机上直连兜底也救不回来；
 * ② 403 分支原先不记日志，这类问题在服务端完全不可见。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { safePublicFetch, warn } = vi.hoisted(() => ({
  safePublicFetch: vi.fn(async () => ({
    ok: true,
    headers: { get: (k: string) => (k === 'content-type' ? 'image/jpeg' : null) },
    arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
  })),
  warn: vi.fn(),
}))

vi.mock('@/lib/server/url-guard', async importActual => ({
  ...(await importActual<typeof import('@/lib/server/url-guard')>()),
  safePublicFetch,
}))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } }))

const { GET } = await import('./route')

const get = (url: string) => GET(new NextRequest(new URL(`http://localhost:3000/api/image-proxy?url=${encodeURIComponent(url)}`)))

beforeEach(() => {
  safePublicFetch.mockClear()
  warn.mockClear()
})

describe('GET /api/image-proxy 域名白名单', () => {
  it('QQ 用户上传歌单封面（music-file.y.qq.com）必须放行', async () => {
    const res = await get('https://music-file.y.qq.com/songlist/user/abc.jpg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(await res.arrayBuffer()).toEqual(Uint8Array.from([1, 2, 3, 4]).buffer)
    expect(safePublicFetch).toHaveBeenCalledWith(
      'https://music-file.y.qq.com/songlist/user/abc.jpg',
      expect.objectContaining({ headers: expect.objectContaining({ Referer: 'https://music-file.y.qq.com/' }) }),
    )
  })

  it.each([
    ['QQ 原有主机', 'https://qpic.y.qq.com/foo/cover_b.jpg'],
    ['网易云', 'https://p1.music.126.net/x/y.jpg'],
    ['咪咕', 'https://d.musicapp.migu.cn/z.webp'],
  ])('已在名单里的平台域名照常放行：%s', async (_label, url) => {
    await expect(get(url as string).then(r => r.status)).resolves.toBe(200)
  })

  it('名单外主机 403、不打上游，并且留下日志（否则这类故障在服务端不可见）', async () => {
    const res = await get('https://evil.example.com/a.jpg')
    expect(res.status).toBe(403)
    expect(safePublicFetch).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    // 主机名必须出现在这条日志里（logger.warn(prefix, hostname) 是两个参数）
    expect(warn.mock.calls.flat().join(' ')).toContain('evil.example.com')
  })

  it('拿白名单域名当跳板也不行：后缀必须是点边界', async () => {
    // notgtimg.cn.evil.tld 以 "gtimg.cn" 之外的主机结尾，不能被后缀匹配放过
    await expect(get('https://notgtimg.cn.evil.tld/a.jpg').then(r => r.status)).resolves.toBe(403)
    await expect(get('https://gtimg.cn.evil.tld/a.jpg').then(r => r.status)).resolves.toBe(403)
  })
})

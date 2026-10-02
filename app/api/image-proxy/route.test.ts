/**
 * app/api/image-proxy/route.ts 的白名单与 w 缩略参数测试
 *
 * 盯两件生产上真出过的事：① QQ 用户上传歌单封面落在 music-file.y.qq.com，
 * 白名单当时只有具体主机 qpic.y.qq.com → 同族子域一律 403，车机上直连兜底也救不回来；
 * ② 403 分支原先不记日志，这类问题在服务端完全不可见。
 * 另有 `w=` 的口径：只对网易云生效、不覆盖已有 param、不同 w 必须是不同缓存条目、
 * 单张超 1MB 只透传不缓存（图片缓存已从 searchCache 拆到独立的 imageCache）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { imageCache, searchCache } from '@/lib/cache-manager'

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

const getW = (url: string, w?: string | number) =>
  GET(new NextRequest(new URL(`http://localhost:3000/api/image-proxy?url=${encodeURIComponent(url)}${w === undefined ? '' : `&w=${w}`}`)))

describe('GET /api/image-proxy 的 w 缩略参数', () => {
  beforeEach(() => {
    imageCache.clear()
  })

  const upstreamUrl = () => String(safePublicFetch.mock.calls.at(-1)?.[0])

  it('网易云 + w=300 → 打上游时拼 param=300y300（它的 CDN 只认这一套）', async () => {
    const res = await getW('https://p1.music.126.net/abc/1099511.jpg', 300)
    expect(res.status).toBe(200)
    expect(upstreamUrl()).toBe('https://p1.music.126.net/abc/1099511.jpg?param=300y300')
  })

  it('原 URL 已经带了 param 就不覆盖（平台自己选好的尺寸别动）', async () => {
    await getW('https://p1.music.126.net/abc/2.jpg?param=500x500', 300)
    expect(upstreamUrl()).toBe('https://p1.music.126.net/abc/2.jpg?param=500x500')
  })

  it('其余平台一个字节都不动：它们的尺寸语法各不相同，乱拼只会取不到图', async () => {
    for (const url of [
      'https://y.gtimg.cn/music/photo_new/T002R300x300M000.jpg',
      'https://img.kuwo.cn/a/b.jpg',
      'https://d.musicapp.migu.cn/z.webp',
    ]) {
      await getW(url, 300)
      expect(upstreamUrl()).toBe(url)
    }
  })

  it('w 非法或超界就当没传（32~1000 之外一律原样透传，不把请求打成错误）', async () => {
    const bad = ['0', '31', '1001', '99999', 'abc', '300.5', '', undefined]
    for (let i = 0; i < bad.length; i++) {
      const url = `https://p1.music.126.net/bad/${i}.jpg`   // 每条一个唯一路径，免得撞缓存
      await getW(url, bad[i])
      expect(upstreamUrl(), `w=${String(bad[i])}`).toBe(url)
    }
  })

  it('不同 w 必须是不同缓存条目，同 w 第二次不再打上游', async () => {
    const url = 'https://p1.music.126.net/cache/me.jpg'
    await getW(url, 200)
    await getW(url, 200)
    expect(safePublicFetch).toHaveBeenCalledTimes(1)

    await getW(url, 500)
    expect(safePublicFetch).toHaveBeenCalledTimes(2)
    expect(upstreamUrl()).toBe('https://p1.music.126.net/cache/me.jpg?param=500y500')
  })

  it('图片字节走 imageCache，不再占搜索结果的额度（两边原先互相挤）', async () => {
    await getW('https://p1.music.126.net/iso/a.jpg', 300)
    expect(searchCache.getStats().size).toBe(0)
    expect(imageCache.getStats().size).toBe(1)
  })

  it('单张超过 1MB 只透传不缓存，否则一张就顶十几张的额度', async () => {
    imageCache.clear()
    safePublicFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (k: string) => (k === 'content-type' ? 'image/jpeg' : null) },
      arrayBuffer: async () => new Uint8Array(1024 * 1024 + 1).buffer,
    })
    const url = 'https://p1.music.126.net/big/a.jpg'
    const res = await get(url)
    expect(res.status).toBe(200)
    expect(imageCache.getStats().size).toBe(0)

    await get(url)
    expect(safePublicFetch).toHaveBeenCalledTimes(2)   // 没缓存，第二次还得打上游
  })
})

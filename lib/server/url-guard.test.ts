/**
 * lib/server/url-guard.ts 测试
 *
 * 守三道 SSRF 口径：
 * 1. assertPublicHttpUrl 拒绝非 http(s)、带账号信息、本机/私网/无法解析的地址；
 * 2. safePublicFetch 以 redirect:'manual' 逐跳请求，第一跳的 302 目标若是私网必须拦下；
 * 3. 重定向链超过上限时抛 TOO_MANY_REDIRECTS，不无限跟随。
 *
 * 用例统一使用 IP 字面量（8.8.8.8 / 127.0.0.1），避免真实 DNS 查询。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertPublicHttpUrl, isPublicIp, safePublicFetch, SafeFetchError } from './url-guard'

describe('isPublicIp', () => {
  it('公网地址通过，私网/保留段拒绝', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true)
    expect(isPublicIp('127.0.0.1')).toBe(false)
    expect(isPublicIp('10.1.2.3')).toBe(false)
    expect(isPublicIp('172.16.0.1')).toBe(false)
    expect(isPublicIp('192.168.1.1')).toBe(false)
    expect(isPublicIp('169.254.169.254')).toBe(false)
    expect(isPublicIp('100.64.0.1')).toBe(false)
    expect(isPublicIp('::1')).toBe(false)
    expect(isPublicIp('::ffff:127.0.0.1')).toBe(false)
    expect(isPublicIp('fe80::1')).toBe(false)
    expect(isPublicIp('不是ip')).toBe(false)
  })
})

describe('assertPublicHttpUrl', () => {
  it('非 http(s) 与带账号信息的地址拒绝', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow('仅支持 HTTP 或 HTTPS')
    await expect(assertPublicHttpUrl('http://user:pw@8.8.8.8/x')).rejects.toThrow('不能包含账号信息')
    await expect(assertPublicHttpUrl('不是url')).rejects.toThrow('无效的 URL')
  })

  it('本机与私网地址拒绝，公网 IP 通过', async () => {
    await expect(assertPublicHttpUrl('http://localhost:3001/')).rejects.toThrow('不允许访问本机或内网地址')
    await expect(assertPublicHttpUrl('http://127.0.0.1/x')).rejects.toThrow('不允许访问本机、内网或无法解析的地址')
    await expect(assertPublicHttpUrl('http://192.168.1.7:3099/x')).rejects.toThrow('不允许访问本机、内网或无法解析的地址')
    await expect(assertPublicHttpUrl('https://8.8.8.8/logo.png')).resolves.toBeInstanceOf(URL)
  })
})

describe('safePublicFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('第一跳 302 跳私网时抛 BLOCKED_URL，且不再发起第二次请求', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3001/api/health' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(safePublicFetch('https://8.8.8.8/img.png')).rejects.toMatchObject({
      name: 'SafeFetchError',
      code: 'BLOCKED_URL',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
  })

  it('公网重定向按跳跟随，最终返回响应', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://8.8.8.8/a.png') {
        return new Response(null, { status: 301, headers: { location: '/b.png' } })
      }
      return new Response('img', { status: 200, headers: { 'content-type': 'image/png' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const resp = await safePublicFetch('https://8.8.8.8/a.png')
    expect(resp.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // 相对 Location 按当前 URL 解析
    expect(fetchMock.mock.calls[1][0]).toBe('https://8.8.8.8/b.png')
  })

  it('重定向成环时抛 TOO_MANY_REDIRECTS', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'https://8.8.8.8/loop' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(safePublicFetch('https://8.8.8.8/loop', {}, 3)).rejects.toMatchObject({
      code: 'TOO_MANY_REDIRECTS',
    })
    expect(fetchMock).toHaveBeenCalledTimes(4) // 初始 + 3 次跟随
  })

  it('SafeFetchError 带 code，便于调用方区分 403 与 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302 })))
    const err = await safePublicFetch('https://8.8.8.8/x').catch(e => e)
    expect(err).toBeInstanceOf(SafeFetchError)
    expect(err.code).toBe('INVALID_REDIRECT')
  })
})

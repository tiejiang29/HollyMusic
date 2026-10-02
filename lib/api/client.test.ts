/**
 * lib/api/client.ts 的响应处理测试
 *
 * 钉两件事：
 * 1. 非 JSON 响应（nginx 502 直接回 HTML）要给成人能看懂的错误，而不是解析器原文
 *    "Unexpected token '<'…"；
 * 2. 401 要立刻通知上层掉登录态——以前只有心跳（每 2 分钟）会发现会话作废，
 *    中间这段时间用户每个操作都只弹"请先登录"，界面还显示登录着。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiGet, apiPost, setUnauthorizedHandler } from './client'

function respond(init: { status?: number; contentType?: string; body: string }): Response {
  return new Response(init.body, {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'application/json' },
  })
}

const ok = (data: unknown) => JSON.stringify({ success: true, data })

afterEach(() => {
  vi.unstubAllGlobals()
  setUnauthorizedHandler(null)
})

describe('正常与业务失败', () => {
  it('success 且有 data 时把 data 交出去', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ body: ok({ list: [1, 2] }) })))
    expect(await apiGet<{ list: number[] }>('favorites')).toEqual({ list: [1, 2] })
  })

  it('业务失败沿用服务端文案（不能改写成通用"请求失败"）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      respond({ status: 400, body: JSON.stringify({ success: false, error: { message: '缺少必填参数: id' } }) })))
    await expect(apiPost('favorites', {})).rejects.toThrow('缺少必填参数: id')
  })

  it('success:true 但 data 缺失也当失败（与改前口径一致）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ body: '{"success":true}' })))
    await expect(apiGet('favorites')).rejects.toThrow()
  })
})

describe('非 JSON 响应', () => {
  it('nginx 502 的 HTML 给的是状态码说明，不是解析器原文', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      respond({ status: 502, contentType: 'text/html', body: '<html><head><title>502 Bad Gateway</title></head><body>…</body></html>' })))

    const err = await apiGet('history').catch(e => e as Error)
    expect(err.message).toBe('请求失败（HTTP 502）')
    expect(err.message).not.toContain('Unexpected token')
  })

  it('200 却回了非 JSON（网关改写之类）也不抛 SyntaxError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ contentType: 'text/html', body: '<html>' })))
    await expect(apiGet('history')).rejects.toThrow('服务端返回了无法解析的内容')
  })

  it('响应体读不出来（流被掐断）同样走非 JSON 分支', async () => {
    const broken = { ok: true, status: 200, text: async () => { throw new Error('network reset') } } as unknown as Response
    vi.stubGlobal('fetch', vi.fn(async () => broken))
    await expect(apiGet('history')).rejects.toThrow('服务端返回了无法解析的内容')
  })
})

describe('401 立刻通知上层', () => {
  it('401 触发 handler，且服务端文案仍然透传', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    vi.stubGlobal('fetch', vi.fn(async () =>
      respond({ status: 401, body: JSON.stringify({ success: false, error: { message: '请先登录' } }) })))

    await expect(apiGet('favorites')).rejects.toThrow('请先登录')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('401 且 body 不是 JSON（nginx 挡在门前）也照样触发', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    vi.stubGlobal('fetch', vi.fn(async () =>
      respond({ status: 401, contentType: 'text/html', body: '<html>unauthorized</html>' })))

    await expect(apiGet('history')).rejects.toThrow('请求失败（HTTP 401）')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('没注册 handler 时 401 只是普通失败，不会炸', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      respond({ status: 401, body: JSON.stringify({ success: false, error: { message: '请先登录' } }) })))
    await expect(apiGet('favorites')).rejects.toThrow('请先登录')
  })

  it('非 401 不触发 handler', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    vi.stubGlobal('fetch', vi.fn(async () =>
      respond({ status: 403, body: JSON.stringify({ success: false, error: { message: '需要管理员权限' } }) })))

    await expect(apiGet('favorites')).rejects.toThrow('需要管理员权限')
    expect(handler).not.toHaveBeenCalled()
  })
})

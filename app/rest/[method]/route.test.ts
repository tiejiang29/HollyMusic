/**
 * app/rest/[method]/route.ts 的调试日志脱敏测试。
 *
 * 钉的是一件很具体的泄漏：`/rest` 的 `t`/`s` 是 Subsonic 凭据对
 * （`t = md5(服务端密钥 + s)`，**没有过期时间**），而 GET 里那行
 * `logger.debug(..., 'requestUrl:', request.url)` 会把整条 URL 连查询串一起抄进日志。
 * 开发环境默认开 DEBUG，日志一落盘，任何能读到日志的人就拿到了长期可用的钥匙。
 *
 * 这里走真实调用链（只把 auth 与 db 换掉），断言的是"打出来的那一行里没有凭据"，
 * 而不是只测脱敏函数本身——万一有人把调用点改回 `request.url`，这条会红。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { logger, LogLevel } from '@/lib/logger'

const TOKEN = '9a1b2c3d4e5f60718293a4b5c6d7e8f9'
const SALT = 'abcdefgh'

vi.mock('@/lib/auth', () => {
  const resolveUserFromRequest = vi.fn(async () => ({ user: null, verified: false, error: 'invalid_t' }))
  const authFailedResponse = vi.fn(() => new Response('<subsonic-response/>', { status: 401 }))
  return { default: { resolveUserFromRequest, authFailedResponse }, resolveUserFromRequest, authFailedResponse }
})

// 模型方法一律给"查不到"，避免这个用例真去开库
const stubModel = () => new Proxy({}, { get: () => async () => null })
vi.mock('@/lib/db', () => ({
  prisma: new Proxy({}, { get: () => stubModel() }),
  getMusicInfo: vi.fn(async () => null),
  getMusicInfoMapByIds: vi.fn(async () => new Map()),
  getMusicInfoRowIdsByUids: vi.fn(async () => new Map()),
  resolveMusicInfoById: vi.fn(async () => null),
  getStorageSongmidForMusicInfo: (mi: { songmid: string }) => mi.songmid,
}))

const { GET } = await import('./route')

function restRequest(method: string): NextRequest {
  return new NextRequest(
    `http://nas:3099/rest/${method}.view?u=admin&t=${TOKEN}&s=${SALT}&musicId=42`,
  )
}

async function callWithDebugLogCapture(method: string): Promise<string> {
  const previous = logger.getLevel()
  logger.setLevel(LogLevel.DEBUG)
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    // [method] 是单段动态路由，Next 给的 params.method 是字符串（带 .view 后缀）
    // 必须 await：那行日志在 `await context.params` 之后，同步读 spy 只会拿到空串
    await GET(restRequest(method), { params: Promise.resolve({ method: `${method}.view` }) }).catch(() => null)
    return spy.mock.calls.map(c => String(c[0])).join('\n')
  } finally {
    spy.mockRestore()
    logger.setLevel(previous)
  }
}

describe('/rest 调试日志不带出凭据', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('getStarred2.view：URL 里的 t/s 不出现在日志行里', async () => {
    const out = await callWithDebugLogCapture('getStarred2')

    expect(out).toContain('[rest] params:')          // 这行日志本身还在（排障要用）
    expect(out).toContain('u=admin')                 // 用户名留着，才对得上是谁发的
    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain(SALT)
    expect(out).toContain('t=***')
  })

  it('dispatch 之前的日志对未知方法同样脱敏（不落到业务分支也不漏）', async () => {
    const out = await callWithDebugLogCapture('noSuchMethod')

    expect(out).not.toContain(TOKEN)
    expect(out).toContain('t=***')
  })
})

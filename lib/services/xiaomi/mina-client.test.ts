/**
 * MiNA 设备列表客户端（G0）测试。
 *
 * 钉三件事：
 * 1. **鉴权是纯 cookie**（`userId` + `serviceToken` + `channel=MI_APP_STORE`），少一条就是 401；
 * 2. **错误要分身份**：HTTP 401/403、以及小米 body 里的 `code=401/319` 都算"票失效"（能被上层
 *    拿去做静默续期重试）；HTTP 5xx 与非 JSON 算上游故障，不该触发续期；
 * 3. `hardware` 必须落地 —— G1 靠它分流播放接口，G0 不存 G1 就得改结构。
 * 另外钉一条隐私的：错误信息里不许有票的内容。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const guards = vi.hoisted(() => ({ checked: [] as string[] }))
const logSpy = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: logSpy }))
vi.mock('@/lib/server/url-guard', () => ({
  assertPublicHttpUrl: vi.fn(async (url: string) => { guards.checked.push(url); return new URL(url) }),
}))

const { fetchDevices, isAuthFailure, XiaomiAuthError } = await import('@/lib/services/xiaomi/mina-client')
const creds = {
  serviceToken: 'ST_t%2BzVg%3D%3D',
  passToken: 'PT%3D%3D',
  userId: '88234121',
  cUserId: 'CU_9',
  deviceId: 'AABBCCDDEEFF0011',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  accountTail: '4121',
}

let lastRequest: { url: string; headers: Record<string, string> } | null = null

function reply(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v)
    lastRequest = { url: String(input), headers }
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status, headers: new Headers({ 'content-type': 'application/json' }),
    })
  }))
}

beforeEach(() => {
  guards.checked = []
  lastRequest = null
  vi.unstubAllGlobals()
})

describe('fetchDevices', () => {
  it('带齐三个 cookie 打 device_list?master=1，并把每一跳都过 SSRF 校验', async () => {
    reply({ code: 0, data: [{ deviceID: '705427729', name: '小爱音箱Play', hardware: 'L05B', model: 'L05B', miotDID: '867224854', presence: 'online' }] })
    const list = await fetchDevices(creds)
    expect(list).toHaveLength(1)
    expect(lastRequest!.url).toBe('https://api2.mina.mi.com/admin/v2/device_list?master=1')
    expect(lastRequest!.headers.cookie).toBe(`userId=${creds.userId}; serviceToken=${creds.serviceToken}; channel=MI_APP_STORE`)
    expect(lastRequest!.headers['user-agent']).toContain('AABBCCDDEEFF0011')
    expect(guards.checked).toEqual([lastRequest!.url])
  })

  it('型号原样留着（G1 分流就看它），没给 model 时退到 hardware', async () => {
    reply({ code: 0, data: [{ deviceID: '1', hardware: 'LX05', presence: 'online' }] })
    const [d] = await fetchDevices(creds)
    expect(d.hardware).toBe('LX05')
    expect(d.model).toBe('LX05')
    expect(d.managed).toBe(true) // 默认纳管，管理员在面板上摘
  })

  it('名字从 name/deviceName/alias/ssid 里依次挑，全空也不空着', async () => {
    reply({ code: 0, data: [
      { deviceID: 'a', deviceName: '客厅' },
      { deviceID: 'b', alias: '卧室' },
      { deviceID: 'c', ssid: 'xiaomi-speaker-3' },
      { deviceID: 'd' },
    ] })
    const list = await fetchDevices(creds)
    expect(list.map(d => d.name)).toEqual(['客厅', '卧室', 'xiaomi-speaker-3', '(未命名设备)'])
  })

  it('没有 deviceID 的行直接丢掉（不然 key 撞车、也没法拿去调 ubus）', async () => {
    reply({ code: 0, data: [{ name: '幽灵设备' }, { deviceID: '2', name: '小爱' }] })
    const list = await fetchDevices(creds)
    expect(list.map(d => d.deviceID)).toEqual(['2'])
  })

  it('presence 缺失时写 unknown，不当成在线', async () => {
    reply({ code: 0, data: [{ deviceID: '1', name: 'x' }] })
    expect((await fetchDevices(creds))[0].presence).toBe('unknown')
  })

  it('HTTP 401/403 ⇒ 票失效（上层据此静默续期后重试）', async () => {
    for (const status of [401, 403]) {
      reply({ code: status }, status)
      const err = await fetchDevices(creds).catch(e => e)
      expect(err).toBeInstanceOf(XiaomiAuthError)
      expect((err as XiaomiAuthError).status).toBe(401)
    }
  })

  it('body 里 code=401/319/70016 也算票失效（小米这套是 200 包着错误码的）', async () => {
    for (const code of [401, 319, 70016]) {
      // message 故意写成不含 auth 的中性话术：这三个码必须**各自**就能判出"票不行"，
      // 不能是靠话术兜出来的（少了哪个码，这条要红）
      reply({ code, message: 'unknown failure' })
      const err = await fetchDevices(creds).catch(e => e)
      expect(err).toBeInstanceOf(XiaomiAuthError)
      expect((err as XiaomiAuthError).status).toBe(401)
      // 码要留在话里，管理员报障时才有得说
      expect((err as Error).message).toContain(`code=${code}`)
    }
  })

  it('票失效的三种判据各自成立：码、中文话术、message 里的 auth 字样', () => {
    expect(isAuthFailure('401', '')).toBe(true)
    expect(isAuthFailure('319', '')).toBe(true)
    expect(isAuthFailure('70016', '')).toBe(true)
    expect(isAuthFailure('0', '登录验证失败')).toBe(true)
    expect(isAuthFailure('700070', 'session invalid, need re-auth')).toBe(true)
    expect(isAuthFailure('500', 'internal error')).toBe(false)
    expect(isAuthFailure('0', '')).toBe(false)
  })

  it('其它非 0 code 算上游拒绝（502），不冒充"要重新扫码"', async () => {
    reply({ code: 500, message: 'internal' })
    const err = await fetchDevices(creds).catch(e => e)
    expect(err).toBeInstanceOf(XiaomiAuthError)
    expect((err as XiaomiAuthError).status).toBe(502)
    expect((err as Error).message).toContain('code=500')
  })

  it('HTTP 5xx 记进日志的是状态与长度，不是响应体（体里可能带请求上下文）', async () => {
    logSpy.warn.mockClear()
    reply('<html>500 page with Set-Cookie: serviceToken=SECRET</html>', 500)
    const err = await fetchDevices(creds).catch(e => e)
    expect((err as XiaomiAuthError).status).toBe(502)
    expect(err).toBeInstanceOf(XiaomiAuthError)
    const warn = logSpy.warn.mock.calls.at(-1)
    expect(JSON.stringify(warn)).toContain('500')
    expect(JSON.stringify(warn)).not.toContain('SECRET')
    expect((err as Error).message).not.toContain('SECRET')
  })

  it('返回的不是 JSON（被风控页挡了）时给可读错误', async () => {
    reply('<html>blocked</html>')
    await expect(fetchDevices(creds)).rejects.toThrow(/不是 JSON/)
  })
})

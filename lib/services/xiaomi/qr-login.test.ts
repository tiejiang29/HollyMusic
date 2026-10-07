/**
 * 小米扫码登录（G0）的协议层测试。
 *
 * 钉的是四个"错一次就要重跑一遍真账号"的点：
 * 1. **`nonce` 必须从原始字符串里抠** —— 19 位整数过一遍 `JSON.parse` 会尾巴变形
 *    （实测 1728394057123456789 会变成 …800），签名于是算错，表现是"换票莫名失败"；
 * 2. **二维码要取平台的 `qr` 图片**，不是把 `loginUrl` 自己编一张（App 认不出来，只回"二维码已过期"，真踩过）；
 * 3. **扫码是两步**：mijia 的 passToken 之后必须再换 `sid=micoapi` 的 serviceToken，
 *    且换票要**跟完重定向并收集每一跳的 Set-Cookie**（票就在其中一跳的头里，自动跟跳会丢）；
 * 4. 轮询要会话 id 与一次性口令都对得上，且**对不上时不给出可用来试探的差异**。
 *
 * 网络全部 mock；`assertPublicHttpUrl` 一起断言"每一跳都过了"，
 * 免得将来有人把手动跟跳换成 `redirect:'follow'` 把 SSRF 校验一道带走了。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'

const guards = vi.hoisted(() => ({ checked: [] as string[] }))

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/server/url-guard', () => ({
  assertPublicHttpUrl: vi.fn(async (url: string) => {
    guards.checked.push(url)
    return new URL(url)
  }),
}))

const {
  stripJsonPrefix, pickBigIntField, computeClientSign,
  startQrLogin, pollQrLogin, abandonQrLogin, exchangeServiceToken,
  _resetQrSessionsForTest, XiaomiLoginError, SERVICE_TOKEN_TTL_MS, QR_SESSION_TTL_MS, TARGET_SID,
} = await import('@/lib/services/xiaomi/qr-login')

const NONCE = '1728394057123456789'
const SSECURITY = 'SEC_k'

interface Call {
  url: string
  headers: Record<string, string>
}

let calls: Call[] = []
let qrImageRequestedFrom = ''

function json(body: string, status = 200, setCookie: string[] = []) {
  const headers = new Headers({ 'content-type': 'application/json' })
  for (const c of setCookie) headers.append('set-cookie', c)
  return new Response(body, { status, headers })
}

function png(bytes = 5343, status = 200) {
  return new Response(new Uint8Array(bytes).fill(0x89), { status, headers: new Headers({ 'content-type': 'image/png' }) })
}

/**
 * 装一条标准的小米登录链。`overrides` 按 url 子串抢先应答，用来造各种失败分支。
 * 顺序要紧：`lp=` 那条轮询地址本身就长在 `/longPolling/loginUrl` 上，必须先判它。
 */
function installFetch(overrides: Array<{ has: string; reply: () => Response | Promise<Response> }> = []) {
  calls = []
  qrImageRequestedFrom = ''
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = String(v)
    }
    calls.push({ url, headers })
    for (const o of overrides) if (url.includes(o.has)) return o.reply()

    if (url.includes('/longPolling/loginUrl?lp=')) {
      // 没人扫时平台不回首屏字节 —— 这里用 code:0 表示"还在等"
      return json('&&&START&&&{"code":0,"desc":"ok"}')
    }
    if (url.includes('/pass/serviceLogin?sid=mijia')) {
      return json('&&&START&&&{"sid":"mijia","_sign":"SIGN_ABC","qs":"https://account.xiaomi.com/qq/hasLogin","callback":"https://account.xiaomi.com/qq/connect/login","token":123}')
    }
    if (url.includes('/longPolling/loginUrl')) {
      return json('&&&START&&&{"loginUrl":"https://c3.account.xiaomi.com/longPolling/login?ticket=AAA","lp":"https://account.xiaomi.com/longPolling/loginUrl?lp=BBB","qr":"https://account.xiaomi.com/pass/qr/login?ticket=AAA&_qrsize=240&_hasLogo=1"}')
    }
    if (url.includes('/pass/qr/login')) {
      qrImageRequestedFrom = url
      return png()
    }
    if (url.includes(`/pass/serviceLogin?sid=${TARGET_SID}`)) {
      return json(`&&&START&&&{"code":0,"sid":"micoapi","ssecurity":"${SSECURITY}","nonce":${NONCE},"location":"https://n.account.xiaomi.com/pass/serviceLoginAuth2?_json=true&sid=micoapi"}`)
    }
    if (url.includes('serviceLoginAuth2')) {
      // 票在这一跳的头里，然后 302 转走：自动跟跳的话这里就丢了
      return new Response(null, {
        status: 302,
        headers: new Headers([
          ['set-cookie', 'serviceToken=ST_t%2BzVg%3D%3D; Path=/; Domain=.xiaomi.com'],
          ['set-cookie', 'ssecurity=SEC_k; Path=/'],
          ['location', 'https://account.xiaomi.com/qq/connect/login?_useClientType=6&_json=true'],
        ]),
      })
    }
    if (url.includes('qq/connect/login')) {
      return json('&&&START&&&{"code":0,"result":"ok"}')
    }
    throw new Error(`测试没准备这个请求：${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
}

/** 走完出二维码那一步，拿到一个真登记过会话的句柄 */
async function freshQr() {
  return startQrLogin()
}

beforeEach(() => {
  guards.checked = []
  _resetQrSessionsForTest()
  installFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('纯函数：前缀、大整数、签名', () => {
  it('剥掉 &&&START&&& 前缀（不剥，直接 JSON.parse 就炸）', () => {
    expect(stripJsonPrefix('&&&START&&&{"code":0}')).toBe('{"code":0}')
    expect(stripJsonPrefix('{"code":0}')).toBe('{"code":0}')
  })

  it('nonce 从原始字符串抠出来是 19 位原值 —— 走 JSON 那条路拿到的是错的数', () => {
    const body = `{"nonce":${NONCE},"sid":"micoapi"}`
    expect(pickBigIntField(body, 'nonce')).toBe(NONCE)
    // 这条是"为什么要这个函数"的正证，不是补码
    expect(String((JSON.parse(body) as { nonce: number }).nonce)).toBe('1728394057123456800')
  })

  it('nonce 带引号也能抠（平台两种写法都有过）', () => {
    expect(pickBigIntField('{"nonce":"987654321012345678"}', 'nonce')).toBe('987654321012345678')
    expect(pickBigIntField('{"nonce": -12345}', 'nonce')).toBe('-12345')
    expect(pickBigIntField('{"sid":"micoapi"}', 'nonce')).toBe('')
  })

  it('clientSign = base64(sha1("nonce=…&ssecurity"))，输入串的形状不能改', () => {
    expect(computeClientSign(NONCE, SSECURITY)).toBe(
      crypto.createHash('sha1').update(`nonce=${NONCE}&${SSECURITY}`).digest('base64'),
    )
    expect(computeClientSign(NONCE, SSECURITY)).not.toBe(
      crypto.createHash('sha1').update(`${NONCE}&${SSECURITY}`).digest('base64'),
    )
  })
})

describe('startQrLogin：出二维码', () => {
  it('取的是平台渲染好的 qr 图片，不是拿 loginUrl 自己编一张', async () => {
    const r = await freshQr()
    expect(qrImageRequestedFrom).toContain('/pass/qr/login')
    expect(qrImageRequestedFrom).toContain('_qrsize=240')
    expect(r.qrPngBase64).toBe(Buffer.from(new Uint8Array(5343).fill(0x89)).toString('base64'))
    expect(r.expiresInMs).toBe(QR_SESSION_TTL_MS)
    expect(r.sessionId).toMatch(/^[0-9a-f]{24}$/)
    expect(r.loginToken).toMatch(/^[0-9a-f]{32}$/)
  })

  it('每一跳出网前都过了 SSRF 校验（一道都不省）', async () => {
    await freshQr()
    expect(calls.length).toBeGreaterThan(2)
    expect(guards.checked.length).toBe(calls.length)
    expect(guards.checked.every(u => u.startsWith('https://account.xiaomi.com'))).toBe(true)
  })

  it('签名参数没给全就报错，不出半张二维码', async () => {
    installFetch([{ has: '/pass/serviceLogin?sid=mijia', reply: () => json('&&&START&&&{"sid":"mijia","qs":"x"}') }])
    await expect(startQrLogin()).rejects.toThrow(/_sign\/qs\/callback/)
  })

  it('二维码图片不是 200 或太小：报状态与字节数，不返回一张看不见的码', async () => {
    installFetch([{ has: '/pass/qr/login', reply: () => png(12, 500) }])
    await expect(startQrLogin()).rejects.toThrow(/HTTP 500，12 字节/)
  })

  it('平台回的不是 JSON 时给可读错误（风控页会回 HTML）', async () => {
    installFetch([{ has: '/pass/serviceLogin?sid=mijia', reply: () => new Response('<html>blocked</html>', { status: 200 }) }])
    await expect(startQrLogin()).rejects.toThrow(XiaomiLoginError)
  })
})

describe('pollQrLogin：问一次"扫了没"', () => {
  it('没人扫时平台不回首屏字节：fetch 超时 ⇒ waiting，会话留着继续轮', async () => {
    const r = await freshQr()
    installFetch([{
      has: '/longPolling/loginUrl?lp=',
      reply: () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e },
    }])
    expect(await pollQrLogin(r.sessionId, r.loginToken)).toEqual({ state: 'waiting' })

    // 会话没被销毁：换一个"平台开始回应"的分支还能继续问
    installFetch([{
      has: '/longPolling/loginUrl?lp=',
      reply: () => json(`&&&START&&&{"code":0,"passToken":"PT%3D%3D","userId":88234121,"cUserId":"CU_9"}`),
    }])
    expect((await pollQrLogin(r.sessionId, r.loginToken)).state).toBe('signedIn')
  })

  it('轮询时把出二维码那次的 cookie 带回去（ticket 在那里面）', async () => {
    const r = await freshQr()
    const before = calls.length
    await pollQrLogin(r.sessionId, r.loginToken)
    const poll = calls.slice(before).find(c => c.url.includes('/longPolling/loginUrl?lp='))
    expect(poll?.headers.cookie).toContain('deviceId=')
  })

  it('口令不对与会话不存在给出同一句话（不能拿来试探哪些 id 有效）', async () => {
    const r = await freshQr()
    const wrongToken = await pollQrLogin(r.sessionId, 'deadbeefdeadbeefdeadbeefdeadbeef')
    const unknownId = await pollQrLogin('000000000000000000000000', r.loginToken)
    expect(wrongToken).toEqual(unknownId)
    expect(wrongToken.state).toBe('expired')
  })

  it('超过 5 分钟直接判过期，且不再去问平台', async () => {
    const r = await freshQr()
    const asked = calls.length
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + QR_SESSION_TTL_MS + 1)
    try {
      const got = await pollQrLogin(r.sessionId, r.loginToken)
      expect(got.state).toBe('expired')
      if (got.state === 'expired') expect(got.message).toContain('重新获取')
      expect(calls.length).toBe(asked)
    } finally {
      vi.useRealTimers()
    }
  })

  it('平台说这张码失效（code 非 0）：判过期并销毁会话', async () => {
    const r = await freshQr()
    installFetch([{ has: '/longPolling/loginUrl?lp=', reply: () => json('&&&START&&&{"code":6,"desc":"expired ticket"}') }])
    const first = await pollQrLogin(r.sessionId, r.loginToken)
    expect(first.state).toBe('expired')
    if (first.state === 'expired') expect(first.message).toContain('code=6')
    // 会话已销毁：第二次问连平台都不该再打
    const asked = calls.length
    expect((await pollQrLogin(r.sessionId, r.loginToken)).state).toBe('expired')
    expect(calls.length).toBe(asked)
  })

  it('扫码确认：换到 micoapi 票、回凭据，会话当场销毁（一张码只许换一次票）', async () => {
    let lpHits = 0
    installFetch([{
      has: '/longPolling/loginUrl?lp=',
      reply: () => {
        lpHits++
        return lpHits === 1
          ? json('&&&START&&&{"code":0,"desc":"ok"}')
          : json('&&&START&&&{"code":0,"passToken":"PT%3D%3D","userId":88234121,"cUserId":"CU_9","sid":"micoapi"}')
      },
    }])
    const r = await freshQr()
    expect(await pollQrLogin(r.sessionId, r.loginToken)).toEqual({ state: 'waiting' })

    const got = await pollQrLogin(r.sessionId, r.loginToken)
    expect(got.state).toBe('signedIn')
    if (got.state !== 'signedIn') return
    const c = got.credentials
    expect(c.userId).toBe('88234121')
    expect(c.accountTail).toBe('4121')
    expect(c.passToken).toBe('PT%3D%3D')
    expect(c.cUserId).toBe('CU_9')
    // 票是从重定向链的 Set-Cookie 里收来的，原样留着（不解码 —— 回给平台时也要原样）
    expect(c.serviceToken).toBe('ST_t%2BzVg%3D%3D')
    expect(c.deviceId).toMatch(/^[0-9A-F]{16}$/)
    expect(Date.parse(c.expiresAt) - Date.now()).toBeGreaterThan(SERVICE_TOKEN_TTL_MS - 60000)

    expect((await pollQrLogin(r.sessionId, r.loginToken)).state).toBe('expired')
    // 换票这一步确实打了 micoapi，不是只停在 mijia
    expect(calls.some(x => x.url.includes(`/pass/serviceLogin?sid=${TARGET_SID}`))).toBe(true)
  })

  it('跟跳不丢中间那一跳的 Set-Cookie：票要能在下一跳的请求头里带出去', async () => {
    await exchangeServiceToken({ passToken: 'PT', userId: '88234121', cUserId: 'CU', deviceId: 'DEADBEEF' })
    const final = calls[calls.length - 1]
    expect(final.url).toContain('qq/connect/login')
    expect(final.headers.cookie).toContain('serviceToken=ST_t%2BzVg%3D%3D')
    expect(final.headers.cookie).toContain('passToken=PT')
    expect(final.headers['user-agent']).toContain('DEADBEEF')
  })

  it('签名要用原始 19 位 nonce：请求里出现的是 …789 算出的签名，不是 JSON.parse 的 …800', async () => {
    await exchangeServiceToken({ passToken: 'PT', userId: '88234121', deviceId: 'DEADBEEF' })
    const auth = calls.find(c => c.url.includes('serviceLoginAuth2'))
    expect(auth).toBeTruthy()
    const expected = computeClientSign(NONCE, SSECURITY)
    expect(decodeURIComponent(auth!.url)).toContain(`clientSign=${expected}`)
    expect(auth!.url).not.toContain('17283940571234568')
  })

  it('平台没给 location/nonce 就报错，不去打一个空签名', async () => {
    installFetch([{ has: `/pass/serviceLogin?sid=${TARGET_SID}`, reply: () => json('&&&START&&&{"code":700,"description":"need captcha"}') }])
    await expect(exchangeServiceToken({ passToken: 'PT', userId: '1', deviceId: 'D' }))
      .rejects.toThrow(/micoapi 的票失败（code=700）/)
    expect(calls.some(c => c.url.includes('serviceLoginAuth2'))).toBe(false)
  })

  it('跟完所有跳也没发 serviceToken：明确报错，不返回一张空票', async () => {
    installFetch([{
      has: 'serviceLoginAuth2',
      reply: () => new Response('&&&START&&&{"code":0}', { status: 200, headers: new Headers() }),
    }])
    await expect(exchangeServiceToken({ passToken: 'PT', userId: '1', deviceId: 'D' }))
      .rejects.toThrow(/没拿到 micoapi 的 serviceToken/)
  })

  it('重定向链过长就中止（平台异常跳转不能把请求槽挂住）', async () => {
    let hops = 0
    installFetch([{
      has: 'serviceLoginAuth2',
      reply: () => {
        hops++
        return new Response(null, {
          status: 302,
          headers: new Headers([
            ['set-cookie', 'serviceToken=ST; Path=/'],
            ['location', `https://account.xiaomi.com/hop/${hops}?x=1`],
          ]),
        })
      },
    }, {
      has: '/hop/',
      reply: () => new Response(null, {
        status: 302,
        headers: new Headers([['location', 'https://n.account.xiaomi.com/pass/serviceLoginAuth2?_json=true']]),
      }),
    }])
    await expect(exchangeServiceToken({ passToken: 'PT', userId: '1', deviceId: 'D' }))
      .rejects.toThrow(/重定向链过长/)
    // 上限是"跟到第 11 跳就收手"：比实测那次（第 4 跳就落地）宽，但不会无限跟
    expect(hops).toBeLessThanOrEqual(11)
    expect(hops).toBeGreaterThan(1)
  })

  it('扫上了但换票失败：回 failed 带原因，不把半套凭据递出去', async () => {
    installFetch([
      { has: '/longPolling/loginUrl?lp=', reply: () => json('&&&START&&&{"code":0,"passToken":"PT%3D%3D","userId":88234121}') },
      { has: `/pass/serviceLogin?sid=${TARGET_SID}`, reply: () => json('&&&START&&&{"code":700,"description":"need captcha"}') },
    ])
    const r = await freshQr()
    const got = await pollQrLogin(r.sessionId, r.loginToken)
    expect(got.state).toBe('failed')
    if (got.state === 'failed') expect(got.message).toContain('code=700')
    expect(JSON.stringify(got)).not.toContain('PT%3D%3D')
  })
})

describe('abandonQrLogin：主动作废', () => {
  it('取消之后这张码轮不动了，也不会再去打平台', async () => {
    const r = await freshQr()
    abandonQrLogin(r.sessionId)
    const asked = calls.length
    expect((await pollQrLogin(r.sessionId, r.loginToken)).state).toBe('expired')
    expect(calls.length).toBe(asked)
  })
})

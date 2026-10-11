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

const guards = vi.hoisted(() => ({ checked: [] as string[], rejectWith: '' }))
const logSpy = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: logSpy }))
vi.mock('@/lib/server/url-guard', () => ({
  assertPublicHttpUrl: vi.fn(async (url: string) => {
    guards.checked.push(url)
    if (guards.rejectWith) throw new Error(guards.rejectWith)
    return new URL(url)
  }),
}))

const {
  fetchDevices, isAuthFailure, XiaomiAuthError,
  playUrl, playItems, playerOperation, setVolume, getPlayStatus, usePlayMusicApi, _resetUbusQueuesForTest,
  fetchConversations,
} = await import('@/lib/services/xiaomi/mina-client')
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
  guards.rejectWith = ''
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

describe('ubus 播控（G1）', () => {
  let requests: Array<{ url: string; body: string; headers: Record<string, string> }> = []

  /** 装一条 ubus：按顺序回这些响应体（字符串原样，对象转 JSON） */
  function ubusReply(bodies: Array<unknown | Error>) {
    requests = []
    const queue = [...bodies]
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v)
      requests.push({ url: String(input), body: String(init?.body ?? ''), headers })
      const next = queue.length > 1 ? queue.shift() : (queue[0] ?? { code: 0, data: { code: 0 } })
      if (next instanceof Error) throw next
      return new Response(typeof next === 'string' ? next : JSON.stringify(next), {
        status: 200, headers: new Headers({ 'content-type': 'application/json' }),
      })
    }))
  }

  const form = (i = 0): Record<string, string> =>
    Object.fromEntries(new URLSearchParams(requests[i].body))

  beforeEach(() => {
    _resetUbusQueuesForTest()
  })

  it('打的是 /remote/ubus，form 五个字段齐、cookie 与设备列表同一套', async () => {
    ubusReply([{ code: 0, data: { code: 0 } }])
    await playUrl(creds, '705427729', 'http://172.16.1.20:3000/x.mp3')
    expect(requests[0].url).toBe('https://api2.mina.mi.com/remote/ubus')
    const f = form()
    expect(f.deviceId).toBe('705427729')
    expect(f.method).toBe('player_play_url')
    expect(f.path).toBe('mediaplayer')
    expect(JSON.parse(f.message)).toEqual({ url: 'http://172.16.1.20:3000/x.mp3', type: 2, media: 'app_ios' })
    expect(f.requestId).toBeTruthy()
    expect(requests[0].headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(requests[0].headers.cookie).toContain('channel=MI_APP_STORE')
  })

  it('L05B 这类型号走 player_play_music，报文里 music 是字符串化的那串结构', async () => {
    ubusReply([{ code: 0, data: { code: 0 } }])
    expect(usePlayMusicApi('L05B')).toBe(true)
    const ok = await playUrl(creds, '705427729', 'http://h/x.mp3', 'L05B')
    expect(ok).toBe(true)
    const f = form()
    expect(f.method).toBe('player_play_music')
    const message = JSON.parse(f.message) as Record<string, unknown>
    expect(message.startaudioid).toBe('1732418460076477549')
    const music = JSON.parse(message.music as string) as Record<string, unknown>
    expect(music.play_behavior).toBe('REPLACE_ALL')
    const payload = (music.payload as Record<string, unknown>)
    expect((payload.audio_items as Array<Record<string, unknown>>)[0]).toMatchObject({
      stream: { url: 'http://h/x.mp3' },
      item_id: { audio_id: '1732418460076477549', cp: { name: 'xiaowei' } },
    })
  })

  it('audio_id 设备原样回显：它就是投放会话"播到窗里第几项"的游标', async () => {
    // 真机原文（2026-10-08 批量推实测）：audio_id 只在 play_song_detail 里，且就是我们填进去的那串
    ubusReply([{ code: 0, data: { info: JSON.stringify({
      status: 1, volume: 30, loop_type: 1, media_type: 3,
      play_song_detail: { audio_id: '17913857242411', position: 177684, duration: 248869 },
    }) } }])
    const st = await getPlayStatus(creds, '1')
    expect(st.audioId).toBe('17913857242411')
    expect(st.position).toBe(177684)
  })

  it('不在名单里的型号走 player_play_url（别把不认 Music API 的机器推哑）', async () => {
    ubusReply([{ code: 0, data: { code: 0 } }])
    await playUrl(creds, '1', 'http://h/x.mp3', 'S03')
    expect(form().method).toBe('player_play_url')
  })

  it('管理员把型号摘出名单 ⇒ 即使原来在名单里也退回 play_url', async () => {
    ubusReply([{ code: 0, data: { code: 0 } }])
    expect(usePlayMusicApi('L05B', ['L05B'])).toBe(false)
    await playUrl(creds, '1', 'http://h/x.mp3', 'L05B', { musicApiDisabled: ['L05B'] })
    expect(form().method).toBe('player_play_url')
  })

  it('云端 code=0 但设备端 data.code 非 0 ⇒ 判失败（"亮灯不出声"就是这一类）', async () => {
    ubusReply([{ code: 0, data: { code: 400, message: 'device refused' } }])
    expect(await playUrl(creds, '1', 'http://h/x.mp3', 'L05B')).toBe(false)
  })

  it('play_music 被设备端拒 ⇒ 自动退一条 play_url，两条都发过', async () => {
    ubusReply([
      { code: 0, data: { code: 400 } },
      { code: 0, data: { code: 0 } },
    ])
    expect(await playUrl(creds, '1', 'http://h/x.mp3', 'L05B')).toBe(true)
    expect(form(0).method).toBe('player_play_music')
    expect(form(1).method).toBe('player_play_url')
  })

  it('playItems 一次推多项：audio_items 按顺序、episode_index 递增、startaudioid 取第一项', async () => {
    ubusReply([{ code: 0, data: { code: 0 } }])
    const r = await playItems(creds, '1', [
      { url: 'http://h/a.mp3', audioId: '111' },
      { url: 'http://h/b.mp3', audioId: '222' },
      { url: 'http://h/c.mp3', audioId: '333' },
    ], 'L05B')
    expect(r).toEqual({ accepted: true, batched: true })
    expect(form().method).toBe('player_play_music')
    const message = JSON.parse(form().message) as Record<string, unknown>
    expect(message.startaudioid).toBe('111')
    const music = JSON.parse(message.music as string) as Record<string, unknown>
    const items = (music.payload as Record<string, unknown>).audio_items as Array<Record<string, unknown>>
    expect(items.map(x => [
      (x.stream as Record<string, unknown>).url,
      (x.item_id as Record<string, unknown>).audio_id,
      ((x.item_id as Record<string, unknown>).cp as Record<string, unknown>).episode_index,
    ])).toEqual([['http://h/a.mp3', '111', 0], ['http://h/b.mp3', '222', 1], ['http://h/c.mp3', '333', 2]])
  })

  it('批量退化到 play_url 时只装得下第一项 ⇒ batched=false，看门狗据此逐首补', async () => {
    ubusReply([{ code: 0, data: { code: 400 } }, { code: 0, data: { code: 0 } }])
    const r = await playItems(creds, '1', [
      { url: 'http://h/a.mp3', audioId: '1' },
      { url: 'http://h/b.mp3', audioId: '2' },
    ], 'L05B')
    expect(r).toEqual({ accepted: true, batched: false })
    expect(form(1).method).toBe('player_play_url')
    expect(JSON.parse(form(1).message)).toMatchObject({ url: 'http://h/a.mp3' })
  })

  it('空列表不碰小米（会话清空时不许发一条没内容的推歌）', async () => {
    ubusReply([{ code: 0, data: { code: 0 } }])
    expect(await playItems(creds, '1', [], 'L05B')).toEqual({ accepted: false, batched: false })
    expect(requests).toHaveLength(0)
  })

  it('云端非 0 code 抛出去（是"没受理"，不是"没在放"），401 类仍归票失效', async () => {
    ubusReply([{ code: 70016, message: '登录验证失败' }])
    const err = await playUrl(creds, '1', 'http://h/x.mp3').catch(e => e)
    expect(err).toBeInstanceOf(XiaomiAuthError)
    expect((err as XiaomiAuthError).status).toBe(401)
  })

  it('同一台设备的指令严格串行（并发一交错就炸），不同设备互不影响', async () => {
    const inflight: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = String((init as { body?: string })?.body ?? '')
      inflight.push(new URLSearchParams(body).get('deviceId') ?? '?')
      // 两条同时在飞 → 这里长度是 2，直接判死
      expect(inflight).toHaveLength(1)
      // 让出一个宏任务：并发发起时另一条会在这个空档里挤进来
      await new Promise(resolve => setTimeout(resolve, 0))
      inflight.pop()
      return new Response(JSON.stringify({ code: 0, data: { code: 0 } }), { status: 200 })
    }))
    await Promise.all([
      playUrl(creds, 'devA', 'http://h/1.mp3'),
      playUrl(creds, 'devA', 'http://h/2.mp3'),
      playUrl(creds, 'devA', 'http://h/3.mp3'),
    ])
    expect(inflight).toHaveLength(0)
  })

  it('暂停与恢复都走 player_play_operation；stop 先补一发 pause（有些固件单发 stop 不停）', async () => {
    ubusReply([{ code: 0, data: { code: 0 } }])
    expect(await playerOperation(creds, '1', 'pause')).toBe(true)
    expect(JSON.parse(form(0).message).action).toBe('pause')
    ubusReply([{ code: 0, data: { code: 0 } }, { code: 0, data: { code: 0 } }])
    expect(await playerOperation(creds, '1', 'stop')).toBe(true)
    expect(JSON.parse(form(0).message).action).toBe('pause')
    expect(JSON.parse(form(1).message).action).toBe('stop')
  })

  it('音量夹到 0-100 并取整', async () => {
    ubusReply([{ code: 0, data: { code: 0 } }])
    await setVolume(creds, '1', 173.6)
    expect(JSON.parse(form().message).volume).toBe(100)
    ubusReply([{ code: 0, data: { code: 0 } }])
    await setVolume(creds, '1', -5)
    expect(JSON.parse(form().message).volume).toBe(0)
  })

  it('状态回读：info 是字符串 JSON，时长可能在 play_song_detail 里；读不到一律 -1 不猜', async () => {
    ubusReply([{ code: 0, data: { info: JSON.stringify({ status: 1, position: 12345, duration: 240000, volume: 30, title: '稻香' }) } }])
    expect(await getPlayStatus(creds, '1')).toEqual({ status: 1, position: 12345, duration: 240000, volume: 30, title: '稻香', audioId: '' })
    ubusReply([{ code: 0, data: { info: JSON.stringify({ status: 1, position: 10, play_song_detail: { duration: 99000 } }) } }])
    expect((await getPlayStatus(creds, '1')).duration).toBe(99000)
    ubusReply([{ code: 0, data: { info: '{不是 JSON' } }])
    expect(await getPlayStatus(creds, '1')).toMatchObject({ status: -1, duration: -1 })
  })

  it('真机形状（L05B 实测回包）：顶层没有 position，位置与 audio_id 都只在 play_song_detail 里', async () => {
    // 这就是"位置一直显示 0s"的成因：只读顶层会静默兜成 0，看着像设备没报
    const info = JSON.stringify({
      status: 2, volume: 30, loop_type: 1, media_type: 3,
      play_song_detail: { audio_id: '1732418460076477549', position: 177266, duration: 248869 },
      track_list: ['1732418460076477549'],
    })
    ubusReply([{ code: 0, message: 'Msg has been successfully proxy…', data: { code: 0, info } }])
    expect(await getPlayStatus(creds, '1')).toEqual({
      // audio_id 是设备原样回显我们填的那串 ⇒ 投放会话靠它认"播到窗里第几项"
      status: 2, position: 177266, duration: 248869, volume: 30, title: '', audioId: '1732418460076477549',
    })
  })

  it('日志里不许出现推给音箱的 URL（它带着能放歌的令牌），但要留得下长度', async () => {
    // 走"云端非 0 且不是鉴权"这条会打日志的分支
    ubusReply([{ code: 5005, message: 'internal' }])
    logSpy.warn.mockClear()
    await expect(playUrl(creds, '1', 'http://172.16.1.20:3000/api/speaker/stream?st=SECRET_TOKEN&uid=tx-1&quality=320k', 'L05B'))
      .rejects.toThrow(/播控被云端拒绝/)
    const dumped = JSON.stringify(logSpy.warn.mock.calls)
    expect(dumped).not.toContain('SECRET_TOKEN')
    expect(dumped).not.toContain('172.16.1.20')
    // 长度留着：排障时要能看出"报文是空的"还是"地址很长"
    expect(dumped).toMatch(/music\(长\d+\)/)
  })
})

describe('fetchConversations（G0.5 对话回显）', () => {
  // cookie 里那个 deviceId 必须是**这台音箱**的 deviceID，不是 creds.deviceId（登录用的那台）
  const CONV_DEVICE = { hardware: 'L05B', deviceID: 'spk-1' }

  it('URL 带 source=dialogu/hardware/timestamp/limit，Cookie 比设备列表多带一个 deviceId', async () => {
    reply({ code: 0, data: JSON.stringify({ records: [] }) })
    await fetchConversations(creds, CONV_DEVICE, 5)
    const u = new URL(lastRequest!.url)
    expect(u.searchParams.get('source')).toBe('dialogu')
    expect(u.searchParams.get('hardware')).toBe('L05B')
    expect(u.searchParams.get('limit')).toBe('5')
    expect(Number(u.searchParams.get('timestamp'))).toBeGreaterThan(0)
    expect(lastRequest!.headers.cookie).toContain('serviceToken=')
  })

  it('Cookie 里的 deviceId 用那台音箱的 ID —— 填登录设备那个平台会静默回 0 条（2026-10-09 实测踩过）', async () => {
    reply({ code: 0, data: JSON.stringify({ records: [{ time: 1000, query: '甲', answers: [] }] }) })
    await fetchConversations(creds, CONV_DEVICE)
    const cookie = lastRequest!.headers.cookie as string
    expect(cookie).toContain('deviceId=' + CONV_DEVICE.deviceID)
    expect(cookie).not.toContain('deviceId=' + creds.deviceId)
  })

  it('records 里 time/query/TTS 回答各自归位：非 TTS 不算回答，没时间戳的丢掉，按时间升序返回', async () => {
    reply({
      code: 0,
      data: JSON.stringify({
        records: [
          { time: 2000, query: '后说的', answers: [{ type: 'TTS', tts: { text: '好的' } }] },
          { time: 1000, query: '先说的', answers: [{ type: 'TEXT', text: '不算这个' }] },
          { time: 0, query: '没时间戳的丢掉', answers: [] },
        ],
      }),
    })
    expect(await fetchConversations(creds, CONV_DEVICE)).toEqual([
      { timestampMs: 1000, query: '先说的', answer: '' },
      { timestampMs: 2000, query: '后说的', answer: '好的' },
    ])
  })

  it('外层 data 是对象时也认（平台两种都发过）', async () => {
    reply({ code: 0, data: { records: [{ time: 5000, query: '甲', answers: [] }] } })
    expect(await fetchConversations(creds, CONV_DEVICE)).toEqual([{ timestampMs: 5000, query: '甲', answer: '' }])
  })

  it('data 二次 parse 坏了 ⇒ 空列表，不炸（面板要能继续轮下一次）', async () => {
    reply({ code: 0, data: '{不是 JSON' })
    expect(await fetchConversations(creds, CONV_DEVICE)).toEqual([])
  })

  it('票失效要抛出来：200 包着"登录验证失败"算 auth，非 2xx 算 502 —— 都绝不能当成"没有新话"', async () => {
    reply({ code: 70016, message: '登录验证失败' })
    const e1 = await fetchConversations(creds, CONV_DEVICE).catch(e => e)
    expect(e1).toBeInstanceOf(XiaomiAuthError)
    expect(isAuthFailure('70016', '登录验证失败')).toBe(true)

    reply('网关挂了', 500)
    const e2 = await fetchConversations(creds, CONV_DEVICE).catch(e => e)
    expect(e2).toBeInstanceOf(XiaomiAuthError)
    expect((e2 as XiaomiAuthError).status).toBe(502)
  })

  it('没有型号就别打网络（拿空 hardware 去拉只会拿到一屏莫名其妙的错）', async () => {
    reply({ code: 0, data: '{}' })
    const err = await fetchConversations(creds, { hardware: '', deviceID: 'spk-1' }).catch(e => e)
    expect(err).toBeInstanceOf(XiaomiAuthError)
    expect(lastRequest).toBeNull()
  })
})

describe('出网失败要归一成 502，不许冒成 500（2026-10-11 NAS 的 DNS 抖了一分钟）', () => {
  it('地址校验/网络层抛任何裸错 ⇒ `XiaomiAuthError` + 502，原文带在 message 里', async () => {
    reply({ code: 0, data: '{}' })
    guards.rejectWith = '域名解析失败：api2.mina.mi.com（本机 DNS 或出网有问题，不是被 SSRF 闸门拦的）'
    const err = await getPlayStatus(creds, 'D1').catch(e => e)
    expect(err).toBeInstanceOf(XiaomiAuthError)
    expect(err.status).toBe(502)
    expect(err.message).toContain('连不上小爱的服务')
    expect(err.message).toContain('域名解析失败')
  })

  it('反证：401 那一支原样透出，不在归一时被降级成"可重试"', async () => {
    reply('unauthorized', 401)
    const err = await getPlayStatus(creds, 'D1').catch(e => e)
    expect(err).toBeInstanceOf(XiaomiAuthError)
    expect(err.status).toBe(401)
  })
})

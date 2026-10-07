/**
 * 投歌编排（G1，speaker-play）测试。
 *
 * 钉的是四件会直接决定"他点了之后到底有没有声音"的事：
 * 1. **地址必须局域网可达**：没填就明确拒绝，回环地址直接报错 —— 拼一个能返回 200 但音箱拉不到的
 *    URL 是这套东西最难查的失败形态；
 * 2. **`st` 必须在第一个参数位**（部分固件把 URL 里的 `&` 换成空格，令牌在前才还能救回来）；
 * 3. **选设备不许猜**：显式指定 > 唯一在线纳管；多台在线又没指定就报错，不把歌唱到别的房间；
 * 4. **"云端受理"与"音箱在放"是两件事**：推完必须回读一次状态，没在放就把原因带回来，
 *    而且要带的是一句能照着做的话。
 * 另有一条隐私：投出去的 URL 带令牌，日志与返回值里都不许出现它。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  config: {
    enabled: true,
    credentials: null as unknown,
    devices: [] as Array<Record<string, unknown>>,
    lastSyncAt: null, lastError: null,
    serverHost: '172.16.1.20:3000',
    playQuality: '320k',
    musicApiDisabledModels: [] as string[],
  },
  ensureFreshCredentials: vi.fn(),
  readSpeakerConfig: vi.fn(),
  writeSpeakerConfig: vi.fn(),
  playUrl: vi.fn(),
  playerOperation: vi.fn(),
  setVolume: vi.fn(),
  getPlayStatus: vi.fn(),
  resolveMusicInfoById: vi.fn(),
  createShareAudioToken: vi.fn(() => 'TOKEN.abcdef'),
}))

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/services/xiaomi/token-store', () => ({
  readSpeakerConfig: h.readSpeakerConfig,
  writeSpeakerConfig: h.writeSpeakerConfig,
  ensureFreshCredentials: h.ensureFreshCredentials,
}))
vi.mock('@/lib/services/xiaomi/mina-client', () => ({
  playUrl: h.playUrl,
  playerOperation: h.playerOperation,
  setVolume: h.setVolume,
  getPlayStatus: h.getPlayStatus,
  PLAY_STATUS_PLAYING: 1,
}))
vi.mock('@/lib/db', () => ({ resolveMusicInfoById: h.resolveMusicInfoById }))
vi.mock('@/lib/services/auth', () => ({ createShareAudioToken: h.createShareAudioToken }))

const {
  buildStreamBase, buildStreamUrl, pickDevice, playOnSpeaker, redactStreamUrl,
  controlSpeaker, setSpeakerVolume, SpeakerError,
} = await import('@/lib/services/xiaomi/speaker-play')

const CREDS = {
  serviceToken: 'ST', passToken: 'PT', userId: '88234121', cUserId: '', deviceId: 'D',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(), accountTail: '4121',
}

const dev = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  deviceID: id, name, hardware: 'L05B', model: 'L05B', miotDID: 'm' + id, presence: 'online', managed: true, ...over,
})

const MUSIC_INFO = { name: '稻香', singer: '周杰伦', source: 'tx', songmid: 'S1', interval: '223', types: [] }

beforeEach(() => {
  h.config = {
    enabled: true, credentials: CREDS, devices: [dev('1', '小爱音箱Play')],
    lastSyncAt: null, lastError: null,
    serverHost: '172.16.1.20:3000', playQuality: '320k', musicApiDisabledModels: [],
  }
  // 先清调用记录再摆默认值，否则上一条用例的出网记录会串到"一次都不该出网"这条断言里
  for (const f of [h.readSpeakerConfig, h.ensureFreshCredentials, h.playUrl, h.getPlayStatus,
    h.resolveMusicInfoById, h.playerOperation, h.setVolume, h.writeSpeakerConfig]) f.mockReset()
  h.readSpeakerConfig.mockImplementation(async () => h.config)
  h.ensureFreshCredentials.mockResolvedValue(CREDS)
  h.resolveMusicInfoById.mockResolvedValue(MUSIC_INFO)
  h.playUrl.mockResolvedValue(true)
  h.getPlayStatus.mockResolvedValue({ status: 1, position: 1000, duration: 223000, volume: 30, title: '' })
})

describe('地址：先保证音箱拉得到', () => {
  it('没填就拒绝推歌，不拼一个"看着能播"的 URL', () => {
    expect(() => buildStreamBase('')).toThrow(SpeakerError)
    expect(() => buildStreamBase('')).toThrow(/先在面板上填/)
  })

  it('回环地址直接报错（音箱打不开我们本机）', () => {
    for (const host of ['localhost:3000', '127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(() => buildStreamBase(host)).toThrow(/回环|局域网/)
    }
  })

  it('三种写法都接下来：裸 IP、带端口、带 scheme', () => {
    expect(buildStreamBase('172.16.1.20')).toBe('http://172.16.1.20')
    expect(buildStreamBase('172.16.1.20:3000')).toBe('http://172.16.1.20:3000')
    expect(buildStreamBase('https://nas.example.com')).toBe('https://nas.example.com')
  })

  it('st 在第一个参数位（固件把 & 换成空格时还能按空格还原令牌）', () => {
    const url = buildStreamUrl('http://172.16.1.20:3000', 'tx-S1', '320k')
    expect(url.startsWith('http://172.16.1.20:3000/api/speaker/stream?st=TOKEN.abcdef&uid=tx-S1&quality=320k')).toBe(true)
    expect(url.indexOf('st=')).toBeLessThan(url.indexOf('uid='))
  })

  it('日志/返回值用的脱敏函数把令牌整段换掉，别的参数留着', () => {
    const url = buildStreamUrl('http://h', 'tx-S1', '320k')
    const red = redactStreamUrl(url)
    expect(red).not.toContain('TOKEN.abcdef')
    expect(red).toContain('uid=tx-S1')
  })
})

describe('选音箱：不许猜', () => {
  it('显式指定的那台不存在就报 404，不悄悄换一台', () => {
    expect(() => pickDevice([dev('1', 'A')], 'nope')).toThrow(/不在设备列表/)
  })

  it('指定的那台离线 ⇒ 报"推过去也不会有声音"', () => {
    expect(() => pickDevice([dev('1', 'A', { presence: 'offline' })], '1')).toThrow(/离线/)
  })

  it('没纳管的设备不会被自动选中（哪怕它在线）', () => {
    expect(() => pickDevice([dev('1', 'A', { managed: false })])).toThrow(/纳管/)
  })

  it('两台都在线且都纳管 ⇒ 要人指定，不掷骰子', () => {
    expect(() => pickDevice([dev('1', '客厅'), dev('2', '卧室')])).toThrow(/请指定要投哪一台/)
  })

  it('只有一台在线时直接用它', () => {
    const picked = pickDevice([dev('1', '客厅'), dev('2', '卧室', { presence: 'offline' })])
    expect(picked.deviceID).toBe('1')
  })
})

describe('playOnSpeaker：推完必须回读一次', () => {
  it('回读是在播 ⇒ playing=true 且没有理由字段', async () => {
    const r = await playOnSpeaker({ uid: 'tx-S1' })
    expect(r).toMatchObject({ playing: true, pushed: true, deviceName: '小爱音箱Play', hardware: 'L05B', reason: null })
    expect(h.getPlayStatus).toHaveBeenCalledTimes(1)
  })

  it('设备端没认这条指令 ⇒ 连状态都不去读，直接说"音箱拒绝执行"', async () => {
    h.playUrl.mockResolvedValue(false)
    const r = await playOnSpeaker({ uid: 'tx-S1' })
    expect(r.playing).toBe(false)
    expect(r.pushed).toBe(false)
    expect(r.reason).toMatch(/设备端没认/)
    expect(h.getPlayStatus).not.toHaveBeenCalled()
  })

  it('推成功但回读不是"在播" ⇒ 报"可能是它没拉到这条流地址"，并把状态码带上', async () => {
    h.getPlayStatus.mockResolvedValue({ status: 0, position: 0, duration: -1, volume: 10, title: '' })
    const r = await playOnSpeaker({ uid: 'tx-S1' })
    expect(r.playing).toBe(false)
    expect(r.pushed).toBe(true)
    expect(r.reason).toMatch(/状态码 0/)
  })

  it('这台干脆不报状态：说"回读不到"，不算成功也不算失败', async () => {
    h.getPlayStatus.mockRejectedValue(new Error('读取设备列表失败（HTTP 500）'))
    const r = await playOnSpeaker({ uid: 'tx-S1' })
    expect(r.status).toBeNull()
    expect(r.reason).toMatch(/回读不到/)
  })

  it('总开关关着 / 地址没配 / 库里没这首歌，各自都是一句明确的话', async () => {
    h.config = { ...h.config, enabled: false }
    await expect(playOnSpeaker({ uid: 'tx-S1' })).rejects.toThrow(/总开关/)
    h.config = { ...h.config, enabled: true, serverHost: '' }
    await expect(playOnSpeaker({ uid: 'tx-S1' })).rejects.toThrow(/音箱可达的服务地址/)
    h.config = { ...h.config, serverHost: '172.16.1.20:3000' }
    h.resolveMusicInfoById.mockResolvedValue(null)
    await expect(playOnSpeaker({ uid: 'tx-404' })).rejects.toThrow(/找不到这首歌/)
    // 一次都不该出网
    expect(h.playUrl).not.toHaveBeenCalled()
  })

  it('推给音箱的 URL 不出现在返回值里（它带着令牌）', async () => {
    const r = await playOnSpeaker({ uid: 'tx-S1' })
    expect(JSON.stringify(r)).not.toContain('TOKEN.abcdef')
    expect(JSON.stringify(r)).not.toContain('/api/speaker/stream')
  })

  it('型号与"摘出 Music API 名单"的覆盖位都会传到协议层', async () => {
    h.config = { ...h.config, musicApiDisabledModels: ['L05B'] }
    await playOnSpeaker({ uid: 'tx-S1' })
    expect(h.playUrl).toHaveBeenCalledWith(
      CREDS, '1', expect.any(String), 'L05B',
      { musicApiDisabled: ['L05B'] },
    )
  })
})

describe('播控与音量', () => {
  it('暂停/停止都落到选中的那台，设备端没认就报错', async () => {
    h.playerOperation.mockResolvedValue(true)
    const d = await controlSpeaker('pause')
    expect(d.deviceID).toBe('1')
    h.playerOperation.mockResolvedValue(false)
    await expect(controlSpeaker('stop')).rejects.toThrow(/没认/)
  })

  it('音量非数字直接拒，不去打小米', async () => {
    await expect(setSpeakerVolume(Number.NaN)).rejects.toThrow(/数字/)
    expect(h.setVolume).not.toHaveBeenCalled()
  })
})

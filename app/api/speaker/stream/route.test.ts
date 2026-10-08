/**
 * 音箱流出口（G1）测试。
 *
 * 这条口的全部意义是"**给音箱的那份必须是 MP3**"：它比 `/api/audio` 多一道容器闸门，
 * 而且令牌要能被固件那套"把 & 换成空格"的破写法还原回来。Range/构造响应那些
 * 复用 audio-serve 的现成实现，它自己的用例已经覆盖过，这里不重复测。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  verifyShareAudioToken: vi.fn(() => true),
  resolveMusicInfoById: vi.fn(),
  findLibrarySong: vi.fn(),
  readHeadBytes: vi.fn(),
  readBytesAt: vi.fn(async () => null),
  resolvePaths: vi.fn(() => ({ filePath: '/cache/x.mp3' })),
  detectContainer: vi.fn(),
  mimeFromContainer: vi.fn(() => 'audio/mpeg'),
  stat: vi.fn(async () => ({ size: 4321 })),
  serve: vi.fn(),
  full: vi.fn((p: string) => new Response('full:' + p, { status: 200, headers: new Headers({ 'content-type': 'audio/mpeg' }) })),
  partial: vi.fn(() => new Response('partial', { status: 206, headers: new Headers({ 'content-type': 'audio/mpeg' }) })),
  unsat: vi.fn(() => new Response('416', { status: 416 })),
  parseRange: vi.fn(() => null),
}))

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/db', () => ({ resolveMusicInfoById: h.resolveMusicInfoById }))
vi.mock('@/lib/services/auth', () => ({ verifyShareAudioToken: h.verifyShareAudioToken }))
vi.mock('@/lib/services/music-library', () => ({ findLibrarySong: h.findLibrarySong }))
vi.mock('@/lib/server/audio-sniff', () => ({
  readHeadBytes: h.readHeadBytes, readBytesAt: h.readBytesAt, detectContainer: h.detectContainer, mimeFromContainer: h.mimeFromContainer,
}))
vi.mock('@/lib/audio-serve', () => ({
  audioServe: { serve: h.serve, ensureInitialized: vi.fn() },
  buildFullResponse: h.full, buildPartialResponse: h.partial, buildUnsatisfiable: h.unsat, parseRange: h.parseRange,
  resolvePaths: h.resolvePaths,
}))
vi.mock('fs/promises', () => ({ default: { stat: h.stat } }))
// 转码（G1.5）。默认"开关关着"，让原有那些用例走的还是老路径（非 MP3 ⇒ 改走在线）
const tc = vi.hoisted(() => ({
  readSpeakerConfig: vi.fn(),
  probeFfmpeg: vi.fn(),
  transcodeToMp3: vi.fn(),
  Busy: class TranscodeBusyError extends Error {
    constructor() { super('转码通道已满'); this.name = 'TranscodeBusyError' }
  },
}))
vi.mock('@/lib/services/xiaomi/token-store', () => ({ readSpeakerConfig: tc.readSpeakerConfig }))
vi.mock('@/lib/server/audio-transcode', () => ({
  probeFfmpeg: tc.probeFfmpeg, transcodeToMp3: tc.transcodeToMp3, TranscodeBusyError: tc.Busy,
}))

const { GET, readParams } = await import('@/app/api/speaker/stream/route')

const MUSIC_INFO = { name: '稻香', singer: '周杰伦', source: 'tx', songmid: 'S1', interval: '223', types: [] }
const TOKEN = 'eyJ1IjoidHgtUzEifQ.deadbeef'

const req = (qs: string) => new NextRequest(`http://127.0.0.1:3000/api/speaker/stream${qs}`)
const okUrl = (uid = 'tx-S1', quality = '320k') => `?st=${TOKEN}&uid=${encodeURIComponent(uid)}&quality=${quality}`

beforeEach(() => {
  for (const f of [tc.readSpeakerConfig, tc.probeFfmpeg, tc.transcodeToMp3]) f.mockReset()
  // 默认"开关关着"：转码那条路的探测与 spawn 只由下面那个 describe 里的用例触发，别串味
  tc.readSpeakerConfig.mockResolvedValue({ transcodeEnabled: false, ffmpegPath: 'ffmpeg', transcodeNormalize: false, transcodeCapMb: 500 })
  tc.probeFfmpeg.mockResolvedValue(null)
  for (const f of [h.verifyShareAudioToken, h.resolveMusicInfoById, h.findLibrarySong, h.readHeadBytes,
    h.detectContainer, h.mimeFromContainer, h.stat, h.serve, h.full, h.partial, h.unsat, h.parseRange]) f.mockReset()
  h.verifyShareAudioToken.mockReturnValue(true)
  h.readBytesAt.mockResolvedValue(null)
  h.resolveMusicInfoById.mockResolvedValue(MUSIC_INFO)
  h.findLibrarySong.mockResolvedValue(null)
  h.stat.mockResolvedValue({ size: 4321 })
  h.parseRange.mockReturnValue(null)
  h.full.mockImplementation((p: string) => new Response('full:' + p, { status: 200, headers: new Headers({ 'content-type': 'audio/mpeg' }) }))
  h.partial.mockReset().mockImplementation(() => new Response('partial', { status: 206, headers: new Headers({ 'content-type': 'audio/mpeg' }) }))
  h.mimeFromContainer.mockReturnValue('audio/mpeg')
})

describe('令牌：只认 st，且要能从被改写的查询串里还原', () => {
  it('没带令牌 / 验不过 ⇒ 401，不碰库也不出网', async () => {
    h.verifyShareAudioToken.mockReturnValue(false)
    const res = await GET(req('?uid=tx-S1&quality=320k'))
    expect(res.status).toBe(401)
    expect(h.resolveMusicInfoById).not.toHaveBeenCalled()
    expect(h.serve).not.toHaveBeenCalled()
  })

  it('验令牌时传的是**逐字一致的 uid+quality**（换音质即失效）', async () => {
    h.detectContainer.mockReturnValue('mp3')
    h.findLibrarySong.mockResolvedValue({ filePath: '/lib/稻香.mp3', quality: '320k' })
    await GET(req('?st=T&uid=tx-S1&quality=128k'))
    expect(h.verifyShareAudioToken).toHaveBeenCalledWith('tx-S1', '128k', 'T')
  })

  it('固件把 & 换成空格时：st 在第一位才救得回来', () => {
    const mangled = req(`?st=${TOKEN} uid=tx-S1 quality=320k`)
    const params = readParams(mangled)
    expect(params.get('st')).toBe(TOKEN)
    expect(params.get('uid')).toBe('tx-S1')
    expect(params.get('quality')).toBe('320k')
  })

  it('令牌不在第一位时救不回来 ⇒ 401（这正是 st 必须放第一个的原因）', async () => {
    // 固件把 & 换成空格后，被吞进来的那段会粘在**前一个**参数的值上：
    // `uid=tx-S1 st=T` ⇒ uid 变成 "tx-S1 st=T"，而 st 这个键根本不存在。除 st 之外没法通用地还原。
    h.verifyShareAudioToken.mockReturnValue(false)
    const res = await GET(req(`?uid=tx-S1 st=${TOKEN}&quality=320k`))
    expect(res.status).toBe(401)
    expect(h.verifyShareAudioToken).toHaveBeenCalledWith('tx-S1 st=' + TOKEN, '320k', '')
    expect(h.serve).not.toHaveBeenCalled()
  })
})

describe('MP3 闸门', () => {
  it('请求 flac 档直接拒 —— 静默降一档会让管理员以为推的是高品', async () => {
    const res = await GET(req('?st=T&uid=tx-S1&quality=flac'))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('QUALITY_NOT_SUPPORTED')
  })

  it('库里文件嗅出来是 mp3 ⇒ 直接服务本地文件（从头，200）', async () => {
    h.findLibrarySong.mockResolvedValue({ filePath: '/lib/稻香.mp3', quality: '320k' })
    h.readHeadBytes.mockResolvedValue(new Uint8Array([0x49, 0x44, 0x33]))
    h.detectContainer.mockReturnValue('mp3')
    const res = await GET(req(okUrl()))
    expect(res.status).toBe(200)
    expect(h.serve).not.toHaveBeenCalled()
    expect(h.full.mock.calls[0][0]).toBe('/lib/稻香.mp3')
  })

  it('扩展名是 .mp3 但字节是 FLAC ⇒ 不信扩展名，改走在线取 MP3 档', async () => {
    h.findLibrarySong.mockResolvedValue({ filePath: '/lib/撒谎.mp3', quality: 'flac' })
    h.readHeadBytes.mockResolvedValue(new Uint8Array([0x66, 0x4c, 0x61, 0x43]))
    h.detectContainer.mockReturnValue('flac')
    h.serve.mockResolvedValue(new Response('x', { status: 200, headers: new Headers({ 'content-type': 'audio/mpeg' }) }))
    const res = await GET(req(okUrl()))
    expect(res.status).toBe(200)
    expect(h.serve).toHaveBeenCalledTimes(1)
  })

  it('库里根本没有 ⇒ 走在线，并且 cacheKey 带的是请求那一档', async () => {
    h.serve.mockResolvedValue(new Response('x', { status: 200, headers: new Headers({ 'content-type': 'audio/mpeg' }) }))
    await GET(req(okUrl('tx-S1', '128k')))
    expect(h.serve.mock.calls[0][0]).toMatchObject({ cacheKey: 'tx:S1:128k' })
  })

  it('在线拿回来的还是非 MP3 ⇒ 415 说清楚，不把它推给音箱', async () => {
    h.serve.mockResolvedValue(new Response('x', { status: 200, headers: new Headers({ 'content-type': 'audio/flac' }) }))
    const res = await GET(req(okUrl()))
    expect(res.status).toBe(415)
    expect((await res.json()).error.code).toBe('NOT_MP3')
  })

  it('源全挂了 ⇒ 502 且是一句"没给出可播地址"', async () => {
    h.serve.mockRejectedValue(new Error('所有音源均无法获取播放链接'))
    const res = await GET(req(okUrl()))
    expect(res.status).toBe(502)
    expect((await res.json()).error.message).toMatch(/没给出/)
  })

  it('库里没这首歌 ⇒ 404', async () => {
    h.resolveMusicInfoById.mockResolvedValue(null)
    const res = await GET(req(okUrl('tx-nope')))
    expect(res.status).toBe(404)
  })
})

describe('seek：音箱侧没有设备 seek，只能重推一条从中间开始的流', () => {
  /** ID3v2 体 356 字节、第一帧（MPEG1 LIII 320k）正好落在 366 的头部 */
  const TAGGED_HEAD = new Uint8Array([
    0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0, 0, 2, 100,
    ...Array(356).fill(0), 0xff, 0xfb, 0xe0, 0x00,
  ])

  it('库内 MP3 + seek=10 ⇒ 从"标签后 400000 字节"起给一条 200（不是分片）', async () => {
    h.findLibrarySong.mockResolvedValue({ filePath: '/lib/稻香.mp3', quality: '320k' })
    h.readHeadBytes.mockResolvedValue(TAGGED_HEAD)
    h.detectContainer.mockReturnValue('mp3')
    h.stat.mockResolvedValue({ size: 1_000_000 })
    const res = await GET(req(okUrl() + '&seek=10'))
    expect(res.status).toBe(200)
    // 跳过 366 字节的标签，再按帧头码率 40000 B/s 走 10 秒
    expect(h.full.mock.calls[0][0]).toBe('/lib/稻香.mp3')
    expect(h.full.mock.calls[0][1]).toBe(1_000_000 - (366 + 400_000))
    expect(h.full.mock.calls[0][4]).toBe(366 + 400_000)
    expect(h.partial).not.toHaveBeenCalled()
  })

  it('粗偏移落在半帧上时要挪到帧首（否则解码器起手不同步，实测会一声不出）', async () => {
    h.findLibrarySong.mockResolvedValue({ filePath: '/lib/稻香.mp3', quality: '320k' })
    h.readHeadBytes.mockResolvedValue(TAGGED_HEAD)
    h.detectContainer.mockReturnValue('mp3')
    h.stat.mockResolvedValue({ size: 1_000_000 })
    // 窗口里前 9 字节是垃圾，第 10 字节起才是帧首；320k/44.1kHz 一帧 1044 字节，
    // 连着摆两帧才能过"下一帧也在帧首"的判据（单看 0xFF 会被数据段骗到）
    const frame = new Uint8Array(1044)
    frame.set([0xff, 0xfb, 0xe0, 0x00])
    h.readBytesAt.mockResolvedValue(new Uint8Array([...Array(9).fill(0), ...frame, ...frame]))
    await GET(req(okUrl() + '&seek=5'))
    expect(h.full.mock.calls[0][4]).toBe(366 + 200_000 + 9)
  })

  it('找不到帧首就按粗偏移发，并在日志里留一句警告（不默默装作对齐过）', async () => {
    h.findLibrarySong.mockResolvedValue({ filePath: '/lib/怪.mp3', quality: '320k' })
    h.readHeadBytes.mockResolvedValue(TAGGED_HEAD)
    h.detectContainer.mockReturnValue('mp3')
    h.stat.mockResolvedValue({ size: 1_000_000 })
    h.readBytesAt.mockResolvedValue(new Uint8Array(64))
    await GET(req(okUrl() + '&seek=5'))
    expect(h.full.mock.calls[0][4]).toBe(366 + 200_000)
  })

  it('在线档走同一套对齐，Range 用对齐后的字节（缓存文件在 resolvePaths 那个位置）', async () => {
    h.findLibrarySong.mockResolvedValue(null)
    h.readBytesAt.mockResolvedValue(new Uint8Array(0))
    h.serve.mockResolvedValue(new Response('x', { status: 200, headers: new Headers({ 'content-type': 'audio/mpeg' }) }))
    await GET(req(okUrl() + '&seek=2'))
    expect(h.resolvePaths).toHaveBeenCalledWith('tx:S1:320k', 'audio/mpeg')
    expect(h.serve.mock.calls[0][0].rangeHeader).toBe('bytes=80000-')
  })

  it('seek 越过文件尾 ⇒ 416，不发一个长度为 0 的 206', async () => {
    h.findLibrarySong.mockResolvedValue({ filePath: '/lib/短.mp3', quality: '320k' })
    h.readHeadBytes.mockResolvedValue(TAGGED_HEAD)
    h.detectContainer.mockReturnValue('mp3')
    h.stat.mockResolvedValue({ size: 1000 })
    const res = await GET(req(okUrl() + '&seek=900'))
    expect(res.status).toBe(416)
    expect(h.partial).not.toHaveBeenCalled()
  })

  it('在线那一档：seek 换算成 Range 交给 audioServe（按音质档名义码率估）', async () => {
    h.findLibrarySong.mockResolvedValue(null)
    h.serve.mockResolvedValue(new Response('x', { status: 200, headers: new Headers({ 'content-type': 'audio/mpeg' }) }))
    await GET(req(okUrl() + '&seek=5'))
    expect(h.serve.mock.calls[0][0].rangeHeader).toBe('bytes=200000-')
  })

  it('坏 seek（负数、非数字）当没填：照常给整文件，不猜一个位置', async () => {
    h.findLibrarySong.mockResolvedValue({ filePath: '/lib/a.mp3', quality: '320k' })
    h.readHeadBytes.mockResolvedValue(TAGGED_HEAD)
    h.detectContainer.mockReturnValue('mp3')
    const res = await GET(req(okUrl() + '&seek=-3'))
    expect(res.status).toBe(200)
    expect(h.full).toHaveBeenCalledTimes(1)
    expect(h.partial).not.toHaveBeenCalled()
  })

  it('seek 排在最后、st 仍在第一位：固件把 & 换成空格时这条救法不能破', () => {
    const p = readParams(req(`?st=${TOKEN} uid=tx-S1 quality=320k seek=42`))
    expect(p.get('st')).toBe(TOKEN)
    expect(p.get('uid')).toBe('tx-S1')
    expect(p.get('seek')).toBe('42')
  })
})

describe('转码出口（G1.5：库里的 FLAC 也能投）', () => {
  const on = () => tc.readSpeakerConfig.mockResolvedValue(
    { transcodeEnabled: true, ffmpegPath: 'ffmpeg', transcodeNormalize: false, transcodeCapMb: 500 },
  )
  const flacInLibrary = () => {
    h.findLibrarySong.mockResolvedValue({ filePath: '/lib/稻香.flac', quality: 'flac' })
    h.readHeadBytes.mockResolvedValue(new Uint8Array([0x66, 0x4c, 0x61, 0x43]))
    h.detectContainer.mockReturnValue('flac')
  }

  it('转码可用 ⇒ 交付的是转好的那份 MP3，一次都不打在线', async () => {
    on(); tc.probeFfmpeg.mockResolvedValue('ffmpeg version 6.0')
    tc.transcodeToMp3.mockResolvedValue({ filePath: '/cache/tc.mp3', size: 5000, reused: false })
    flacInLibrary()
    const res = await GET(req(okUrl()))
    expect(res.status).toBe(200)
    expect(tc.transcodeToMp3).toHaveBeenCalledWith(expect.objectContaining({
      sourceFile: '/lib/稻香.flac', uid: 'tx-S1', quality: '320k', bin: 'ffmpeg',
    }))
    expect(h.serve).not.toHaveBeenCalled()
    expect(h.full.mock.calls[0][0]).toBe('/cache/tc.mp3')
  })

  it('开关关着时连探都不探（探一次要 spawn 一个进程，不能白 spawn）', async () => {
    flacInLibrary()
    await GET(req(okUrl()))
    expect(tc.probeFfmpeg).not.toHaveBeenCalled()
    expect(h.serve).toHaveBeenCalledTimes(1)
  })

  it('探不到 ffmpeg ⇒ 退回原来的在线取档，不把投歌整体弄失败', async () => {
    on(); tc.probeFfmpeg.mockResolvedValue(null)
    flacInLibrary()
    h.serve.mockResolvedValue(new Response('x', { status: 200, headers: new Headers({ 'content-type': 'audio/mpeg' }) }))
    const res = await GET(req(okUrl()))
    expect(res.status).toBe(200)
    expect(tc.transcodeToMp3).not.toHaveBeenCalled()
    expect(h.serve).toHaveBeenCalledTimes(1)
  })

  it('通道满 ⇒ 503 带 Retry-After，不许偷偷换一条在线档去挤源站', async () => {
    on(); tc.probeFfmpeg.mockResolvedValue('ffmpeg version 6.0')
    tc.transcodeToMp3.mockRejectedValue(new tc.Busy())
    flacInLibrary()
    const res = await GET(req(okUrl()))
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('5')
    expect((await res.json()).error.code).toBe('TRANSCODE_BUSY')
    expect(h.serve).not.toHaveBeenCalled()
  })

  it('在线拿回来的还是非 MP3 ⇒ 转那份缓存，不再直接 415', async () => {
    on(); tc.probeFfmpeg.mockResolvedValue('ffmpeg version 6.0')
    h.findLibrarySong.mockResolvedValue(null)
    tc.transcodeToMp3.mockResolvedValue({ filePath: '/cache/tc.mp3', size: 5000, reused: true })
    h.serve.mockResolvedValue(new Response('x', { status: 200, headers: new Headers({ 'content-type': 'audio/flac' }) }))
    const res = await GET(req(okUrl()))
    expect(res.status).toBe(200)
    expect(tc.transcodeToMp3).toHaveBeenCalledWith(expect.objectContaining({ sourceFile: '/cache/x.mp3' }))
    expect(h.full.mock.calls[0][0]).toBe('/cache/tc.mp3')
  })

  it('转码失败（不是通道满）⇒ 照旧 415 说清楚，不许静默给音箱一份它放不了的字节', async () => {
    on(); tc.probeFfmpeg.mockResolvedValue('ffmpeg version 6.0')
    h.findLibrarySong.mockResolvedValue(null)
    tc.transcodeToMp3.mockRejectedValue(new Error('ffmpeg 退出码 1：Encoder not found'))
    h.serve.mockResolvedValue(new Response('x', { status: 200, headers: new Headers({ 'content-type': 'audio/flac' }) }))
    const res = await GET(req(okUrl()))
    expect(res.status).toBe(415)
    expect((await res.json()).error.code).toBe('NOT_MP3')
  })
})

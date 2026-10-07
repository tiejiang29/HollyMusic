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
  readHeadBytes: h.readHeadBytes, detectContainer: h.detectContainer, mimeFromContainer: h.mimeFromContainer,
}))
vi.mock('@/lib/audio-serve', () => ({
  audioServe: { serve: h.serve, ensureInitialized: vi.fn() },
  buildFullResponse: h.full, buildPartialResponse: h.partial, buildUnsatisfiable: h.unsat, parseRange: h.parseRange,
}))
vi.mock('fs/promises', () => ({ default: { stat: h.stat } }))

const { GET, readParams } = await import('@/app/api/speaker/stream/route')

const MUSIC_INFO = { name: '稻香', singer: '周杰伦', source: 'tx', songmid: 'S1', interval: '223', types: [] }
const TOKEN = 'eyJ1IjoidHgtUzEifQ.deadbeef'

const req = (qs: string) => new NextRequest(`http://127.0.0.1:3000/api/speaker/stream${qs}`)
const okUrl = (uid = 'tx-S1', quality = '320k') => `?st=${TOKEN}&uid=${encodeURIComponent(uid)}&quality=${quality}`

beforeEach(() => {
  for (const f of [h.verifyShareAudioToken, h.resolveMusicInfoById, h.findLibrarySong, h.readHeadBytes,
    h.detectContainer, h.mimeFromContainer, h.stat, h.serve, h.full, h.partial, h.unsat, h.parseRange]) f.mockReset()
  h.verifyShareAudioToken.mockReturnValue(true)
  h.resolveMusicInfoById.mockResolvedValue(MUSIC_INFO)
  h.findLibrarySong.mockResolvedValue(null)
  h.stat.mockResolvedValue({ size: 4321 })
  h.parseRange.mockReturnValue(null)
  h.full.mockImplementation((p: string) => new Response('full:' + p, { status: 200, headers: new Headers({ 'content-type': 'audio/mpeg' }) }))
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

  it('库里文件嗅出来是 mp3 ⇒ 直接服务本地文件', async () => {
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

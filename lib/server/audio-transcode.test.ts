/**
 * 转码出口（G1.5）测试。
 *
 * 这一版最要紧的是**不要等设备，也不要因为设备挂断就杀进程**（真机实测：它 5.1 秒拿不到
 * 字节就断开、0.1 秒后重拉同一地址；按挂断杀 = 每次差一点点白干，那首歌永远转不出来）。
 * 其余钉住的四处：
 * 1. **参数**：产物必须是整曲 MP3、不许把 seek 烘进去、不许带 ID3/封面；
 * 2. **起了就返回**：不许等 ffmpeg（调用方这一次要立刻走别的路）；
 * 3. **失败路径不许留尸体也不许写 DB 行**：否则"命中缓存"会把半截文件当好的发出去；
 * 4. **名额在返回前就占掉**：判满与占用之间隔着 await 时，十个并发请求能真起十个进程。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import path from 'node:path'

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
  stat: vi.fn(),
  resolvePaths: vi.fn(),
  getAudioServeConfig: vi.fn(() => ({ enabled: true, quotaBytes: 2 * 1024 * 1024 * 1024, cacheDir: '/cache' })),
}))

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill() { this.killed = true; return true }
}

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/db', () => ({ prisma: { audioCache: h } }))
vi.mock('@/lib/audio-serve', () => ({
  resolvePaths: h.resolvePaths,
  getAudioServeConfig: h.getAudioServeConfig,
}))
vi.mock('fs/promises', () => ({
  default: { mkdir: h.mkdir, rename: h.rename, unlink: h.unlink, stat: h.stat },
}))
vi.mock('child_process', () => ({ spawn: h.spawn }))

const mod = await import('@/lib/server/audio-transcode')
const {
  ffmpegArgs, transcodeCacheKey, probeFfmpeg, resetFfmpegProbe, findMp3Transcode, requestMp3Transcode,
  waitForTranscodeJobs, _resetTranscodeProbeForTest, MAX_TRANSCODE,
} = mod

const base = {
  bin: 'ffmpeg', sourceFile: '/lib/稻香.flac', uid: 'tx-S1',
  quality: '320k' as const, normalize: false, capMb: 500,
}
const paths = {
  root: '/cache', shardDir: '/cache/ab', filePath: '/cache/abcdef.mp3', relativeFilePath: 'ab/abcdef.mp3',
}

/** 起一个"由测试手动了结"的 ffmpeg */
function oneChild() {
  const c = new FakeChild()
  h.spawn.mockReturnValueOnce(c)
  return c
}

/**
 * requestMp3Transcode 返回时，那一单还停在 `await enforceCap → await mkdir` 前面。
 * 这时 emit('close') 是发给一个还没挂监听器的 EventEmitter —— 事件丢掉、那一单永远不结。
 * 所以要看 spawn、或了结进程之前，先排空一次。
 */
const flush = () => new Promise<void>(r => setTimeout(r, 5))

beforeEach(() => {
  for (const f of [h.spawn, h.findUnique, h.findMany, h.upsert, h.update, h.delete, h.mkdir, h.rename, h.unlink, h.stat, h.resolvePaths]) f.mockReset()
  // mockReset 会把"返回一个 promise"也抹掉，而这些地方是 await / .catch 用法
  for (const f of [h.upsert, h.update, h.delete, h.mkdir, h.rename, h.unlink]) f.mockResolvedValue(undefined)
  _resetTranscodeProbeForTest()
  h.resolvePaths.mockReturnValue(paths)
  h.findUnique.mockResolvedValue(null)
  h.findMany.mockResolvedValue([])
  h.stat.mockResolvedValue({ size: 999 })
})

afterEach(() => { vi.useRealTimers() })

describe('参数：产物是整曲 MP3，不带标签', () => {
  it('没有 -ss / 没有 seek —— 把位置烘进产物会让同一首歌存出 N 份，复用率归零', () => {
    const a = ffmpegArgs('/a.flac', '/b.part', '320k', false)
    expect(a).not.toContain('-ss')
    expect(a.join(' ')).not.toMatch(/seek/i)
  })

  it('丢封面流、不写 ID3v2、清元数据（字节偏移起播不必再算标签块，音箱也不会读标签）', () => {
    const a = ffmpegArgs('/a.flac', '/b.part', '320k', false)
    expect(a).toContain('-vn')
    expect(a).toContain('-nostdin')
    const i = a.indexOf('-id3v2_version')
    expect(i).toBeGreaterThan(-1)
    expect(a[i + 1]).toBe('0')
    const m = a.indexOf('-map_metadata')
    expect(m).toBeGreaterThan(-1)
    expect(a[m + 1]).toBe('-1')
  })

  it('按档给码率；打开响度归一化才加 loudnorm', () => {
    expect(ffmpegArgs('/a', '/b', '128k', false)).toContain('128k')
    expect(ffmpegArgs('/a', '/b', '320k', false)).toContain('320k')
    expect(ffmpegArgs('/a', '/b', '320k', false).join(' ')).not.toContain('loudnorm')
    expect(ffmpegArgs('/a', '/b', '320k', true).join(' ')).toContain('loudnorm')
  })

  it('缓存键把音质与响度分开 —— 同一首歌不同档不能互相冒充', () => {
    expect(transcodeCacheKey('tx-S1', '320k', false)).toBe('tc:tx-S1:320k')
    expect(transcodeCacheKey('tx-S1', '128k', false)).toBe('tc:tx-S1:128k')
    expect(transcodeCacheKey('tx-S1', '320k', true)).toBe('tc:tx-S1:320k:loud')
  })
})

describe('探测 ffmpeg：结果要缓存，但必须能重新探', () => {
  it('探到就记版本首行，同一个路径不再 spawn 第二次', async () => {
    const c = oneChild()
    setTimeout(() => { c.stdout.emit('data', Buffer.from('ffmpeg version 6.0\n备用行\n')); c.emit('close', 0) }, 0)
    expect(await probeFfmpeg('ffmpeg')).toBe('ffmpeg version 6.0')
    expect(await probeFfmpeg('ffmpeg')).toBe('ffmpeg version 6.0')
    expect(h.spawn).toHaveBeenCalledTimes(1)
  })

  it('没装（spawn 报 ENOENT）⇒ null 且记住；刚装完 reset 一下才会重新探', async () => {
    const c = oneChild()
    setTimeout(() => c.emit('error', new Error('ENOENT')), 0)
    expect(await probeFfmpeg('ffmpeg')).toBeNull()
    expect(await probeFfmpeg('ffmpeg')).toBeNull()
    expect(h.spawn).toHaveBeenCalledTimes(1)

    resetFfmpegProbe('ffmpeg')
    const c2 = oneChild()
    setTimeout(() => { c2.stdout.emit('data', Buffer.from('ffmpeg version 7.1')); c2.emit('close', 0) }, 0)
    expect(await probeFfmpeg('ffmpeg')).toBe('ffmpeg version 7.1')
  })

  it('退出码非 0 算没探到（那种二进制在但跑不起来，转码一定也会失败）', async () => {
    const c = oneChild()
    setTimeout(() => c.emit('close', 1), 0)
    expect(await probeFfmpeg('ffmpeg')).toBeNull()
  })
})

describe('要一份 MP3：命中就给，没命中就起后台单', () => {
  it('DB 有行且文件在 ⇒ 一次都不 spawn，直接给产物并刷 lastAccessAt', async () => {
    h.findUnique.mockResolvedValue({ cacheKey: 'tc:tx-S1:320k', filePath: 'ab/abcdef.mp3', size: 900 })
    h.stat.mockResolvedValue({ size: 900 })
    // 绝对路径是 path.join 拼的（Windows 分隔符不一样），断言按同一套拼法算
    expect(await requestMp3Transcode(base)).toEqual({ state: 'ready', filePath: path.join('/cache', 'ab/abcdef.mp3'), size: 900 })
    expect(h.spawn).not.toHaveBeenCalled()
    expect(h.update).toHaveBeenCalled()
  })

  it('只查不问也给同一份，且不带"复用"那位（出口那侧只看有没有）', async () => {
    h.findUnique.mockResolvedValue({ cacheKey: 'tc:tx-S1:320k', filePath: 'ab/abcdef.mp3', size: 900 })
    h.stat.mockResolvedValue({ size: 900 })
    expect(await findMp3Transcode('tx-S1', '320k', false)).toEqual({ filePath: path.join('/cache', 'ab/abcdef.mp3'), size: 900 })
  })

  it('DB 说在但磁盘没有 ⇒ 删掉那行、起一单真转（留着它等于每次空转）', async () => {
    h.findUnique.mockResolvedValueOnce({ cacheKey: 'tc:tx-S1:320k', filePath: 'ab/abcdef.mp3', size: 900 })
    h.stat.mockRejectedValueOnce(new Error('ENOENT'))
    const child = oneChild()
    expect(await requestMp3Transcode(base)).toEqual({ state: 'started' })
    expect(h.delete).toHaveBeenCalled()
    await flush()
    child.emit('close', 0)
    await waitForTranscodeJobs()
    expect(h.rename).toHaveBeenCalled()
  })

  it('起了就返回，**不等 ffmpeg** —— 设备只等得起 5 秒，产物是给下一次用的', async () => {
    const kids: FakeChild[] = []
    h.spawn.mockImplementation(() => { const c = new FakeChild(); kids.push(c); return c })
    const t0 = Date.now()
    expect(await requestMp3Transcode(base)).toEqual({ state: 'started' })
    expect(Date.now() - t0).toBeLessThan(80)
    // 同一首第二次问只多要一份"起了"，不许起第二个进程
    expect(await requestMp3Transcode(base)).toEqual({ state: 'started' })
    await flush()
    expect(h.spawn).toHaveBeenCalledTimes(1)
    kids[0].emit('close', 0)
    await waitForTranscodeJobs()
  })

  it('成功路径：先落 .part、再改名、最后才写 DB 行（顺序反了半截文件会被当好的）', async () => {
    const child = oneChild()
    await requestMp3Transcode(base)
    await flush()
    const args = h.spawn.mock.calls[0][1] as string[]
    expect(args[args.length - 1]).toBe('/cache/abcdef.mp3.part')
    child.emit('close', 0)
    await waitForTranscodeJobs()
    expect(h.rename).toHaveBeenCalledWith('/cache/abcdef.mp3.part', '/cache/abcdef.mp3')
    expect(h.upsert.mock.calls[0][0].create).toMatchObject({
      cacheKey: 'tc:tx-S1:320k', filePath: 'ab/abcdef.mp3', contentType: 'audio/mpeg',
    })
  })

  it('ffmpeg 非 0 退出 ⇒ 删 .part、不写 DB 行；失败只进日志（下次同一首会重起一单，不会留永久坏产物）', async () => {
    const child = oneChild()
    await requestMp3Transcode(base)
    await flush()
    child.stderr.emit('data', Buffer.from('Encoder not found libmp3lame'))
    child.emit('close', 1)
    await waitForTranscodeJobs()
    expect(h.unlink).toHaveBeenCalledWith('/cache/abcdef.mp3.part')
    expect(h.rename).not.toHaveBeenCalled()
    expect(h.upsert).not.toHaveBeenCalled()

    // 坏了那一单不占名额也不留尸体：再问一次会重新起
    const child2 = oneChild()
    expect(await requestMp3Transcode(base)).toEqual({ state: 'started' })
    await flush()
    expect(h.spawn).toHaveBeenCalledTimes(2)
    child2.emit('close', 0)
    await waitForTranscodeJobs()
  })

  it('起进程就失败（路径写错）⇒ 一句人话进日志，不炸调用方', async () => {
    const child = oneChild()
    expect(await requestMp3Transcode({ ...base, bin: 'D:\\x' })).toEqual({ state: 'started' })
    await flush()
    child.emit('error', new Error('spawn D:\\x ENOENT'))
    await waitForTranscodeJobs()
    expect(h.unlink).toHaveBeenCalledWith('/cache/abcdef.mp3.part')
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it('设备挂断**不许**杀进程：这一版根本不接 AbortSignal', async () => {
    const child = oneChild()
    // 早先按挂断 kill 的那版，实测设备每次都在差一点点时白干 —— 日志连排七条"请求已断开"
    expect(await requestMp3Transcode(base)).toEqual({ state: 'started' })
    await flush()
    expect(child.killed).toBe(false)
    child.emit('close', 0)
    await waitForTranscodeJobs()
    expect(child.killed).toBe(false)
  })
})

describe('并发闸与容量闸', () => {
  it('同时在转的最多 3 首：第 4 单**不起**并如实报 busy（调用方据此改走别的路）', async () => {
    const kids: FakeChild[] = []
    h.spawn.mockImplementation(() => { const c = new FakeChild(); kids.push(c); return c })
    for (let i = 0; i < MAX_TRANSCODE; i++) {
      expect(await requestMp3Transcode({ ...base, uid: `tx-A${i}` })).toEqual({ state: 'started' })
    }
    // 名额是在返回前就占掉的：不等 flush 就该看到满了（不等的话十个并发能全过判据）
    expect(await requestMp3Transcode({ ...base, uid: 'tx-B' })).toEqual({ state: 'busy' })
    await flush()
    expect(h.spawn).toHaveBeenCalledTimes(MAX_TRANSCODE)
    for (const c of kids) c.emit('close', 0)
    await waitForTranscodeJobs()
    // 释放之后同样的第 4 首要能起（闸管的是"在跑的"，不是一次性的）
    expect(await requestMp3Transcode({ ...base, uid: 'tx-B' })).toEqual({ state: 'started' })
    await flush()
    kids[kids.length - 1].emit('close', 0)
    await waitForTranscodeJobs()
  })

  it('超上限按最久没读的淘汰，且只动 tc: 那些（在线下载的整包归 audioServe 的配额管）', async () => {
    h.findMany.mockResolvedValue([
      { cacheKey: 'tc:old:320k', filePath: 'ab/old.mp3', size: 400 * 1024 * 1024 },
      { cacheKey: 'tc:newer:320k', filePath: 'cd/new.mp3', size: 200 * 1024 * 1024 },
    ])
    const child = oneChild()
    await requestMp3Transcode({ ...base, capMb: 500 })
    await flush()
    child.emit('close', 0)
    await waitForTranscodeJobs()
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { cacheKey: { startsWith: 'tc:' } },
      orderBy: { lastAccessAt: 'asc' },
    }))
    expect(h.delete).toHaveBeenCalledWith({ where: { cacheKey: 'tc:old:320k' } })
    // 淘汰到 400MB 已低于 500MB 上限 ⇒ 第二个不该再动
    expect(h.unlink).toHaveBeenCalledWith(path.join('/cache', 'ab/old.mp3'))
    expect(h.delete).not.toHaveBeenCalledWith({ where: { cacheKey: 'tc:newer:320k' } })
  })

  it('上限设 0 = 不设限，一次都不查表', async () => {
    const child = oneChild()
    await requestMp3Transcode({ ...base, capMb: 0 })
    expect(h.findMany).not.toHaveBeenCalled()
    await flush()
    child.emit('close', 0)
    await waitForTranscodeJobs()
  })
})

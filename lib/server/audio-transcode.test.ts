/**
 * 转码出口（G1.5）测试。
 *
 * 这个模块最容易静默失效的三处都在下面：
 * 1. **参数**：产物必须是整曲（不许把 seek 烘进去）、必须是 MP3、不许带 ID3/封面 ——
 *    这几条决定了出口那侧的字节偏移起播能不能对得上；
 * 2. **失败路径不许留尸体**：进程失败/超时/被断开时 `.part` 要删掉，也不能写 DB 行，
 *    否则下一次"命中缓存"会把半截文件当好的发出去；
 * 3. **并发上限是闸不是队列**：满了要立刻报错让上层 503，不能默默排队（音箱在等首包）。
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

/** 起一个"会成功的 ffmpeg"：立刻 close(0)，并把产物大小交出去 */
function okChild() { const c = new FakeChild(); h.spawn.mockReturnValueOnce(c); setTimeout(() => c.emit('close', 0), 0); return c }

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
const { ffmpegArgs, transcodeCacheKey, probeFfmpeg, resetFfmpegProbe, transcodeToMp3, _resetTranscodeProbeForTest, MAX_TRANSCODE, TranscodeBusyError } = mod

const base = {
  bin: 'ffmpeg', sourceFile: '/lib/稻香.flac', uid: 'tx-S1',
  quality: '320k' as const, normalize: false, capMb: 500,
}
const paths = {
  root: '/cache', shardDir: '/cache/ab', filePath: '/cache/abcdef.mp3', relativeFilePath: 'ab/abcdef.mp3',
}

beforeEach(() => {
  for (const f of [h.spawn, h.findUnique, h.findMany, h.upsert, h.update, h.delete, h.mkdir, h.rename, h.unlink, h.stat, h.resolvePaths]) f.mockReset()
  // mockReset 会把"返回一个 promise"这件事也抹掉，而这些地方代码是 `await`/`.catch` 用法
  for (const f of [h.upsert, h.update, h.delete, h.mkdir, h.rename, h.unlink]) f.mockResolvedValue(undefined)
  _resetTranscodeProbeForTest()
  h.resolvePaths.mockReturnValue(paths)
  h.findUnique.mockResolvedValue(null)
  h.findMany.mockResolvedValue([])
  h.stat.mockResolvedValue({ size: 999 })
})

/** 让整条 await 链跑到底（转码前面有 4~5 个 await，microtask 一次不够） */
const flush = () => new Promise<void>(r => setTimeout(r, 5))

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
    const c = new FakeChild()
    h.spawn.mockReturnValueOnce(c)
    setTimeout(() => { c.stdout.emit('data', Buffer.from('ffmpeg version 6.0\n备用行\n')); c.emit('close', 0) }, 0)
    expect(await probeFfmpeg('ffmpeg')).toBe('ffmpeg version 6.0')
    expect(await probeFfmpeg('ffmpeg')).toBe('ffmpeg version 6.0')
    expect(h.spawn).toHaveBeenCalledTimes(1)
  })

  it('没装（spawn 报 ENOENT）⇒ null 且记住；刚装完 reset 一下才会重新探', async () => {
    const c = new FakeChild()
    h.spawn.mockReturnValueOnce(c)
    setTimeout(() => c.emit('error', new Error('ENOENT')), 0)
    expect(await probeFfmpeg('ffmpeg')).toBeNull()
    expect(await probeFfmpeg('ffmpeg')).toBeNull()
    expect(h.spawn).toHaveBeenCalledTimes(1)

    resetFfmpegProbe('ffmpeg')
    const c2 = new FakeChild()
    h.spawn.mockReturnValueOnce(c2)
    setTimeout(() => { c2.stdout.emit('data', Buffer.from('ffmpeg version 7.1')); c2.emit('close', 0) }, 0)
    expect(await probeFfmpeg('ffmpeg')).toBe('ffmpeg version 7.1')
  })

  it('退出码非 0 算没探到（那种二进制在但跑不起来，转码一定也会失败）', async () => {
    const c = new FakeChild()
    h.spawn.mockReturnValueOnce(c)
    setTimeout(() => c.emit('close', 1), 0)
    expect(await probeFfmpeg('ffmpeg')).toBeNull()
  })
})

describe('转码：命中、写入与失败清理', () => {
  it('DB 有行且文件在 ⇒ 一次都不 spawn，直接复用并刷 lastAccessAt', async () => {
    h.findUnique.mockResolvedValue({ cacheKey: 'tc:tx-S1:320k', filePath: 'ab/abcdef.mp3', size: 900 })
    h.stat.mockResolvedValue({ size: 900 })
    const r = await transcodeToMp3(base)
    // 绝对路径是用 path.join 拼的（Windows 上分隔符不一样），断言要按同一套拼法算
    expect(r).toEqual({ filePath: path.join('/cache', 'ab/abcdef.mp3'), size: 900, reused: true })
    expect(h.spawn).not.toHaveBeenCalled()
    expect(h.update).toHaveBeenCalled()
  })

  it('DB 说在但磁盘没有 ⇒ 删掉那行、走真转码（留着它等于每次空转）', async () => {
    h.findUnique.mockResolvedValueOnce({ cacheKey: 'tc:tx-S1:320k', filePath: 'ab/abcdef.mp3', size: 900 })
    h.stat.mockRejectedValueOnce(new Error('ENOENT'))
    okChild()
    const r = await transcodeToMp3(base)
    expect(h.delete).toHaveBeenCalled()
    expect(r.reused).toBe(false)
    expect(h.spawn).toHaveBeenCalledTimes(1)
  })

  it('成功路径：先落 .part、再改名、最后才写 DB 行（顺序反了就会有半截文件被当好的）', async () => {
    okChild()
    const r = await transcodeToMp3(base)
    expect(r).toEqual({ filePath: '/cache/abcdef.mp3', size: 999, reused: false })
    const args = h.spawn.mock.calls[0][1] as string[]
    expect(args[args.length - 1]).toBe('/cache/abcdef.mp3.part')
    expect(h.rename).toHaveBeenCalledWith('/cache/abcdef.mp3.part', '/cache/abcdef.mp3')
    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { cacheKey: 'tc:tx-S1:320k' },
    }))
    expect(h.upsert.mock.calls[0][0].create).toMatchObject({ filePath: 'ab/abcdef.mp3', contentType: 'audio/mpeg' })
  })

  it('ffmpeg 非 0 退出 ⇒ 报错、删 .part、不写 DB 行，错误里带 stderr 尾巴', async () => {
    const c = new FakeChild()
    h.spawn.mockReturnValueOnce(c)
    setTimeout(() => { c.stderr.emit('data', Buffer.from('Encoder not found libmp3lame')); c.emit('close', 1) }, 0)
    await expect(transcodeToMp3(base)).rejects.toThrow(/libmp3lame/)
    expect(h.unlink).toHaveBeenCalledWith('/cache/abcdef.mp3.part')
    expect(h.rename).not.toHaveBeenCalled()
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it('起进程就失败（路径写错）⇒ 一句人话，且不把失败当成"没探到"糊过去', async () => {
    const c = new FakeChild()
    h.spawn.mockReturnValueOnce(c)
    setTimeout(() => c.emit('error', new Error('spawn D:\\x ENOENT')), 0)
    await expect(transcodeToMp3({ ...base, bin: 'D:\\x' })).rejects.toThrow(/起不了 ffmpeg/)
  })

  it('请求断开（音箱挂线）⇒ 杀掉进程并删产物，别留一个还在吃 CPU 的 ffmpeg', async () => {
    const ac = new AbortController()
    const c = new FakeChild()
    h.spawn.mockReturnValueOnce(c)
    const p = transcodeToMp3({ ...base, signal: ac.signal })
    await flush()
    ac.abort()
    await expect(p).rejects.toThrow(/取消/)
    expect(c.killed).toBe(true)
    expect(h.unlink).toHaveBeenCalledWith('/cache/abcdef.mp3.part')
  })

  it('同一首歌并发只起一个进程（两个客户端抢同一条流不该转两遍）', async () => {
    let child: FakeChild | null = null
    h.spawn.mockImplementation(() => { child = new FakeChild(); return child })
    const p1 = transcodeToMp3(base)
    const p2 = transcodeToMp3(base)
    await flush()
    expect(h.spawn).toHaveBeenCalledTimes(1)
    const c = child as unknown as FakeChild
    c.emit('close', 0)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.size).toBe(r2.size)
    expect(h.rename).toHaveBeenCalledTimes(1)
  })
})

describe('并发闸与容量闸', () => {
  it('同时最多 3 首：第 4 首要立刻报错，不许排队（音箱在等首包）', async () => {
    const kids: FakeChild[] = []
    h.spawn.mockImplementation(() => { const c = new FakeChild(); kids.push(c); return c })
    const ps = Array.from({ length: MAX_TRANSCODE }, (_, i) => transcodeToMp3({ ...base, uid: `tx-A${i}` }))
    await flush()
    expect(h.spawn).toHaveBeenCalledTimes(MAX_TRANSCODE)
    await expect(transcodeToMp3({ ...base, uid: 'tx-B' })).rejects.toBeInstanceOf(TranscodeBusyError)
    for (const c of kids) c.emit('close', 0)
    await Promise.all(ps)
    // 释放之后同样的第 4 首要能起来（闸是"在跑的"，不是一次性的）
    const p4 = transcodeToMp3({ ...base, uid: 'tx-B' })
    await flush()
    kids[kids.length - 1].emit('close', 0)
    await expect(p4).resolves.toBeTruthy()
  })

  it('超上限按最久没读的淘汰，且只动 tc: 那些（在线下载的整包归 audioServe 的配额管）', async () => {
    h.findMany.mockResolvedValue([
      { cacheKey: 'tc:old:320k', filePath: 'ab/old.mp3', size: 400 * 1024 * 1024 },
      { cacheKey: 'tc:newer:320k', filePath: 'cd/new.mp3', size: 200 * 1024 * 1024 },
    ])
    okChild()
    await transcodeToMp3({ ...base, capMb: 500 })
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { cacheKey: { startsWith: 'tc:' } },
      orderBy: { lastAccessAt: 'asc' },
    }))
    expect(h.delete).toHaveBeenCalledWith({ where: { cacheKey: 'tc:old:320k' } })
    expect(h.unlink).toHaveBeenCalledWith(path.join('/cache', 'ab/old.mp3'))
    // 淘汰到 400MB 已经低于 500MB 上限 ⇒ 第二个不该再动
    expect(h.delete).not.toHaveBeenCalledWith({ where: { cacheKey: 'tc:newer:320k' } })
  })

  it('上限设 0 = 不设限，一次都不查表', async () => {
    okChild()
    await transcodeToMp3({ ...base, capMb: 0 })
    expect(h.findMany).not.toHaveBeenCalled()
  })
})

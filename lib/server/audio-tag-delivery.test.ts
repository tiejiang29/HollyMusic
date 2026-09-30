/**
 * 下载打标交付的回归测试。重点不是"能跑"，而是三条会静默损坏文件的性质：
 * ① 交付字节长度必须等于响应头里的 Content-Length；
 * ② 按记账长度收口（原件比 record.size 长时不能多吐）；
 * ③ 磁盘原件一个字节都不能被改。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { planTaggedDelivery, createTaggedFileRead } from './audio-tag-delivery'
import { BLOCK_STREAMINFO, BLOCK_PADDING, BLOCK_SEEKTABLE } from './audio-tag'

const blk = (type: number, len: number, last = false) => {
  const head = Buffer.alloc(4)
  head[0] = (last ? 0x80 : 0) | type
  head[1] = (len >> 16) & 0xff
  head[2] = (len >> 8) & 0xff
  head[3] = len & 0xff
  return Buffer.concat([head, Buffer.alloc(len, 0x31 + type)])
}

/** 造一个真的能解析出链头的 FLAC 壳 + 一段"音频" */
function makeTempFlac(audioBytes = 4096, extraTail = 0) {
  const chain = Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    blk(BLOCK_STREAMINFO, 34),
    blk(BLOCK_PADDING, 200),
    blk(BLOCK_SEEKTABLE, 64),
    blk(4 /* VORBIS_COMMENT */, 120, true),
  ])
  const file = Buffer.concat([chain, Buffer.alloc(audioBytes, 0xcd), Buffer.alloc(extraTail, 0xef)])
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tagtest-')), 'song.flac')
  fs.writeFileSync(p, file)
  return { p, chain, file }
}

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

describe('planTaggedDelivery', () => {
  it('不认识的容器（既非 FLAC 也非 MP3）跳过并说明原因', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagtest-'))
    const p = path.join(dir, 'song.m4a')
    fs.writeFileSync(p, Buffer.alloc(100, 0xff))
    const r = await planTaggedDelivery(p, 100, { TITLE: 'x' })
    expect('reason' in r ? r.reason : '').toContain('.m4a')
  })

  it('长度不可信（0/NaN）不改写', async () => {
    const { p } = makeTempFlac()
    for (const size of [0, -5, Number.NaN]) {
      const r = await planTaggedDelivery(p, size, { TITLE: 'x' })
      expect('reason' in r, `size=${size}`).toBe(true)
    }
  })

  it('文件读不到时给原因而不是抛', async () => {
    const r = await planTaggedDelivery(path.join(os.tmpdir(), '不存在-xyz.flac'), 1000, { TITLE: 'x' })
    expect('reason' in r ? r.reason : '').toMatch(/打不开/)
  })
})

describe('打标交付的三条硬性质', () => {
  it('① 交付字节数 === Content-Length，且内容 = 新链头 ‖ 旧链之后的音频', async () => {
    const { p, chain, file } = makeTempFlac(4096)
    const fields = { TITLE: '海阔天空', ARTIST: 'BEYOND', LYRICS: '[00:01.00]今天我' }
    const plan = await planTaggedDelivery(p, file.length, fields)
    if ('reason' in plan) throw new Error(plan.reason)

    expect(plan.totalLength).toBe(file.length - chain.length + plan.newHead.length)
    const out = await drain(createTaggedFileRead(p, plan))
    expect(out.length).toBe(plan.totalLength)
    expect(out.subarray(0, plan.newHead.length)).toEqual(plan.newHead)
    expect(out.subarray(plan.newHead.length)).toEqual(file.subarray(chain.length))
  })

  it('② 原件比记账长度长时，只交付到记账右界（否则长度说谎、下载器会等到超时）', async () => {
    const { p, file } = makeTempFlac(2048, 8192)   // 真实文件多挂 8KB 尾巴
    const booked = file.length - 8192              // 假装 DB 里 record.size 只到这里
    const plan = await planTaggedDelivery(p, booked, { TITLE: 'x' })
    if ('reason' in plan) throw new Error(plan.reason)
    const out = await drain(createTaggedFileRead(p, plan))
    expect(out.length).toBe(plan.totalLength)
    expect(out[out.length - 1]).not.toBe(0xef)      // 未交付被截掉的尾巴
  })

  it('③ 改写全程不触碰磁盘原件', async () => {
    const { p, file } = makeTempFlac(4096)
    const before = fs.readFileSync(p)
    const plan = await planTaggedDelivery(p, file.length, { TITLE: 'x' }, { mime: 'image/jpeg', data: Buffer.alloc(500, 0x77) })
    if ('reason' in plan) throw new Error(plan.reason)
    await drain(createTaggedFileRead(p, plan))
    expect(fs.readFileSync(p)).toEqual(before)
    expect(before).toEqual(file)
  })

  it('链头坏掉（fLaC 后不是 STREAMINFO）不改写并说明原因', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagtest-'))
    const p = path.join(dir, 'broken.flac')
    fs.writeFileSync(p, Buffer.concat([Buffer.from('fLaC', 'latin1'), Buffer.alloc(300, 0x22)]))
    const r = await planTaggedDelivery(p, 304, { TITLE: 'x' })
    expect('reason' in r ? r.reason : '').toMatch(/STREAMINFO|不可解析/)
  })
})

// ===========================================================================
// MP3：换 ID3v2 头部 + 裁掉尾部 ID3v1
// ===========================================================================

const FRAME_LEN = 417                     // MPEG1 Layer3 · 128kbps · 44.1kHz
function mpegFrames(n: number): Buffer {
  const one = Buffer.alloc(FRAME_LEN, 0x10)
  one[0] = 0xff; one[1] = 0xfb; one[2] = 0x90; one[3] = 0x00
  return Buffer.concat(Array.from({ length: n }, () => Buffer.from(one)))
}
function oldId3v2(frames: number): Buffer {
  const body = Buffer.alloc(frames, 0x20)
  const size = Buffer.alloc(4)
  size[0] = (body.length >>> 21) & 0x7f
  size[3] = body.length & 0x7f
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), size, body])
}
function id3v1(): Buffer {
  return Buffer.concat([Buffer.from('TAG', 'latin1'), Buffer.alloc(125, 0x41)])   // 恒为 128B
}
/** 上游那种"空壳 ID3v2 + 裸帧 +（可选）尾部 ID3v1"的 mp3 */
function makeTempMp3(oldTagBytes = 48, frames = 8, withV1 = true) {
  const head = oldId3v2(oldTagBytes)
  const file = Buffer.concat([head, mpegFrames(frames), withV1 ? id3v1() : Buffer.alloc(0)])
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tagtest-')), 'song.mp3')
  fs.writeFileSync(p, file)
  return { p, file, headLen: head.length }
}

describe('MP3 打标交付', () => {
  it('计划自洽：totalLength = 新头部 + (音频到 fileLastByte)，且 ID3v1 被算进裁剪', async () => {
    const { p, file, headLen } = makeTempMp3()
    const r = await planTaggedDelivery(p, file.length, { TITLE: '稻香', ARTIST: '周杰伦' })
    if ('reason' in r) throw new Error(r.reason)
    expect(r.container).toBe('mp3')
    expect(r.audioStart).toBe(headLen)
    expect(r.tailTrim).toBe(128)
    expect(r.fileLastByte).toBe(file.length - 129)
    expect(r.totalLength).toBe(r.newHead.length + (r.fileLastByte - r.audioStart + 1))
  })

  it('① 交付字节数 === totalLength；② 尾部 ID3v1 真的没被吐出去', async () => {
    const { p, file } = makeTempMp3()
    const r = await planTaggedDelivery(p, file.length, { TITLE: '稻香' })
    if ('reason' in r) throw new Error(r.reason)
    const out = await drain(createTaggedFileRead(p, r))
    expect(out.length).toBe(r.totalLength)
    expect(out.subarray(0, 3).toString('latin1')).toBe('ID3')
    // 交付的音频段必须精确等于原文件 [audioStart, fileLastByte]，一字节不多
    expect(out.subarray(r.newHead.length)).toEqual(file.subarray(r.audioStart, r.fileLastByte + 1))
    expect(out.subarray(out.length - 128)).not.toEqual(id3v1())
  })

  it('③ 改写全程不触碰磁盘原件（含 ID3v1 的尾部也还在盘上）', async () => {
    const { p, file } = makeTempMp3()
    const r = await planTaggedDelivery(p, file.length, { TITLE: '稻香' })
    if ('reason' in r) throw new Error(r.reason)
    await drain(createTaggedFileRead(p, r))
    expect(fs.readFileSync(p)).toEqual(file)
  })

  it('分段在"改写后的字节空间"里寻址：三段拼回必须等于整份', async () => {
    const { p, file } = makeTempMp3()
    const r = await planTaggedDelivery(p, file.length, { TITLE: '稻香' })
    if ('reason' in r) throw new Error(r.reason)
    const hl = r.newHead.length
    const a = await drain(createTaggedFileRead(p, r, 0, hl - 2))
    const b = await drain(createTaggedFileRead(p, r, hl - 1, hl + 500))
    const c = await drain(createTaggedFileRead(p, r, hl + 501, r.totalLength - 1))
    expect([a.length, b.length, c.length]).toEqual([hl - 1, 502, r.totalLength - hl - 501])
    expect(Buffer.concat([a, b, c]).equals(await drain(createTaggedFileRead(p, r)))).toBe(true)
  })

  it('原件比记账长度长时，仍按记账右界收口（不能多吐）', async () => {
    const { p, file, headLen } = makeTempMp3(48, 8, false)
    const booked = file.length - 100                 // 假装 DB 记的长度比磁盘小
    const r = await planTaggedDelivery(p, booked, { TITLE: 'x' })
    if ('reason' in r) throw new Error(r.reason)
    expect(r.audioStart).toBe(headLen)
    const out = await drain(createTaggedFileRead(p, r))
    expect(out.length).toBe(r.totalLength)
    expect(out.subarray(r.newHead.length).length).toBe(booked - headLen)
  })

  it('内容其实不是 MP3（无连续两帧）时拒绝改写并给原因', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagtest-'))
    const p = path.join(dir, 'fake.mp3')
    fs.writeFileSync(p, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 71 + 5) & 0xff)))
    const r = await planTaggedDelivery(p, 4096, { TITLE: 'x' })
    expect('reason' in r ? r.reason : '').toContain('连续两帧')
  })
})

/**
 * MP3 seek 偏移的计算口径测试（给音箱重推"从中间开始"的流用）。
 *
 * 三条会直接决定"拖完条是准的还是噪音"的事：
 * 1. **必须跳过 ID3v2** —— 不跳就把标签字节当音频发进去，头几秒是噪音；
 * 2. **码率信帧头、不信音质档标签** —— 320k 标着、实际 128k 时按名义值算会越拖越偏；
 * 3. synchsafe 的解码是 4 字节各取低 7 位，写成普通大端就全错。
 */

import { describe, expect, it } from 'vitest'

const { id3v2Size, firstFrameBytesPerSec, planMp3Seek, NOMINAL_BYTES_PER_SEC } =
  await import('@/lib/server/mp3-seek')

/** MPEG1 Layer III 320kbps 的四字节帧头 */
const FRAME_320K = [0xff, 0xfb, 0xe0, 0x00]
/** MPEG1 Layer III 128kbps（码率索引 9） */
const FRAME_128K = [0xff, 0xfb, 0x90, 0x00]
/** MPEG2 Layer III 128kbps（版本位不同、码率表也跟着换：这张表里 128k 是索引 12，不是 9） */
const FRAME_V2_128K = [0xff, 0xf3, 0xc0, 0x04]

/** 造一个 ID3v2 头：'ID3' + 版本 + 标志 + synchsafe 大小，后面填 0 当标签内容 */
function id3Head(size: number, rest: number[]): Uint8Array {
  const synchsafe = [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]
  return new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, ...synchsafe, ...rest])
}

describe('id3v2Size：只认 ID3 开头，大小按 synchsafe 解', () => {
  it('不是 ID3 开头就当没有标签（返回 0，音频从文件头开始）', () => {
    expect(id3v2Size(new Uint8Array(FRAME_320K))).toBe(0)
  })

  it('头部不足 10 字节时不猜', () => {
    expect(id3v2Size(new Uint8Array([0x49, 0x44, 0x33]))).toBe(0)
  })

  it('synchsafe 是每字节低 7 位：[0,0,2,100] 解出 356，不是普通大端的 676', () => {
    const head = id3Head(356, [])
    expect(head.slice(6, 10)).toEqual(new Uint8Array([0, 0, 2, 100]))
    expect(id3v2Size(head)).toBe(10 + 356)
  })
})

describe('firstFrameBytesPerSec：读第一帧的码率', () => {
  it('MPEG1 Layer III 320k → 40000 字节/秒', () => {
    expect(firstFrameBytesPerSec(new Uint8Array(FRAME_320K), 0)).toBe(40000)
  })

  it('MPEG2 Layer III 128k 走的是另一张码率表（别按 MPEG1 读成 112k 那档）', () => {
    expect(firstFrameBytesPerSec(new Uint8Array(FRAME_V2_128K), 0)).toBe(16000)
  })

  it('同步字之前有垃圾也找得着（标签尾部补零、空帧都算）', () => {
    const head = new Uint8Array([...Array(200).fill(0), ...FRAME_320K, 0, 0])
    expect(firstFrameBytesPerSec(head, 0)).toBe(40000)
  })

  it('压根没有帧头时返回 null，让调用方退回名义值', () => {
    expect(firstFrameBytesPerSec(new Uint8Array(64), 0)).toBeNull()
  })

  it('非 Layer III 的帧头与无效码率索引都不采信', () => {
    // b1=0xF9 → layer 位是 00（保留层，不是 Layer III）；索引 0（免费）与 15（坏值）也一并拒绝
    expect(firstFrameBytesPerSec(new Uint8Array([0xff, 0xf9, 0x90, 0x00]), 0)).toBeNull()
    expect(firstFrameBytesPerSec(new Uint8Array([0xff, 0xfb, 0x00, 0x00]), 0)).toBeNull()
    expect(firstFrameBytesPerSec(new Uint8Array([0xff, 0xfb, 0xf0, 0x00]), 0)).toBeNull()
  })
})

describe('planMp3Seek：秒 → 从第几个字节开始发', () => {
  it('无标签：偏移 = 秒 × 帧头码率', () => {
    const head = new Uint8Array(FRAME_320K)
    expect(planMp3Seek(head, 10, NOMINAL_BYTES_PER_SEC['320k'])).toEqual({ offset: 400000, bytesPerSec: 40000, from: 'frame' })
  })

  it('有标签：从标签之后起算（不是从文件头）', () => {
    // 标签体 356 字节，第一帧正好落在偏移 366 上
    const head = id3Head(356, [...Array(356).fill(0), ...FRAME_320K])
    const plan = planMp3Seek(head, 5, NOMINAL_BYTES_PER_SEC['320k'])
    expect(plan.offset).toBe(366 + 5 * 40000)
    expect(plan.from).toBe('frame')
  })

  it('音质档写着 320k、帧头是 128k ⇒ 信帧头（这条不钉住就会越拖越偏）', () => {
    const head = new Uint8Array(FRAME_128K)
    expect(planMp3Seek(head, 10, NOMINAL_BYTES_PER_SEC['320k'])).toEqual({ offset: 160000, bytesPerSec: 16000, from: 'frame' })
  })

  it('帧头读不到才退回音质档名义值，并说明自己是估的', () => {
    const head = new Uint8Array(64)
    expect(planMp3Seek(head, 3, NOMINAL_BYTES_PER_SEC['128k'])).toEqual({ offset: 48000, bytesPerSec: 16000, from: 'nominal' })
  })

  it('sec=0 也得给出一个能用的偏移（从头发，仍要跳过标签）', () => {
    const head = id3Head(356, [...FRAME_320K])
    expect(planMp3Seek(head, 0, NOMINAL_BYTES_PER_SEC['320k']).offset).toBe(366)
  })

  it('负的/坏的秒数按 0 处理（不许算出负偏移去撞 Range 解析）', () => {
    const head = new Uint8Array(FRAME_320K)
    expect(planMp3Seek(head, -8, NOMINAL_BYTES_PER_SEC['320k']).offset).toBe(0)
    expect(planMp3Seek(head, Number.NaN, NOMINAL_BYTES_PER_SEC['320k']).offset).toBe(0)
  })
})

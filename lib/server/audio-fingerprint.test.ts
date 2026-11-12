import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  createHeadAccumulator,
  fingerprintStats,
  headFingerprint,
  matchKnownPlaceholder,
  observeCompleted,
  resetFingerprintsForTest,
} from './audio-fingerprint'

const HEAD = 32_768

/** 造一份可比的"歌曲字节"：同种子 ⇒ 同头部哈希；extraBytes 控制总大小 */
function payload(seed: string, extraBytes = 0): Uint8Array {
  const base = Buffer.alloc(HEAD + extraBytes)
  const stream = createHash('sha256').update(seed).digest()
  for (let off = 0; off < base.length; off += 32) stream.copy(base, off)
  return new Uint8Array(base)
}

/** 观察一次完成（默认时长对不上，即试听/占位那一档） */
const seen = (cacheKey: string, bytes: Uint8Array, trial = true) =>
  observeCompleted({ cacheKey, size: bytes.length, headHash: headFingerprint(bytes), trial })

afterEach(() => resetFingerprintsForTest())

describe('头部指纹的可比条件', () => {
  it('拿满 32KiB 才给指纹，短块一律 null（不猜）', () => {
    expect(headFingerprint(payload('a'))).toHaveLength(64)
    expect(headFingerprint(new Uint8Array(HEAD - 1))).toBeNull()
    expect(headFingerprint(null)).toBeNull()
    expect(headFingerprint(undefined)).toBeNull()
  })

  it('累加器攒够 32KiB 后给出的指纹与整块一致，且分多少块都一样', () => {
    const bytes = payload('split', 8_192)
    const whole = headFingerprint(bytes)
    expect(whole).toBeTruthy()

    for (const size of [1, 4_000, 32_767, 32_768, 40_000]) {
      resetFingerprintsForTest()
      const acc = createHeadAccumulator()
      for (let off = 0; off < bytes.length; off += size) acc.note(bytes.subarray(off, off + size))
      expect(acc.hash(), `分块=${size}`).toBe(whole)
    }
  })

  it('整份不足 32KiB 时累加器给 null（宁可不判，也不拿不可比的哈希去撞）', () => {
    const acc = createHeadAccumulator()
    acc.note(new Uint8Array(HEAD - 1))
    expect(acc.hash()).toBeNull()
    acc.note(new Uint8Array(1))
    expect(acc.hash()).toHaveLength(64)
  })

  it('同一首歌不同音质档算同一身份，songmid 不同才算另一首', () => {
    const bytes = payload('same')
    expect(seen('tx:001:320k', bytes).verdict).toBe('first')
    expect(seen('tx:001:flac', bytes).verdict).toBe('same-song')
    expect(seen('tx:002:flac', bytes).verdict).toBe('placeholder')
  })

  it('songmid 里带冒号也不会把音质档并进歌曲身份', () => {
    const bytes = payload('mid')
    expect(seen('kw:abc:def:320k', bytes).verdict).toBe('first')
    expect(seen('kw:abc:def:flac', bytes).verdict).toBe('same-song')
  })

  it('cacheKey 段数不足时退回整串，不会误当同一首', () => {
    const bytes = payload('short-key')
    expect(seen('weird', bytes).verdict).toBe('first')
    expect(seen('other', bytes).verdict).toBe('placeholder')
  })

  it('拿不到头部时只说明原因，不定性也不报错', () => {
    expect(observeCompleted({ cacheKey: 'tx:001:flac', size: 10, headHash: null, trial: true })).toEqual({
      verdict: 'first',
      reason: '头部不足 32KiB，未参与指纹',
    })
  })
})

describe('定性要两个信号同时成立', () => {
  it('第一次出现只登记：不拒绝也不定性（没有历史就无从知道它是占位符）', () => {
    const bytes = payload('one')
    expect(seen('tx:001:flac', bytes)).toEqual({ verdict: 'first' })
    expect(matchKnownPlaceholder({ cacheKey: 'tx:002:flac', size: bytes.length, headHash: headFingerprint(bytes) })).toBeNull()
    expect(fingerprintStats()).toEqual({ entries: 1, placeholders: 0 })
  })

  it('同一份字节 + 时长对不上 ⇒ 定性；此后除登记那首以外都在首块阶段被拒', () => {
    const bytes = payload('two')
    seen('tx:001:flac', bytes)
    expect(seen('tx:002:flac', bytes)).toEqual({ verdict: 'placeholder', otherSong: 'tx:001' })
    expect(fingerprintStats()).toEqual({ entries: 1, placeholders: 1 })
    expect(matchKnownPlaceholder({ cacheKey: 'tx:003:flac', size: bytes.length, headHash: headFingerprint(bytes) }))
      .toEqual({ otherSong: 'tx:001' })
    // 撞过的第二首再来一次照样拒：它也不该再拿到同一份占位字节
    expect(matchKnownPlaceholder({ cacheKey: 'tx:002:flac', size: bytes.length, headHash: headFingerprint(bytes) }))
      .toEqual({ otherSong: 'tx:001' })
    // 只有登记那一首（同一歌曲身份）不算撞
    expect(matchKnownPlaceholder({ cacheKey: 'tx:001:320k', size: bytes.length, headHash: headFingerprint(bytes) })).toBeNull()
  })

  it('只撞内容、时长对得上 ⇒ duplicate-ordinary：不拒绝、不记占位（合法重复录音）', () => {
    const bytes = payload('legit-dup')
    expect(seen('tx:001:flac', bytes, false).verdict).toBe('first')
    expect(seen('tx:002:flac', bytes, false)).toEqual({ verdict: 'duplicate-ordinary', otherSong: 'tx:001' })
    expect(fingerprintStats()).toEqual({ entries: 1, placeholders: 0 })
    expect(matchKnownPlaceholder({ cacheKey: 'tx:003:flac', size: bytes.length, headHash: headFingerprint(bytes) })).toBeNull()
  })

  it('先撞内容（时长对得上）、后来才出现时长对不上的一首 ⇒ 那时才定性', () => {
    const bytes = payload('late')
    seen('tx:001:flac', bytes, false)
    seen('tx:002:flac', bytes, false)
    expect(fingerprintStats().placeholders).toBe(0)
    expect(seen('tx:003:flac', bytes, true).verdict).toBe('placeholder')
    expect(fingerprintStats().placeholders).toBe(1)
  })

  it('大小相同但头部不同不算撞（同尺寸不同内容是常态）', () => {
    expect(seen('tx:001:flac', payload('x')).verdict).toBe('first')
    expect(seen('tx:002:flac', payload('y')).verdict).toBe('first')
    expect(fingerprintStats().placeholders).toBe(0)
  })

  it('头部或大小对不上时首块阶段放弃比对，而不是拿不可比的哈希去撞', () => {
    const bytes = payload('z')
    seen('tx:001:flac', bytes)
    seen('tx:002:flac', bytes)
    expect(matchKnownPlaceholder({ cacheKey: 'tx:003:flac', size: bytes.length, headHash: null })).toBeNull()
    expect(matchKnownPlaceholder({ cacheKey: 'tx:003:flac', size: 12345, headHash: headFingerprint(bytes) })).toBeNull()
  })
})

describe('内存上限', () => {
  it('超过上限按插入序淘汰，不会无界增长', () => {
    for (let i = 0; i < 8_200; i++) seen(`tx:song${i}:flac`, payload(`cap-${i}`))
    expect(fingerprintStats().entries).toBeLessThanOrEqual(8_192)
  })
})

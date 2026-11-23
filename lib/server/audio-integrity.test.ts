import { describe, expect, it } from 'vitest'
import {
  MIN_CHECK_INTERVAL_SEC,
  TRIAL_SIZE_RATIO,
  isUndersizedByContentLength,
  minDeclaredBytes,
  parseDeclaredSizeBytes,
} from './audio-integrity'

describe('parseDeclaredSizeBytes', () => {
  it('按 MiB 解析平台声明（生产对照：声明 31.48M 的实际文件是 33010086B）', () => {
    expect(parseDeclaredSizeBytes('31.48M')).toBe(33009172)
    expect(parseDeclaredSizeBytes('4.03M')).toBe(4225761)
    expect(parseDeclaredSizeBytes('3.05m')).toBe(3198157)
  })

  it('认 K/G/无单位三种写法', () => {
    expect(parseDeclaredSizeBytes('512K')).toBe(524288)
    expect(parseDeclaredSizeBytes('1.2G')).toBe(1288490189)
    expect(parseDeclaredSizeBytes('2048')).toBe(2048)
  })

  it('认不出一律返回 null（不参与判定，宁放过不误杀）', () => {
    for (const bad of [null, undefined, '', '  ', 'abc', '1.5 MB', '-3M', '0M', 'M', '1.2.3M']) {
      expect(parseDeclaredSizeBytes(bad as string | null | undefined)).toBeNull()
    }
  })
})

describe('minDeclaredBytes', () => {
  it('取各档位里的最小值，忽略认不出的项', () => {
    expect(minDeclaredBytes(['4.03M', '10.08M', '27.53M'])).toBe(4225761)
    expect(minDeclaredBytes(['10.08M', '乱码', undefined, null, '27.53M'])).toBe(
      10569646
    )
  })

  it('全不可用 / 空 / 非数组 → null（表示这首歌没有可比基准）', () => {
    expect(minDeclaredBytes(['?', 'xx'])).toBeNull()
    expect(minDeclaredBytes([])).toBeNull()
    expect(minDeclaredBytes(undefined)).toBeNull()
    expect(minDeclaredBytes(null)).toBeNull()
  })
})

describe('isUndersizedByContentLength', () => {
  // 生产实测锚点：许嵩《天龙八部之宿敌》声明 128k=4.03M / 320k=10.08M / flac=27.53M
  const SONG = { min: minDeclaredBytes(['4.03M', '10.08M', '27.53M']) as number, sec: 264 }

  it('坏锚点：vkeys 的 60 秒试听片段 960887B ⇒ 判假', () => {
    expect(SONG.min).toBe(4225761)
    expect(isUndersizedByContentLength(960887, SONG.min, SONG.sec)).toBe(true)
  })

  // 好锚点必须用各自歌曲自己的声明配对；跨歌相除会得出假余量（我犯过一次）
  const KID = { min: minDeclaredBytes(['3.89M', '9.72M']) as number, sec: 254 }

  it('好锚点：《小孩儿》整曲 m4a 2559929B（对自己 128k 声明只有 0.628）⇒ 放过', () => {
    expect(KID.min).toBe(4078961)
    expect(isUndersizedByContentLength(2559929, KID.min, KID.sec)).toBe(false)
    expect(isUndersizedByContentLength(3032067, KID.min, KID.sec)).toBe(false)
  })

  it('阈值余量：0.35 距坏锚点 33%、距最近的好锚点 44%；定 0.5 只剩 20%', () => {
    const thr = KID.min * TRIAL_SIZE_RATIO
    expect(thr).toBeGreaterThan(960887)
    expect(thr).toBeLessThan(2559929)
    expect((thr - 960887) / thr).toBeGreaterThan(0.32)
    expect((2559929 - thr) / 2559929).toBeGreaterThan(0.43)
    expect((2559929 - KID.min * 0.5) / 2559929).toBeLessThan(0.25)
  })

  it('好锚点：跨平台拿到的真无损（比值精确 1.00 那一类）⇒ 放过', () => {
    expect(isUndersizedByContentLength(29055486, minDeclaredBytes(['3.05M', '7.63M', '27.71M']), 200)).toBe(false)
    expect(isUndersizedByContentLength(48044550, minDeclaredBytes(['3.05M', '7.63M', '45.82M']), 200)).toBe(false)
  })

  it('边界：严格小于才判，正好等于下限放过', () => {
    const atThreshold = Math.ceil(SONG.min * TRIAL_SIZE_RATIO)
    expect(isUndersizedByContentLength(atThreshold, SONG.min, SONG.sec)).toBe(false)
    expect(isUndersizedByContentLength(atThreshold - 1, SONG.min, SONG.sec)).toBe(true)
  })

  it('无声明基准 / 短曲 / CL 无效 ⇒ 一律放过', () => {
    expect(isUndersizedByContentLength(1000, null, 300)).toBe(false)
    expect(isUndersizedByContentLength(1000, SONG.min, MIN_CHECK_INTERVAL_SEC - 1)).toBe(false)
    expect(isUndersizedByContentLength(NaN, SONG.min, SONG.sec)).toBe(false)
    expect(isUndersizedByContentLength(0, SONG.min, SONG.sec)).toBe(false)
    expect(isUndersizedByContentLength(-5, SONG.min, SONG.sec)).toBe(false)
  })
})

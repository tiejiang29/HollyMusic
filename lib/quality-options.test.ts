import { describe, it, expect } from 'vitest'
import { resolveQuality, getAvailableQualities, nextLowerQuality, qualityFromBytes, meetsRequestedQuality } from './quality-options'
import type { QualityInfo, QualityType } from './types/music'

/** 快速构造 types 数组 */
const types = (...qs: QualityType[]): QualityInfo[] => qs.map(q => ({ type: q, size: '1M' }))

describe('resolveQuality - 偏好高于歌曲支持时必须降级到可播放档', () => {
  it('偏好∈支持 → 用偏好', () => {
    expect(resolveQuality('320k', types('128k', '320k', 'flac'))).toBe('320k')
  })

  it('偏好 Hi-Res，歌曲仅 [320k,128k] → 降级到 320k', () => {
    expect(resolveQuality('flac24bit', types('320k', '128k'))).toBe('320k')
  })

  it('偏好 FLAC，歌曲仅 [320k,128k] → 降级到 320k', () => {
    expect(resolveQuality('flac', types('320k', '128k'))).toBe('320k')
  })

  it('偏好 320k，歌曲仅 [128k] → 降级到 128k', () => {
    expect(resolveQuality('320k', types('128k'))).toBe('128k')
  })

  it('偏好 Hi-Res，歌曲仅 [128k] → 降级到 128k（不会返回不支持的高档）', () => {
    expect(resolveQuality('flac24bit', types('128k'))).toBe('128k')
  })

  it('偏好低于所有支持档 → 取最低档（保证能播，不报错）', () => {
    // 偏好 128k，但歌曲只有无损 → 取 flac（最接近的可用档）
    expect(resolveQuality('128k', types('flac', 'flac24bit'))).toBe('flac')
  })

  it('types 为空/缺失 → 返回偏好（交服务端 getMusicUrl 降级兜底）', () => {
    expect(resolveQuality('flac24bit', [])).toBe('flac24bit')
    expect(resolveQuality('flac24bit', undefined)).toBe('flac24bit')
  })

  it('降级结果一定落在歌曲支持范围内（除 types 空的兜底分支）', () => {
    const supported = types('128k', '320k')
    const result = resolveQuality('flac24bit', supported)
    expect(supported.some(t => t.type === result)).toBe(true)
  })
})

describe('getAvailableQualities', () => {
  it('按高→低返回支持的音质', () => {
    expect(getAvailableQualities(types('128k', '320k'))).toEqual(['320k', '128k'])
  })

  it('types 空 → 返回空数组', () => {
    expect(getAvailableQualities([])).toEqual([])
    expect(getAvailableQualities(undefined)).toEqual([])
  })
})

describe('nextLowerQuality - 解码失败降级链路', () => {
  it('flac24bit → flac', () => {
    expect(nextLowerQuality('flac24bit')).toBe('flac')
  })

  it('flac → 320k（FLAC 解不了降 MP3，典型手机 WebView 场景）', () => {
    expect(nextLowerQuality('flac')).toBe('320k')
  })

  it('320k → 128k', () => {
    expect(nextLowerQuality('320k')).toBe('128k')
  })

  it('128k（最低档）→ null，表示无法再降级，交跳歌逻辑', () => {
    expect(nextLowerQuality('128k')).toBeNull()
  })
})

describe('meetsRequestedQuality - 候选流按实际字节判达标', () => {
  it('Hi-Res 请求遇到 FLAC 魔数即放行：现有字节判据分不出 16/24bit', () => {
    expect(meetsRequestedQuality('flac', 'flac24bit')).toBe(true)
  })

  it('高档请求不会被低档冒充；同档与更高档都放行', () => {
    expect(meetsRequestedQuality('320k', 'flac')).toBe(false)
    expect(meetsRequestedQuality('128k', '128k')).toBe(true)
    expect(meetsRequestedQuality('flac', '320k')).toBe(true)
  })

  it('证据不足返回 null 时不判达标，留给可播兜底', () => {
    expect(meetsRequestedQuality(null, '320k')).toBe(false)
  })
})

describe('qualityFromBytes - 入库按字节承认的档位记账', () => {
  // 数字全部来自 2026-11-19 对生产库 514 行 quality='flac' 的逐文件魔数普查
  it('Ogg 容器 + 80kbps（《晚秋》那份 2.0MB/212s 的 Ogg Vorbis）→ 128k，不是 flac', () => {
    expect(qualityFromBytes({ container: 'ogg', sizeBytes: 2136443, durationSec: 212.0 }))
      .toBe('128k')
  })

  it('mp3 容器即使码率够 320k 也不是无损（大海 3.2MB/267s=97kbps 同判 128k）', () => {
    expect(qualityFromBytes({ container: 'mp3', sizeBytes: 3247865, durationSec: 267.145578231293 }))
      .toBe('128k')
    expect(qualityFromBytes({ container: 'mp3', sizeBytes: 9_600_000, durationSec: 240 }))
      .toBe('320k')
  })

  it('flac 容器就认无损：本函数不用码率去质疑已经承认的容器', () => {
    expect(qualityFromBytes({ container: 'flac', sizeBytes: 27_400_000, durationSec: 240 }))
      .toBe('flac')
  })

  it('时长或字节缺失 → null（下不了结论，调用方保持旧行为）', () => {
    expect(qualityFromBytes({ container: 'ogg', sizeBytes: 2136443, durationSec: 0 })).toBeNull()
    expect(qualityFromBytes({ container: 'flac', sizeBytes: 0, durationSec: 212 })).toBeNull()
  })
})

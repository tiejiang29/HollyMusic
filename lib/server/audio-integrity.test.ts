import { describe, expect, it } from 'vitest'
import {
  MIN_CHECK_INTERVAL_SEC,
  TRIAL_SIZE_RATIO,
  estimateDurationFromHead,
  isIncompleteTrial,
  isUndersizedByContentLength,
  judgePayloadLength,
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

  it('兜底阈值余量：0.5 夹在坏 0.390 与好 0.628 之间（0.35 已被实测证伪）', () => {
    const thr = KID.min * TRIAL_SIZE_RATIO
    expect(TRIAL_SIZE_RATIO).toBe(0.5)
    expect(thr).toBeGreaterThan(960887)
    expect(thr).toBeLessThan(2559929)
    // 0.35 的漏检就发生在短歌：同一份罐头对 154s 那首自己的 128k 声明是 0.390 > 0.35
    const SHORT_MIN = minDeclaredBytes(['2.35M', '5.88M', '33.57M']) as number
    expect(960_887 / SHORT_MIN).toBeGreaterThan(0.35)
    expect(960_887 / SHORT_MIN).toBeLessThan(0.5)
    // 现在两侧余量：坏侧 54%、好侧 20%
    expect((thr - 960887) / thr).toBeGreaterThan(0.5)
    expect((2559929 - thr) / 2559929).toBeGreaterThan(0.2)
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

// ===========================================================================
// 首块解真实时长（主判据）与两条判据取"或"
// ===========================================================================

/** 生产库真文件《周杰伦 - 搁浅.flac》的前 48 字节（只读文件头取回，用于钉死解码） */
const FLAC_HEAD = Buffer.from(
  '664c614300000022100010000000100033790ac442f000a196c1b5974a0b2a510de985219493e4ce3461030001c20000',
  'hex'
)

/** MPEG1 Layer-III 128kbps / 44.1kHz 的帧头 FF FB 90 00；可带 ID3v2 前缀 */
function mp3Head(total: number, id3BodyBytes = 0): Buffer {
  const b = Buffer.alloc(total, 0x42)
  if (id3BodyBytes > 0) {
    b.write('ID3', 0, 'latin1')
    b[3] = 0x04
    b[6] = (id3BodyBytes >> 21) & 0x7f
    b[7] = (id3BodyBytes >> 14) & 0x7f
    b[8] = (id3BodyBytes >> 7) & 0x7f
    b[9] = id3BodyBytes & 0x7f
  }
  const at = 10 + id3BodyBytes
  b[at] = 0xff
  b[at + 1] = 0xfb
  b[at + 2] = 0x90
  b[at + 3] = 0x00
  return b
}

function adtsFrame(frameLength = 139, sampleRateIndex = 4): Buffer {
  const b = Buffer.alloc(frameLength, 0)
  b[0] = 0xff
  b[1] = 0xf1
  b[2] = (2 << 6) | (sampleRateIndex << 2)
  b[3] = ((frameLength >> 11) & 0x03) << 6
  b[4] = (frameLength >> 3) & 0xff
  b[5] = (frameLength & 0x07) << 5
  if (frameLength >= 24) {
    b[20] = 0xff; b[21] = 0xfb; b[22] = 0x90; b[23] = 0x00
  }
  return b
}

function adtsHead(frames: number, frameLength = 139): Buffer {
  return Buffer.concat(Array.from({ length: frames }, () => adtsFrame(frameLength)))
}

/** mp4/m4a 头，并且在里面埋一个"看起来像 MP3 帧头"的四字节（用来验容器闸门） */
function mp4HeadWithFakeFrame(total: number): Buffer {
  const b = Buffer.alloc(total, 0x41)
  b.writeUInt32BE(0x18, 0)
  b.write('ftyp', 4, 'latin1')
  b.write('M4A ', 8, 'latin1')
  b[0x20] = 0xff
  b[0x21] = 0xfb
  b[0x22] = 0x90
  b[0x23] = 0x00
  return b
}

describe('estimateDurationFromHead 首块解时长', () => {
  it('真 flac 头 ⇒ 240.13s，与库内记账 240.0s 对齐', () => {
    const r = estimateDurationFromHead(FLAC_HEAD, 26_174_554, 'flac')
    expect(r.basis).toBe('flac')
    expect(r.sec!.toFixed(2)).toBe('240.13')
  })

  it('CBR 128k 的 mp3：960887B ⇒ 60.06s（正是 vkeys 那段罐头的实测字节）', () => {
    const r = estimateDurationFromHead(mp3Head(960_887), 960_887, 'mpeg-frame')
    expect(r.basis).toBe('cbr-mp3')
    expect(r.sec!.toFixed(2)).toBe('60.06')
  })

  it('整曲 mp3 4,078,961B ⇒ 254.94s，对期望 254s 不算短', () => {
    const r = estimateDurationFromHead(mp3Head(4_078_961), 4_078_961, 'mp3')
    expect(r.sec!.toFixed(2)).toBe('254.94')
    expect(isIncompleteTrial(r.sec!, 254)).toBe(false)
  })

  it('ID3v2 前缀要跳过：标签 10B + 帧头 ⇒ 仍解得出同一个 60.06s', () => {
    const total = 960_887
    const r = estimateDurationFromHead(mp3Head(total, 10), total, 'mp3')
    // 扣掉 20B 标签后折算，与不扣的 60.06 差在 0.01s 内
    expect(Math.abs(r.sec! - 60.06)).toBeLessThan(0.01)
  })

  it('ADTS AAC：551 个 139B 帧 ⇒ 12.79s，正是今晚广告载荷的形状', () => {
    const r = estimateDurationFromHead(adtsHead(551), 551 * 139, 'mpeg-frame')
    expect(r.basis).toBe('adts-aac')
    expect(r.sec!.toFixed(2)).toBe('12.79')
  })

  it('ADTS AAC 支持 ID3v2 前缀，帧不足 3 个时不下结论', () => {
    const prefix = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1')
    const head = Buffer.concat([prefix, adtsHead(20)])
    const r = estimateDurationFromHead(head, head.length, 'mp3')
    expect(r.basis).toBe('adts-aac')
    expect(Math.abs(r.sec! - (20 * 1024 / 44_100))).toBeLessThan(0.001)
    expect(estimateDurationFromHead(adtsHead(2), 2 * 139, 'mpeg-frame').sec).toBeNull()
  })

  it('容器闸门：mp4 里埋着伪帧头也不许当 mp3 解（否则乱码会造出假码率）', () => {
    const b = mp4HeadWithFakeFrame(100_000)
    expect(estimateDurationFromHead(b, 100_000, 'mp4').sec).toBeNull()
    // 同一份字节只要容器被认成 mp3 就确实能解出来 ⇒ 证明保护来自容器判定而非碰巧
    expect(estimateDurationFromHead(b, 100_000, 'mp3').sec).not.toBeNull()
  })

  it('头不够长 / 容器为空 ⇒ 一律解不出，交回兜底', () => {
    expect(estimateDurationFromHead(null, 1000, 'mp3').sec).toBeNull()
    expect(estimateDurationFromHead(Buffer.alloc(8, 0xff), 1000, 'mp3').sec).toBeNull()
    expect(estimateDurationFromHead(mp3Head(960_887), 960_887, null).sec).toBeNull()
  })
})

describe('judgePayloadLength 两条判据取或', () => {
  it('罐头：时长 60.06s 对期望 154s ⇒ 拒，依据 cbr-mp3', () => {
    const r = judgePayloadLength({
      head: mp3Head(960_887),
      sizeBytes: 960_887,
      minDeclaredBytes: minDeclaredBytes(['2.35M', '5.88M', '33.57M']),
      intervalSec: 154,
      container: 'mpeg-frame',
    })
    expect(r.reject).toBe(true)
    expect(r.basis).toContain('cbr-mp3')
  })

  it('ADTS AAC 广告：12.79s 对期望 350s、无声明大小 ⇒ 仍判死', () => {
    const r = judgePayloadLength({
      head: adtsHead(551),
      sizeBytes: 551 * 139,
      minDeclaredBytes: null,
      intervalSec: 350,
      container: 'mpeg-frame',
    })
    expect(r.reject).toBe(true)
    expect(r.basis).toBe('adts-aac')
  })

  it('合法整曲 AAC：按帧长折算 350s ⇒ 不误杀', () => {
    const frames = 20
    const frameLength = 139
    const expectedFrames = Math.round(350 * 44_100 / 1024)
    const r = judgePayloadLength({
      head: adtsHead(frames, frameLength),
      sizeBytes: expectedFrames * frameLength,
      minDeclaredBytes: null,
      intervalSec: 350,
      container: 'mpeg-frame',
    })
    expect(r.reject).toBe(false)
  })

  it('整曲低音质 m4a（比值 0.628、时长解不出）⇒ 两条都不许拒', () => {
    // 0.628 那个锚点来自真 m4a：AAC 码率约 80kbps，比声明的 128k 小得多但曲子是整曲。
    // 它恰好也验证了容器闸门的价值——若把 m4a 字节当 CBR mp3 硬解，会算出 160s 误杀。
    const r = judgePayloadLength({
      head: mp4HeadWithFakeFrame(2_559_929),
      sizeBytes: 2_559_929,
      minDeclaredBytes: minDeclaredBytes(['3.89M', '9.72M']),
      intervalSec: 254,
      container: 'mp4',
    })
    expect(r.reject).toBe(false)
    // 反证：同一份字节若被认成 mp3，就会被误杀 ⇒ 容器判定是这条判据的前提
    const wouldBeWrong = judgePayloadLength({
      head: mp3Head(2_559_929),
      sizeBytes: 2_559_929,
      minDeclaredBytes: minDeclaredBytes(['3.89M', '9.72M']),
      intervalSec: 254,
      container: 'mp3',
    })
    expect(wouldBeWrong.reject).toBe(true)
  })

  it('flac 截断：头里时长说 240s（对期望不短），但字节远不够 ⇒ 靠比值这一腿拒', () => {
    const r = judgePayloadLength({
      head: FLAC_HEAD,
      sizeBytes: 100_000,
      minDeclaredBytes: minDeclaredBytes(['2.35M', '5.88M', '33.57M']),
      intervalSec: 240,
      container: 'flac',
    })
    expect(estimateDurationFromHead(FLAC_HEAD, 100_000, 'flac').sec!.toFixed(0)).toBe('240')
    expect(r.reject).toBe(true)
    expect(r.basis).toBe('size-ratio')
  })

  it('预览半首（比值 0.60 > 0.5 漏网）⇒ 只有时长这一腿抓得到 ⇒ 取或是必要的', () => {
    // 200s 的歌给 120s 预览：CBR 128k 下 120s = 1,920,000B，对 128k 声明(3,200,000)
    // 的比值 0.60 ⇒ 兜底腿放过；时长腿算出 120s < 0.8×200=160s ⇒ 判死。
    const half = mp3Head(1_920_000)
    expect(isUndersizedByContentLength(1_920_000, Math.round(3.05 * 1024 ** 2), 200)).toBe(false)
    const r = judgePayloadLength({
      head: half,
      sizeBytes: 1_920_000,
      minDeclaredBytes: Math.round(3.05 * 1024 ** 2),
      intervalSec: 200,
      container: 'mp3',
    })
    expect(r.reject).toBe(true)
    expect(r.basis).toBe('cbr-mp3')
  })
  it('时长与比值同时不合格 ⇒ 依据里两条都写出来', () => {
    const r = judgePayloadLength({
      head: mp3Head(960_887),
      sizeBytes: 960_887,
      minDeclaredBytes: minDeclaredBytes(['4.03M', '10.08M', '27.53M']),
      intervalSec: 264,
      container: 'mp3',
    })
    expect(r.reject).toBe(true)
    expect(r.basis).toBe('cbr-mp3+size-ratio')
  })

  it('短曲（<120s）两条都不校验 ⇒ 一律放过', () => {
    for (const sec of [MIN_CHECK_INTERVAL_SEC - 1, 0, NaN]) {
      const r = judgePayloadLength({
        head: mp3Head(960_887),
        sizeBytes: 960_887,
        minDeclaredBytes: minDeclaredBytes(['2.35M', '5.88M', '33.57M']),
        intervalSec: sec,
        container: 'mp3',
      })
      expect(r.reject).toBe(false)
    }
  })

  it('无声明基准时只剩时长这一腿：解得出就判、解不出就放过', () => {
    const judged = judgePayloadLength({
      head: mp3Head(960_887),
      sizeBytes: 960_887,
      minDeclaredBytes: null,
      intervalSec: 200,
      container: 'mp3',
    })
    expect(judged.reject).toBe(true)
    const lenient = judgePayloadLength({
      head: mp4HeadWithFakeFrame(100_000),
      sizeBytes: 100_000,
      minDeclaredBytes: null,
      intervalSec: 200,
      container: 'mp4',
    })
    expect(lenient.reject).toBe(false)
  })
})

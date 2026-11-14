/**
 * lib/server/audio-sniff.ts 单元测试
 *
 * 覆盖三档判定的边界：
 * - 已知容器（含各家源的奇葩 Content-Type）→ audio
 * - HTML/JSON/文本错误页 / 图片 / 压缩包 → reject（换源重试的依据）
 * - 拿到足够字节却认不出任何已知容器 → reject（2026-11-14 改：实测这类是 QMC2 密文，
 *   ffmpeg 连容器都开不了，留在缓存里只会让播放器每次报 UNSUPPORTED_FORMAT）
 * - 一个字节都没拿到 / 首块短于 12 字节 → unverified（没有字节证据，交回调用方）
 *
 * 判据表必须「宁可放过不可误杀」：真实音源里 Content-Type 普遍不可信
 * （实测存在把 MP3 标成 `audio/mpeg; charset=UTF-8`、把 flac 标成
 * `application/octet-stream` 的情况），故以字节魔数为准。
 */

import { describe, it, expect } from 'vitest'
import {
  judgeUpstreamPayload,
  detectContainer,
  detectRejectBinary,
  isTextLike,
  classifyContentType,
  readHeadBytes,
  extFromContainer,
  mimeFromContainer,
  extFromAudioMime,
  mimeFromAudioExt,
} from '@/lib/server/audio-sniff'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

/** 用 latin1 构造头部字节（保留 0xff 等原始值） */
function head(s: string): Uint8Array {
  return Buffer.from(s, 'latin1')
}

/** 确定性伪随机字节（模拟高熵垃圾数据，如实测中的「别想她.mp3」） */
function garbage(n: number, seed = 7): Uint8Array {
  const buf = Buffer.alloc(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648
    buf[i] = s % 256
  }
  return buf
}

describe('detectContainer：已知媒体容器', () => {
  it.each([
    ['mp3 (ID3 头)', 'ID3\x03\x00\x00\x00\x00\x00\x00'],
    ['flac', 'fLaC\x00\x00\x00"'],
    ['ogg', 'OggS\x00\x02\x00\x00'],
    ['wav', 'RIFF\x24\x08\x00\x00WAVEfmt '],
    ['mp4/m4a', '\x00\x00\x00\x18ftypM4A '],
    ['aiff', 'FORM\x00\x00\x00\x00AIFF'],
    ['ape', 'MAC \x96\x0f'],
    ['wavpack', 'wvpk\x00\x00'],
    ['tta', 'TTA1\x00\x00'],
    ['amr', '#!AMR\n'],
    ['dsf', 'DSD \x00\x00'],
    ['asf/wma', '\x30\x26\xb2\x75'],
    ['realmedia', '.RMF\x00\x00'],
    ['au', '.snd\x00\x00'],
    ['caf', 'caff\x00\x01'],
    ['midi', 'MThd\x00\x00'],
    ['ac3', '\x0b\x77\x00\x00'],
    ['dts', '\x7f\xfe\x80\x01'],
  ])('识别 %s', (_label, magic) => {
    expect(detectContainer(head(magic))).not.toBeNull()
  })

  it('MPEG 帧同步字（无 ID3 头的裸 MP3 / ADTS AAC）→ mpeg-frame', () => {
    expect(detectContainer(head('\xff\xfb\x90\x00'))).toBe('mpeg-frame')
    expect(detectContainer(head('\xff\xf1\x50\x80'))).toBe('mpeg-frame') // ADTS AAC
  })

  it('保留版本位的帧同步字不算音频（0xFF 0xE1 等）', () => {
    // version bits = 01 是保留值
    expect(detectContainer(head('\xff\xe9\x00\x00'))).toBeNull()
  })

  it('未知容器返回 null', () => {
    expect(detectContainer(garbage(64))).toBeNull()
    expect(detectContainer(head('\x15W\n"N76Zq'))).toBeNull()
  })
})

describe('detectRejectBinary：明确非音频的二进制', () => {
  it.each([
    ['PNG', '\x89PNG\r\n\x1a\n'],
    ['JPEG', '\xff\xd8\xff\xe0'],
    ['GIF', 'GIF89a'],
    ['WebP', 'RIFF\x00\x00\x00\x00WEBPVP8 '],
    ['TIFF (LE)', 'II*\x00'],
    ['ZIP', 'PK\x03\x04'],
    ['gzip', '\x1f\x8b\x08\x00'],
    ['RAR', 'Rar!\x1a\x07'],
    ['7z', '7z\xbc\xaf\x27\x1c'],
    ['PDF', '%PDF-1.7'],
  ])('识别 %s', (_label, magic) => {
    expect(detectRejectBinary(head(magic))).not.toBeNull()
  })

  it('音频容器不会被误判为非音频二进制', () => {
    expect(detectRejectBinary(head('ID3\x03\x00'))).toBeNull()
    expect(detectRejectBinary(head('fLaC\x00\x00'))).toBeNull()
  })
})

describe('isTextLike：文本特征识别', () => {
  it('HTML 错误页（含前导空白与 BOM）判为文本', () => {
    expect(isTextLike(head('<!DOCTYPE html><html>'))).toBe(true)
    expect(isTextLike(head('\n  <html>'))).toBe(true)
    expect(isTextLike(head('\xef\xbb\xbf{"code":403}'))).toBe(true)
  })

  it('JSON / XML / 纯文本错误信息判为文本', () => {
    expect(isTextLike(head('{"code":403,"msg":"no permission"}'))).toBe(true)
    expect(isTextLike(head('<?xml version="1.0"?>'))).toBe(true)
    expect(isTextLike(head('请求被拒绝'))).toBe(true)
  })

  it('音频字节不判为文本', () => {
    expect(isTextLike(head('ID3\x03\x00\x00\x00'))).toBe(false)
    expect(isTextLike(head('\xff\xfb\x90\x00'))).toBe(false)
    expect(isTextLike(head('fLaC\x00\x00\x00"'))).toBe(false)
  })

  it('高熵垃圾数据：多数判为非文本（所以坏载荷靠"认不出容器"这条识破，不靠文本判据）', () => {
    // 用多个种子统计，确认「随机数据被误判为文本」的比例很低
    let textLike = 0
    for (let seed = 1; seed <= 200; seed++) {
      if (isTextLike(garbage(64, seed))) textLike++
    }
    // 期望 ~2%（无控制字符且全可打印）；给足余量，超过 10% 说明判据有问题
    expect(textLike).toBeLessThan(20)
  })
})

describe('judgeUpstreamPayload：三档判定', () => {
  it('字节是媒体容器 → audio（即使 Content-Type 缺失或乱标）', () => {
    for (const ct of [null, 'application/octet-stream', 'audio/mpeg; charset=UTF-8', 'text/plain']) {
      const v = judgeUpstreamPayload({ contentType: ct, head: head('ID3\x03\x00\x00\x00') })
      expect(v.verdict).toBe('audio')
      expect(v.container).toBe('mp3')
    }
  })

  /**
   * 容器魔数必须先于"整段可打印"的文本判据。写周测时被这条咬到：isPrintableRun 的
   * 注释声称"已知容器在调用前已排除"，但代码里 isTextLike 排在 detectContainer 前面，
   * 于是 'fLaC' + ASCII 填充的头 32 字节（全可打印）会被判成"文本假地址"。
   * 真实文件头部通常带 0x00 侥幸不触发，但证据强度上魔数明确高于"看起来像文本"。
   */
  it('头部全可打印的合法容器仍是 audio（魔数优先于文本判据）', () => {
    const v = judgeUpstreamPayload({ contentType: 'audio/flac', head: head('fLaC0000000000000000000000000000') })
    expect(v.verdict).toBe('audio')
    expect(v.container).toBe('flac')
    expect(judgeUpstreamPayload({ contentType: null, head: head('MAC 0000000000000000000000000000') }).container).toBe('ape')
  })

  it('HTML 错误页 → reject（即使 Content-Type 谎称 audio/mpeg）', () => {
    const v = judgeUpstreamPayload({
      contentType: 'audio/mpeg',
      head: head('<!DOCTYPE html><html><body>404</body></html>'),
    })
    expect(v.verdict).toBe('reject')
    expect(v.reason).toContain('文本')
  })

  it('JSON 提示（无版权/需要 VIP）→ reject', () => {
    const v = judgeUpstreamPayload({
      contentType: 'application/json',
      head: head('{"code":403,"msg":"需要VIP"}'),
    })
    expect(v.verdict).toBe('reject')
  })

  it('图片 → reject（封面误当音频）', () => {
    expect(judgeUpstreamPayload({ contentType: null, head: head('\x89PNG\r\n\x1a\n') }).verdict).toBe(
      'reject'
    )
    expect(judgeUpstreamPayload({ contentType: null, head: head('\xff\xd8\xff\xe0') }).verdict).toBe(
      'reject'
    )
  })

  it('字节无法判定但 Content-Type 是文本 → reject', () => {
    const v = judgeUpstreamPayload({ contentType: 'text/html; charset=utf-8', head: null })
    expect(v.verdict).toBe('reject')
  })

  it('高熵垃圾（实测的坏文件字节）→ reject，不再当罕见容器放过', () => {
    const v = judgeUpstreamPayload({ contentType: 'audio/mpeg', head: head('\x15W\n"N76ZqTHbxw') })
    expect(v.verdict).toBe('reject')
    expect(v.reason).toContain('字节未匹配已知容器')
  })

  /**
   * 2026-11-14 生产那 7 份的形状：QMC2 密文被声明成 audio/x-ogg。旧判据给 unverified
   * ⇒ 照样交付照样进缓存，此后每次命中原样重发、播放器每次报不支持；这里钉死它必须是 reject。
   */
  it('声明 audio/x-ogg 的 .mflac 密文头 → reject（生产实测字节）', () => {
    const mflacHead = Buffer.from('0b7f1212343444617e552734384a57587c2b648215c86e855afd5b9af0c73b0f', 'hex')
    const v = judgeUpstreamPayload({ contentType: 'audio/x-ogg', head: mflacHead })
    expect(v.verdict).toBe('reject')
    expect(v.container).toBeNull()
  })

  it('未知容器 + 非文本 Content-Type → 也是 reject（不再有"罕见容器"这一档余地）', () => {
    const v = judgeUpstreamPayload({ contentType: 'audio/x-ms-wma', head: garbage(64) })
    expect(v.verdict).toBe('reject')
  })

  // 首块不足 12 字节时不能下"认不出容器"的结论：那只是还没看清楚，
  // 判坏会把首块被切碎的合法文件冤枉掉（表里最长的判据要看到第 12 字节）。
  it('首块太短（不足 12 字节）→ unverified，不当坏载荷', () => {
    const v = judgeUpstreamPayload({ contentType: 'audio/flac', head: head('\x15W\n"') })
    expect(v.verdict).toBe('unverified')
  })

  // 但"看不清字节"不等于"放过"：声明本身就不是音频的一律维持 2026-10-10 那条拒绝判据。
  it('字节不足且声明是 octet-stream → 仍然 reject（声明侧的保护不撤）', () => {
    expect(
      judgeUpstreamPayload({ contentType: 'application/octet-stream', head: head('z52gdv4x\x00\x01\x02') }).verdict
    ).toBe('reject')
    expect(judgeUpstreamPayload({ contentType: 'application/octet-stream', head: null }).verdict).toBe('reject')
    // 声明缺失是裸响应/老数据，不能当坏证据
    expect(judgeUpstreamPayload({ contentType: null, head: null }).verdict).toBe('unverified')
  })

  it('无头部字节时仅凭 Content-Type 判定', () => {
    expect(judgeUpstreamPayload({ contentType: 'audio/flac', head: null }).verdict).toBe('unverified')
    expect(judgeUpstreamPayload({ contentType: null, head: null }).verdict).toBe('unverified')
    expect(judgeUpstreamPayload({ contentType: 'audio/mpeg', head: new Uint8Array(0) }).verdict).toBe(
      'unverified'
    )
  })

  it('只取前 64 字节参与判定（后面的内容不影响结论）', () => {
    const long = Buffer.concat([Buffer.from('ID3\x03\x00'), Buffer.alloc(4096, 0x41)])
    expect(judgeUpstreamPayload({ contentType: null, head: long }).verdict).toBe('audio')
  })

  it('contentType 归一化去掉参数', () => {
    const v = judgeUpstreamPayload({ contentType: 'Audio/MPEG; charset=UTF-8', head: null })
    expect(v.contentType).toBe('audio/mpeg')
  })
})

describe('classifyContentType', () => {
  it.each([
    ['audio/mpeg', 'audio'],
    ['audio/x-flac', 'audio'],
    ['AUDIO/MP3; charset=x', 'audio'],
    ['video/mp4', 'video'],
    ['text/html', 'text'],
    ['application/json', 'text'],
    ['application/problem+json', 'text'],
    ['application/xml', 'text'],
    ['application/octet-stream', 'other'],
    ['', 'other'],
    [null, 'other'],
  ])('%s → %s', (ct, kind) => {
    expect(classifyContentType(ct as string | null)).toBe(kind)
  })
})

describe('readHeadBytes', () => {
  it('读取文件头部；不存在的文件返回 null', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sniff-test-'))
    const p = path.join(dir, 'a.mp3')
    await fsp.writeFile(p, Buffer.concat([Buffer.from('ID3\x03\x00'), Buffer.alloc(1000, 1)]))
    const b = await readHeadBytes(p)
    expect(b).not.toBeNull()
    expect(Buffer.from(b!).subarray(0, 3).toString('latin1')).toBe('ID3')
    expect(b!.length).toBe(64)

    expect(await readHeadBytes(path.join(dir, 'missing.mp3'))).toBeNull()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('空文件返回 null', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sniff-test-'))
    const p = path.join(dir, 'empty.mp3')
    await fsp.writeFile(p, Buffer.alloc(0))
    expect(await readHeadBytes(p)).toBeNull()
    await fsp.rm(dir, { recursive: true, force: true })
  })
})

describe('容器 → MIME / 扩展名（字节证据纠正谎报的 Content-Type）', () => {
  it('常见音频容器各自给出 MIME 与扩展名', () => {
    expect(mimeFromContainer('flac')).toBe('audio/flac')
    expect(extFromContainer('flac')).toBe('.flac')
    expect(mimeFromContainer('mp3')).toBe('audio/mpeg')
    expect(mimeFromContainer('mpeg-frame')).toBe('audio/mpeg')
    expect(extFromContainer('wavpack')).toBe('.wv')
  })

  it('视频可承载的容器不参与覆盖（源会把 MV 当音频链路返回）', () => {
    for (const c of ['mp4', 'asf', 'avi', 'realmedia', 'midi']) {
      expect(mimeFromContainer(c)).toBeNull()
      expect(extFromContainer(c)).toBeNull()
    }
  })

  it('未知容器 / null / 空串 → 一律 null，由调用方回落上游声明', () => {
    expect(mimeFromContainer('nope')).toBeNull()
    expect(extFromContainer(null)).toBeNull()
    expect(extFromContainer(undefined)).toBeNull()
    expect(mimeFromContainer('')).toBeNull()
  })

  it('MIME ↔ 扩展名与容器表同源（audio-serve 与 music-library 各自的一跳不再各说各话）', () => {
    expect(extFromAudioMime('audio/x-dsf')).toBe('.dsf')
    expect(extFromAudioMime('audio/ape')).toBe('.ape')
    expect(mimeFromAudioExt('.tta')).toBe('audio/x-tta')
    expect(mimeFromAudioExt('.FLAC')).toBe('audio/flac') // 大小写归一
    expect(extFromAudioMime('audio/mpeg')).toBe('.mp3') // 与 mp3 的表内值一致
    expect(extFromAudioMime(null)).toBeNull()
    expect(mimeFromAudioExt('.exe')).toBeNull()
  })
})

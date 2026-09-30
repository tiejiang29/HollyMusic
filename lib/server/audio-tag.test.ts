/**
 * FLAC 标签读写的回归测试。
 *
 * 两条主线：① 结构正确性（块链、last-flag、长度自洽、不改动输入缓冲）；
 * ② 写出来的东西**别的解析器认**——用第三方 music-metadata 回读断言，不自证。
 * ②里"真实文件"那组在 CI 上会跳过（data/ 是 gitignored），但合成用例刻意复刻了
 * 生产实测到的两种真实块序：[0,1,3,4]（带 seektable）与 [0,1,4]。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseBuffer } from 'music-metadata'
import {
  readFlacChain, rewriteFlacHead, buildFlacCommentBlock, buildFlacPictureBlock, parseFlacCommentBlock,
  BLOCK_STREAMINFO, BLOCK_PADDING, BLOCK_SEEKTABLE, BLOCK_VORBIS_COMMENT, BLOCK_CUESHEET, BLOCK_PICTURE,
  readMp3Layout, buildId3v2Tag, ID3V1_BYTES,
  type FlacChain,
} from './audio-tag'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...'mock-jpeg'.split('').map(c => c.charCodeAt(0)), 0xff, 0xd9])

/** 造一个块：type + 任意体，last 由调用方指定 */
const blk = (type: number, len: number, fill = 0x11, last = false) => {
  const body = Buffer.alloc(len, fill)
  const head = Buffer.alloc(4)
  head[0] = (last ? 0x80 : 0) | type
  head[1] = (len >> 16) & 0xff
  head[2] = (len >> 8) & 0xff
  head[3] = len & 0xff
  return Buffer.concat([head, body])
}
/** 按给定的真实形状拼一个链头 + 一段"音频帧" */
function makeFile(kinds: Array<{ type: number; len: number }>, audioFill = 0xcd) {
  const pieces = [Buffer.from('fLaC', 'latin1')]
  kinds.forEach((k, i) => pieces.push(blk(k.type, k.len, 0x20 + i, i === kinds.length - 1)))
  const chain = Buffer.concat(pieces)
  return Buffer.concat([chain, Buffer.alloc(2048, audioFill)])
}

describe('readFlacChain', () => {
  it('生产实测形状 [0,1,3,4]：能定位音频起点，并把 padding/seektable/comment 计为待丢字节', () => {
    const f = makeFile([
      { type: BLOCK_STREAMINFO, len: 34 },
      { type: BLOCK_PADDING, len: 1000 },
      { type: BLOCK_SEEKTABLE, len: 200 },
      { type: BLOCK_VORBIS_COMMENT, len: 300 },
    ])
    const chain = readFlacChain(f)
    expect(chain.ok).toBe(true)
    const c = chain as FlacChain
    expect(c.audioStart).toBe(4 + (4 + 34) + (4 + 1000) + (4 + 200) + (4 + 300))
    expect(c.droppedBytes).toBe((4 + 1000) + (4 + 200) + (4 + 300))
    expect(c.blocks.map(b => b.type)).toEqual([0, 1, 3, 4])
    // streamInfo 是"块头 + 34 字节体"，块头首字节的低 7 位才是类型
    expect(c.streamInfo.length).toBe(4 + 34)
    expect(c.streamInfo[0] & 0x7f).toBe(BLOCK_STREAMINFO)
  })

  it('坏输入一律 ok:false，绝不返回半截结论', () => {
    const cases: Array<[string, Buffer]> = [
      ['魔数不对', Buffer.concat([Buffer.from('RIFFxx'), Buffer.alloc(64)])],
      ['首块不是 STREAMINFO', Buffer.concat([Buffer.from('fLaC', 'latin1'), blk(BLOCK_PADDING, 10, 0x11, true)])],
      ['STREAMINFO 长度不是 34', Buffer.concat([Buffer.from('fLaC', 'latin1'), blk(BLOCK_STREAMINFO, 33, 0x5a, true)])],
      ['块越出缓冲', Buffer.concat([Buffer.from('fLaC', 'latin1'), blk(BLOCK_STREAMINFO, 34), Buffer.from([0x04, 0x00, 0xff, 0xff])])],
      ['读完也没结束标志', Buffer.concat([Buffer.from('fLaC', 'latin1'), blk(BLOCK_STREAMINFO, 34, 0x5a, false), blk(BLOCK_PADDING, 8, 0x22, false)])],
    ]
    for (const [name, buf] of cases) {
      const r = readFlacChain(buf)
      expect(r.ok, name).toBe(false)
      if (!r.ok) expect(r.reason, name).toBeTruthy()
    }
  })

  it('STREAMINFO 出现在非首位（病态文件）也判不可改写', () => {
    const f = Buffer.concat([
      Buffer.from('fLaC', 'latin1'),
      blk(BLOCK_STREAMINFO, 34, 0x5a, false),
      blk(BLOCK_PADDING, 16, 0x22, false),
      blk(BLOCK_STREAMINFO, 34, 0x5a, true),
    ])
    // 第二块是流内重复的 STREAMINFO，位置不合法 → 必须拒绝
    const r = readFlacChain(f)
    expect(r.ok).toBe(false)
  })
})

describe('rewriteFlacHead', () => {
  const fields = {
    TITLE: '晴天', ARTIST: '周杰伦', ALBUM: '叶惠美', DATE: '2003', TRACKNUMBER: '5',
    LYRICS: '[00:00.00]歌词第一行\n[00:01.00]第二行 中文',
  }

  it('丢掉旧注释/封面/padding/seektable/cuesheet，只留 STREAMINFO + 新块 + 其它原块', () => {
    const f = makeFile([
      { type: BLOCK_STREAMINFO, len: 34 },
      { type: BLOCK_PADDING, len: 500 },
      { type: BLOCK_SEEKTABLE, len: 128 },
      { type: BLOCK_VORBIS_COMMENT, len: 200 },
      { type: BLOCK_CUESHEET, len: 300 },
      { type: BLOCK_PICTURE, len: 400 },
      { type: 2 /* APPLICATION */, len: 20 },
    ])
    const before = Buffer.from(f)
    // 链总长 = 4 + (4+34)+(4+500)+(4+128)+(4+200)+(4+300)+(4+400)+(4+20) = 1614，必须整读到 last-flag
    const r = rewriteFlacHead(f.subarray(0, 1614), fields, { mime: 'image/jpeg', data: JPEG })
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const chain = readFlacChain(r.newHead)
    expect(chain.ok).toBe(true)
    const types = (chain as FlacChain).blocks.map(b => b.type)
    expect(types).toEqual([BLOCK_STREAMINFO, BLOCK_VORBIS_COMMENT, BLOCK_PICTURE, 2])
    expect(r.newHead.subarray(0, 4).toString('latin1')).toBe('fLaC')
    expect(r.delta).toBe(r.newHead.length - r.audioStart)
    /** 绝不改动调用方的缓冲（改写只发生在交付流里） */
    expect(Buffer.compare(before, f)).toBe(0)
  })

  it('last-flag 只在最后一块上置位', () => {
    const f = makeFile([{ type: BLOCK_STREAMINFO, len: 34 }, { type: BLOCK_VORBIS_COMMENT, len: 100 }])
    const r = rewriteFlacHead(f.subarray(0, 400), fields)
    if (!r.ok) throw new Error('不该失败')
    const chain = readFlacChain(r.newHead) as FlacChain
    chain.blocks.forEach((b, i) => expect(b.last, `块 ${i}`).toBe(i === chain.blocks.length - 1))
  })

  it('中文与换行在注释里原样往返（UTF-8，不是 latin1）', () => {
    const f = makeFile([{ type: BLOCK_STREAMINFO, len: 34 }])
    const r = rewriteFlacHead(f.subarray(0, 64), fields)
    if (!r.ok) throw new Error('不该失败')
    const chain = readFlacChain(r.newHead) as FlacChain
    const comment = chain.blocks.find(b => b.type === BLOCK_VORBIS_COMMENT)!
    const parsed = parseFlacCommentBlock(r.newHead.subarray(comment.offset))
    expect(parsed.TITLE).toBe('晴天')
    expect(parsed.ARTIST).toBe('周杰伦')
    expect(parsed.LYRICS).toContain('第二行 中文')
    expect(parsed.LYRICS).toContain('\n')
  })

  it('空值字段不写进去（少一项比写个空串好）', () => {
    const block = buildFlacCommentBlock({ TITLE: '有值', ARTIST: '   ', ALBUM: null, DATE: undefined })
    expect(Object.keys(parseFlacCommentBlock(block))).toEqual(['TITLE'])
  })

  it('封面 mime 非法就只丢封面，不带走整次改写', () => {
    const f = makeFile([{ type: BLOCK_STREAMINFO, len: 34 }])
    const r = rewriteFlacHead(f.subarray(0, 64), fields, { mime: 'text/html', data: JPEG })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const chain = readFlacChain(r.newHead) as FlacChain
    expect(chain.blocks.some(b => b.type === BLOCK_PICTURE)).toBe(false)
    expect(chain.blocks.some(b => b.type === BLOCK_VORBIS_COMMENT)).toBe(true)
  })

  it('PICTURE 块头结构：type=3 前置封面、mime 与数据长度都对得上', () => {
    const b = buildFlacPictureBlock('image/jpeg', JPEG)
    expect(b[0] & 0x7f).toBe(BLOCK_PICTURE)
    const body = b.subarray(4)
    expect(body.readUInt32BE(0)).toBe(3)
    const mimeLen = body.readUInt32BE(4)
    expect(body.subarray(8, 8 + mimeLen).toString('utf8')).toBe('image/jpeg')
    const descLenAt = 8 + mimeLen
    const descLen = body.readUInt32BE(descLenAt)
    const dataLenAt = descLenAt + 4 + descLen + 16
    expect(body.readUInt32BE(dataLenAt)).toBe(JPEG.length)
    expect(body.subarray(dataLenAt + 4, dataLenAt + 4 + JPEG.length)).toEqual(JPEG)
  })
})

/**
 * 外部解析器回读。真实文件在 CI 上不存在（data/ 被 gitignore），跳过时明确打印原因，
 * 好让"这条到底验没验"在日志里看得见，而不是静默通过。
 */
describe('用 music-metadata 回读改写结果（不自证）', () => {
  const LIB_DIR = path.resolve(process.cwd(), 'data/library')
  const hasReal = fs.existsSync(LIB_DIR)

  it('合成文件：改写后第三方解析器能读出标题/歌手/专辑/封面/歌词', async () => {
    const f = makeFile([{ type: BLOCK_STREAMINFO, len: 34 }, { type: BLOCK_PADDING, len: 200 }])
    const r = rewriteFlacHead(f.subarray(0, 300), {
      TITLE: '海阔天空', ARTIST: 'BEYOND', ALBUM: '继续革命', DATE: '1997',
      LYRICS: '[00:01.00]今天我 寒夜看雪',
    }, { mime: 'image/jpeg', data: JPEG })
    if (!r.ok) throw new Error(r.reason)
    const out = Buffer.concat([r.newHead, f.subarray(r.audioStart)])
    const md = await parseBuffer(out, { duration: false, skipCovers: false })
    expect(md.common.title).toBe('海阔天空')
    expect(md.common.artist).toBe('BEYOND')
    expect(md.common.album).toBe('继续革命')
    expect((md.common.picture || []).length).toBe(1)
    expect(md.common.picture![0].format).toBe('image/jpeg')   // music-metadata 这里给的是 mime，不是简写
    const lyricsKey = Object.values(md.native).flat().find((t: { id?: string }) => String(t.id || '').toUpperCase() === 'LYRICS')
    expect(JSON.stringify(lyricsKey)).toContain('今天我')
  })

  it.skipIf(!hasReal)('真实库内正本：链头可解析，改写后第三方仍能读出正确标题', async () => {
    const files = fs.readdirSync(LIB_DIR, { recursive: true })
      .map(p => path.join(LIB_DIR, String(p)))
      .filter(p => p.toLowerCase().endsWith('.flac') && fs.statSync(p).isFile())
      .slice(0, 5)
    expect(files.length, '本地库里应该有 flac 样本').toBeGreaterThan(0)

    for (const p of files) {
      const fd = fs.openSync(p, 'r')
      try {
        const head = Buffer.alloc(512 * 1024)
        const got = fs.readSync(fd, head, 0, head.length, 0)
        const chain = readFlacChain(head.subarray(0, got))
        if (!chain.ok) throw new Error(`${path.basename(p)} 链头解析失败: ${chain.reason}`)
        const r = rewriteFlacHead(head.subarray(0, chain.audioStart), { TITLE: path.basename(p), ARTIST: '测试歌手' })
        if (!r.ok) throw new Error(r.reason)
        // 只取链后前 2MB 就够解析器认头（真实文件几十 MB，测试不该整读）
        const tail = Buffer.alloc(2 * 1024 * 1024)
        const t = fs.readSync(fd, tail, 0, tail.length, chain.audioStart)
        const out = Buffer.concat([r.newHead, tail.subarray(0, t)])
        const md = await parseBuffer(out, { duration: false, skipCovers: true })
        expect(md.common.title, path.basename(p)).toBe(path.basename(p))
        expect(md.common.artist, path.basename(p)).toBe('测试歌手')
      } finally {
        fs.closeSync(fd)
      }
    }
  })
})

// ===========================================================================
// MP3 / ID3v2
// ===========================================================================

/** MPEG1 Layer3 · 128kbps · 44.1kHz ⇒ 帧长 417B，头 FF FB 90 00（真实上游 mp3 的形状） */
const MPEG_FRAME_LEN = 417
function mpegFrames(n: number): Buffer {
  const one = Buffer.alloc(MPEG_FRAME_LEN, 0x10)
  one[0] = 0xff; one[1] = 0xfb; one[2] = 0x90; one[3] = 0x00
  return Buffer.concat(Array.from({ length: n }, () => Buffer.from(one)))
}
const id3Frame = (id: string, body: Buffer): Buffer => {
  const h = Buffer.alloc(10)
  h.write(id, 0, 4, 'latin1')
  h.writeUInt32BE(body.length, 4)          // v2.3 帧长度是普通大端，**不是** synchsafe
  return Buffer.concat([h, body])
}
/** 手工拼一个"上游那种空壳 ID3v2.3"：只有机器字段 TLEN/TSSE，没有人类可读键 */
function legacyId3v2(): Buffer {
  const frames = Buffer.concat([
    id3Frame('TLEN', Buffer.concat([Buffer.from([0]), Buffer.from('269', 'latin1')])),
    id3Frame('TSSE', Buffer.concat([Buffer.from([0]), Buffer.from('Lavf58.76.100', 'latin1')])),
  ])
  const size = Buffer.alloc(4)
  size[0] = (frames.length >>> 21) & 0x7f
  size[1] = (frames.length >>> 14) & 0x7f
  size[2] = (frames.length >>> 7) & 0x7f
  size[3] = frames.length & 0x7f
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), size, frames])
}
/** 定长 30 字节的 latin1 字段 */
const v1Field = (s: string): Buffer => {
  const b = Buffer.alloc(30, 0x20)
  b.write(s.slice(0, 30), 'latin1')
  return b
}
function id3v1Block(name = 'Dao Xiang', artist = 'Jay Chou', album = 'Mo Jie Zuo'): Buffer {
  // TAG(3) + title(30) + artist(30) + album(30) + year(4) + comment(30) + genre(1) = 128
  // comment 末两字节 0x00,track ⇒ v1.1 的音轨号约定
  return Buffer.concat([Buffer.from('TAG', 'latin1'), v1Field(name), v1Field(artist), v1Field(album),
    Buffer.from('2008', 'latin1'), Buffer.alloc(28, 0x20), Buffer.from([0x00, 0x01]), Buffer.from([0xff])])
}

describe('readMp3Layout', () => {
  it('上游真实形态（空壳 ID3v2.3 + 裸帧 + 尾部 ID3v1）：起点落在第一帧，尾部识别出 128B', () => {
    const head = legacyId3v2()
    const file = Buffer.concat([head, mpegFrames(6), id3v1Block()])
    const r = readMp3Layout(file.subarray(0, 64 * 1024), file.subarray(file.length - 512))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.audioStart).toBe(head.length)          // 旧头部整段被替换
    expect(r.tailTrim).toBe(ID3V1_BYTES)
    expect(r.id3v2Version).toBe(3)
  })

  it('没有任何头部的裸帧 mp3：audioStart=0（照样能加标签）', () => {
    const file = Buffer.concat([mpegFrames(4), id3v1Block()])
    const r = readMp3Layout(file, file.subarray(file.length - 512))
    expect(r.ok && r.audioStart).toBe(0)
    expect(r.ok && r.tailTrim).toBe(ID3V1_BYTES)
  })

  it('ID3v2 声明的长度超出已读窗口 ⇒ 拒绝（长度算不准就不能改写）', () => {
    const head = Buffer.alloc(64 * 1024, 0)                 // 故意小于声明尺寸
    const declared = 600 * 1024
    head.write('ID3', 0, 'latin1')
    head[3] = 3
    head[6] = (declared >>> 21) & 0x7f
    head[7] = (declared >>> 14) & 0x7f
    head[8] = (declared >>> 7) & 0x7f
    head[9] = declared & 0x7f
    const r = readMp3Layout(head, Buffer.alloc(128))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('超出已读窗口')
  })

  it('尾部有 APEv2 ⇒ 拒绝改写（它按绝对偏移索引，换头部会全错）', () => {
    const file = Buffer.concat([mpegFrames(4), Buffer.alloc(24, 0), Buffer.from('APETAGEX', 'latin1'), Buffer.alloc(24, 0)])
    const r = readMp3Layout(file, file.subarray(file.length - 512))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('APEv2')
  })

  it('扩展名是 .mp3 但内容其实是 FLAC/MP4 ⇒ 拒绝（不能凭扩展名改写）', () => {
    const flacish = Buffer.concat([Buffer.from('fLaC', 'latin1'), Buffer.alloc(2048)])
    const rf = readMp3Layout(flacish, Buffer.alloc(128))
    expect(rf.ok).toBe(false)
    if (!rf.ok) expect(rf.reason).toContain('FLAC')
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftyp', 'latin1'), Buffer.alloc(2048)])
    const r = readMp3Layout(mp4, Buffer.alloc(128))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('MP4')
  })

  it('随机字节里没有连续两帧 ⇒ 拒绝（帧同步校验不能省）', () => {
    const noise = Buffer.alloc(64 * 1024)
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 37 + 11) & 0xff
    const r = readMp3Layout(noise, Buffer.alloc(128))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('连续两帧')
  })

  it('音频尾块恰好以 "TAG" 开头也不裁（靠三字段可打印性把关，避免吃掉 128B 音频）', () => {
    const fake = Buffer.concat([Buffer.from('TAG', 'latin1'), Buffer.from(Array.from({ length: 125 }, (_, i) => (i * 89 + 130) & 0xff))])
    const file = Buffer.concat([mpegFrames(4), fake])
    const r = readMp3Layout(file, file.subarray(file.length - 512))
    expect(r.ok && r.tailTrim).toBe(0)
  })

  it('GBK 中文的 ID3v1 不会被认出来 ⇒ 保留原样（这是保守边界，不是回归：留旧尾部=今天的行为）', () => {
    const gbkName = Buffer.from([0xd6, 0xdc, 0xbd, 0xe0, 0xc2, 0xdb])   // 「周杰伦」GBK
    const field = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc(30 - b.length, 0)])
    const gbk = Buffer.concat([
      Buffer.from('TAG', 'latin1'),
      field(gbkName), field(gbkName), field(gbkName),
      Buffer.from('2008', 'latin1'), Buffer.alloc(30, 0), Buffer.from([0xff]),
    ])
    expect(gbk.length).toBe(ID3V1_BYTES)
    const file = Buffer.concat([mpegFrames(4), gbk])
    const r = readMp3Layout(file, file.subarray(file.length - 512))
    expect(r.ok && r.tailTrim).toBe(0)
  })
})

describe('buildId3v2Tag：写出来的标签要被第三方解析器认', () => {
  const FIELDS = { TITLE: '稻香', ARTIST: '周杰伦', ALBUM: '魔杰座', LYRICS: '[00:00.00]稻香\n[00:05.00]词：周杰伦' }

  it('music-metadata 读得到中文与封面；头部长度是 synchsafe 而帧长度不是', async () => {
    const built = buildId3v2Tag(FIELDS, { mime: 'image/jpeg', data: JPEG })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.frames).toEqual(['TIT2', 'TPE1', 'TALB', 'APIC', 'USLT'])

    const synchsafe = ((built.tag[6] & 0x7f) << 21) | ((built.tag[7] & 0x7f) << 14) | ((built.tag[8] & 0x7f) << 7) | (built.tag[9] & 0x7f)
    expect(synchsafe).toBe(built.tag.length - 10)          // 标签头：synchsafe
    // 第一个帧：ID 在偏移 10，长度字段在 14（v2.3 用普通大端，这两处极易搞混）
    expect(built.tag.subarray(10, 14).toString('latin1')).toBe('TIT2')
    expect(built.tag.subarray(14, 18).readUInt32BE(0)).toBeLessThanOrEqual(synchsafe)

    const out = Buffer.concat([built.tag, mpegFrames(8)])
    const md = await parseBuffer(out, { duration: false, skipCovers: false })
    expect(md.common.title).toBe('稻香')
    expect(md.common.artist).toBe('周杰伦')
    expect(md.common.album).toBe('魔杰座')
    expect((md.common.picture || []).length).toBe(1)
    expect(md.common.picture![0].format).toBe('image/jpeg')
    expect(md.native['ID3v2.3']?.find(f => f.id === 'USLT')).toBeDefined()
  })

  it('空字段一个帧都不写；坏 mime 直接拒绝而不是写坏封面', () => {
    const empty = buildId3v2Tag({ TITLE: '  ', ARTIST: null, ALBUM: undefined })
    expect(empty.ok && empty.frames).toEqual([])
    expect(empty.ok && empty.tag.length).toBe(10)
    const bad = buildId3v2Tag({ TITLE: 'x' }, { mime: 'application/pdf', data: JPEG })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toContain('mime')
  })
})

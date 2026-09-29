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

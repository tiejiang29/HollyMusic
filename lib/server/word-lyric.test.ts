/**
 * 逐字归一化的回归测试。
 *
 * 两层：
 * ① 合成样本（常驻）—— 只保证"格式忠实"，即字节/文本结构与上游一致，不含真歌词；
 * ② 真机样本（可选）—— 读 gitignored 的 my/word-lyric-captured.json（由 my/capture-word-lyric.mjs
 *    抓取），验证解析对上游真实数据成立。②在本机没有该文件时跳过，**不要**据此当作实测通过。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  parseKrc, parseMrc, decodeKrcPayload, screenWordLyric, toEnhancedLrc, toPlainLrc,
  type WordLyric,
} from './word-lyric'

const KRC_XOR_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105]

/** 造一份线上字节形态一致的 KRC 载荷：4 字节前缀 + XOR(16 字节表) + deflate */
function encodeKrcPayload(text: string): string {
  const deflated = Uint8Array.from(zlib.deflateSync(Buffer.from(text, 'utf8')), (byte, index) => byte ^ KRC_XOR_KEY[index % KRC_XOR_KEY.length])
  return Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.from(deflated)]).toString('base64')
}

// 结构照抄实测的酷狗 KRC：头标签 + [行起,行时长] + <字相起,字时长,0>字
const KRC_TEXT = [
  '[ti:合成曲]',
  '[ar:测试者]',
  '[hash:0123456789ABCDEF0123456789ABCDEF]',
  '[al:合成专辑]',
  '[total:200000]',
  '[offset:0]',
  '[25,190]<0,0,0>标<0,37,0>题<37,51,0>行',
  '[1000,3000]<0,1000,0>第一<1000,1000,0>个字<2000,1000,0>开始',
  '[5000,4000]<0,500,0>光<500,500,0>落<1000,1000,0>在<2000,2000,0>地板',
  '[10000,3000]<0,1500,0>窗<1500,1500,0>外<3000,0,0>有风',
  '[14000,3000]<0,1000,0>一<1000,1000,0>二<2000,1000,0>三<3000,0,0>四',
  '[18000,3000]<0,1000,0>五<1000,1000,0>六<2000,1000,0>七<3000,0,0>八',
  '[22000,3000]<0,1000,0>九<1000,1000,0>十<2000,1000,0>十一<3000,0,0>二',
  '[26000,3000]<0,1000,0>春<1000,1000,0>风<2000,1000,0>吹<3000,0,0>过',
  '[30000,3000]<0,1000,0>十<1000,1000,0>三<2000,1000,0>四<3000,0,0>五',
].join('\n')

// 结构照抄实测的咪咕 MRC：字时间在 [ ] 之后且在括号前，绝对毫秒，credit 行是 [0,0]
const MRC_TEXT = [
  '[ti:合成曲]',
  '[ar:测试者]',
  '[0,0]标(0,0)题(0,0)行 (0,0) - (0,0)测试者(0,0)',
  '[0,0]作(0,0)词：(0,0)张三(0,0)',
  '[1000,3000]第(1000,1000)一(2000,1000)行(3000,1000)',
  '[5000,4000]光(5000,500)落(5500,500)在(6000,1000)地(7000,1000)板(8000,1000)',
  '[10000,3000]窗(10000,1500)外(11500,1500)',
  '[14000,3000]一(14000,1000)二(15000,1000)三(16000,1000)四(17000,1000)',
  '[18000,3000]五(18000,1000)六(19000,1000)七(20000,1000)八(21000,1000)',
  '[22000,3000]九(22000,1000)十(23000,1000)十(24000,1000)一(25000,1000)',
  '[26000,3000]春(26000,1000)风(27000,1000)吹(28000,1000)过(29000,1000)',
  '[30000,3000]十(30000,1000)三(31000,1000)四(32000,1000)五(33000,1000)',
].join('\n')

describe('decodeKrcPayload', () => {
  it('线上字节形态（跳 4 字节 + XOR + deflate）能还原', () => {
    expect(decodeKrcPayload(encodeKrcPayload(KRC_TEXT))).toBe(KRC_TEXT)
  })

  it('非 base64 / 太短 / 解压出来不是 KRC 都返回 null 而不是抛', () => {
    for (const bad of ['', '!!not-base64!!', Buffer.from([1, 2]).toString('base64'), Buffer.from([0, 0, 0, 0, 1, 2, 3, 4]).toString('base64')]) {
      expect(decodeKrcPayload(bad), bad).toBeNull()
    }
  })

  it('解压成功但没有时间行也判为不可用', () => {
    expect(decodeKrcPayload(encodeKrcPayload('[ti:只有头]'))).toBeNull()
  })
})

describe('parseKrc：行内相对时间 → 绝对时间', () => {
  const lyric = parseKrc(KRC_TEXT)!

  it('头标签收进 headers（键小写）', () => {
    expect(lyric.headers.ti).toBe('合成曲')
    expect(lyric.headers.hash).toBe('0123456789ABCDEF0123456789ABCDEF')
  })

  it('第一个字的时间 = 行时间，不是行内 0', () => {
    const line = lyric.lines[1]
    expect(line.start).toBe(1000)
    expect(line.words[0]).toMatchObject({ start: 1000, end: 2000, text: '第一' })
  })

  it('相邻字满足「下一字 start == 上一字 start+时长」且末字不越过行尾', () => {
    for (const line of lyric.lines) {
      for (let i = 1; i < line.words.length; i++) {
        expect(line.words[i].start).toBeGreaterThanOrEqual(line.words[i - 1].start)
      }
      const last = line.words[line.words.length - 1]
      expect(last.end).toBeLessThanOrEqual(line.end)
    }
  })

  it('文本按标签位置切片，不依赖第三字段（实测恒 0）', () => {
    expect(lyric.lines[1].words.map(w => w.text).join('')).toBe('第一个字开始')
  })

  it('零宽标签（纯时间戳）不产出字', () => {
    const withZeroWidth = parseKrc('[0,5000]<0,0,0>abc<5000,0,0>')!
    expect(withZeroWidth.lines[0].words.map(w => w.text)).toEqual(['abc'])
  })

  it('BOM 与 CRLF 不影响解析', () => {
    const bomged = parseKrc('﻿' + KRC_TEXT.replace(/\n/g, '\r\n'))!
    expect(bomged.lines.length).toBe(lyric.lines.length)
    expect(bomged.lines[1].words[0].text).toBe('第一')
  })

  it('没有任何时间行时返回 null', () => {
    expect(parseKrc('[ti:x]\n[ar:y]\n纯文本')).toBeNull()
  })
})

describe('parseMrc：绝对时间 + 标签在文本之后', () => {
  const lyric = parseMrc(MRC_TEXT)!

  it('丢弃 [0,0] 的标题/作词/作曲行', () => {
    expect(lyric.lines).toHaveLength(8)
    expect(lyric.lines.flatMap(l => l.words.map(w => w.text)).join('')).not.toContain('作词')
  })

  it('字时间取括号内的绝对毫秒，文本在括号前', () => {
    const line = lyric.lines.find(l => l.start === 5000)!
    expect(line.words.slice(0, 3).map(w => [w.start, w.end, w.text])).toEqual([
      [5000, 5500, '光'],
      [5500, 6000, '落'],
      [6000, 7000, '在'],
    ])
  })

  it('多字块保持上游粒度，不强拆成单字', () => {
    const credits = parseMrc('[1000,2000]作(1000,500)词：张三(1500,1500)')!
    expect(credits.lines[0].words.map(w => w.text)).toEqual(['作', '词：张三'])
  })

  it('括号不会被当成正文（正则吃掉整对括号）', () => {
    for (const line of lyric.lines) {
      for (const word of line.words) expect(word.text).not.toMatch(/[()]/)
    }
  })

  it('全是 [0,0] 行时返回 null', () => {
    expect(parseMrc('[ti:x]\n[0,0]占(0,0)位(0,0)')).toBeNull()
  })
})

describe('screenWordLyric：每条拒因都可归因', () => {
  const good = parseKrc(KRC_TEXT)!

  it('正常逐字通过', () => {
    expect(screenWordLyric(good, { durationSeconds: 40, expectedFileHash: '0123456789abcdef0123456789ABCDEF' })).toEqual({ ok: true, lineCount: 9 })
  })

  it('行数不足（实测酷狗对错的歌返回 1 行「纯音乐，请欣赏」）', () => {
    const few = parseKrc('[1589,320317]<0,354,0>纯<354,300,0>音<654,300,0>乐<954,300,0>，<1254,300,0>请<1554,300,0>欣<1854,300,0>赏')!
    expect(screenWordLyric(few, {})).toMatchObject({ ok: false, reason: expect.stringContaining('有效行数') })
  })

  it('整行只有一个时间戳＝不是逐字', () => {
    const lineLevel = parseKrc([
      '[1000,3000]一', '[2000,3000]二', '[3000,3000]三', '[4000,3000]四',
      '[5000,3000]五', '[6000,3000]六', '[7000,3000]七', '[8000,3000]八',
    ].map(l => `${l}<0,1000,0>`).join('\n'))!
    expect(screenWordLyric(lineLevel, {})).toMatchObject({ ok: false, reason: expect.stringContaining('不是逐字') })
  })

  it('KRC 内 [hash:] 与请求 FileHash 不符则拒；字段缺失不否决（实测 14 条里 10 条没有）', () => {
    expect(screenWordLyric(good, { expectedFileHash: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('≠ 请求 FileHash') })
    const noHash = { ...good, headers: { ti: good.headers.ti } }
    expect(screenWordLyric(noHash, { expectedFileHash: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF' })).toEqual({ ok: true, lineCount: 9 })
  })

  it('末行覆盖不足时长 40% 则拒', () => {
    expect(screenWordLyric(good, { durationSeconds: 300 }).reason).toContain('仅覆盖时长')
  })

  it('脏数据（字早于行）在自检处被拒', () => {
    const broken: WordLyric = {
      headers: {},
      lines: Array.from({ length: 9 }, (_, i) => ({ start: i * 1000, end: i * 1000 + 900, words: [{ start: i * 1000 - 500, end: i * 1000, text: '字' }, { start: i * 1000, end: i * 1000 + 400, text: '另一字' }] })),
    }
    expect(screenWordLyric(broken, {})).toMatchObject({ ok: false, reason: expect.stringContaining('首字早于行时间') })
  })
})

describe('序列化：增强 LRC 与行级 LRC 必须同源', () => {
  const lyric = parseKrc(KRC_TEXT)!
  const enhanced = toEnhancedLrc(lyric)
  const plain = toPlainLrc(lyric)

  it('增强 LRC 形状：行首方括号 + 每块前一个绝对起始 + 行尾结束时间', () => {
    expect(enhanced.split('\n')[1]).toBe('[00:01.000]<00:01.000>第一<00:02.000>个字<00:03.000>开始<00:04.000>')
  })

  it('两者的行时间一一对应且行数相同（接线时靠这条保证高亮不抖）', () => {
    const tagOf = (s: string) => s.split('\n').map(l => /\[(.*?)\]/.exec(l)![1])
    expect(tagOf(enhanced)).toEqual(tagOf(plain))
    expect(enhanced.split('\n')).toHaveLength(plain.split('\n').length)
  })

  it('增强 LRC 去掉尖括号段就等于行级文本', () => {
    const stripped = enhanced.split('\n').map(l => l.replace(/<[^>]*>/g, '').replace(/^\[[^\]]*\]/, '').trim())
    const plainTexts = plain.split('\n').map(l => l.replace(/^\[[^\]]*\]/, '').trim())
    expect(stripped).toEqual(plainTexts)
  })

  it('MRC 与 KRC 走同一个出口形状', () => {
    expect(toEnhancedLrc(parseMrc(MRC_TEXT)!).split('\n')[0]).toBe('[00:01.000]<00:01.000>第<00:02.000>一<00:03.000>行<00:04.000>')
  })
})

// ————— 真机样本（gitignored；没有文件就跳过，别把它当实测通过）—————
const CAPTURED_PATH = path.resolve(process.cwd(), 'my/word-lyric-captured.json')
const hasCaptured = fs.existsSync(CAPTURED_PATH)
const captured = hasCaptured ? JSON.parse(fs.readFileSync(CAPTURED_PATH, 'utf8')) as Array<Record<string, string & number>> : []
const describeReal = hasCaptured ? describe : describe.skip

describeReal('真机 KRC/MRC 样本（my/capture-word-lyric.mjs 抓取）', () => {
  for (const sample of captured) {
    const isKrc = sample.kind === 'krc'
    const text = isKrc ? decodeKrcPayload(sample.content as string) : (sample.mrcText as string)

    it(`${sample.kind} ${sample.song}`, () => {
      expect(text, '载荷应可解').toBeTruthy()
      const lyric = isKrc ? parseKrc(text!) : parseMrc(text!)
      expect(lyric, '应能解析出时间行').not.toBeNull()
      const verdict = screenWordLyric(lyric!, {
        durationSeconds: Number(sample.durationSeconds) || 0,
        expectedFileHash: isKrc ? (sample as Record<string, string>).hash ?? null : null,
      })
      // 逐字粒度：多数行应被切成多块
      const ratio = lyric!.lines.filter(l => l.words.length >= 2).length / lyric!.lines.length
      expect(ratio, `分块行占比 ${(ratio * 100).toFixed(0)}%`).toBeGreaterThanOrEqual(0.6)
      // 归一化不变量：首字不早于行、字时间单调
      for (const line of lyric!.lines) {
        expect(line.words[0].start, '首字应不早于行时间').toBeGreaterThanOrEqual(line.start)
        for (let i = 1; i < line.words.length; i++) expect(line.words[i].start).toBeGreaterThanOrEqual(line.words[i - 1].start)
      }
      // 出口自洽
      expect(toPlainLrc(lyric!).split('\n')).toHaveLength(lyric!.lines.length)
      expect(lyric!.lines.some(l => l.words.flatMap(w => w.text).join('').includes('('))).toBe(false)
      if (verdict.ok) expect(verdict.lineCount).toBe(lyric!.lines.length)
      else console.log(`  [真机拒因] ${sample.song}: ${verdict.reason}`)
    })
  }
})

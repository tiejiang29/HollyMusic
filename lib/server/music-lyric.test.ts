import { afterEach, describe, expect, it, vi } from 'vitest'
import { deflateSync } from 'zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fetchNativeLyric, parseKuwoLyricsPayload } from './music-lyric'
import type { MusicInfo } from '@/lib/types/music'

const baseMusicInfo: Omit<MusicInfo, 'source' | 'songmid'> = {
  name: '测试歌曲',
  singer: '测试歌手',
  interval: '03:00',
  types: [],
  _types: {},
  typeUrl: {},
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseKuwoLyricsPayload', () => {
  it('将酷我按歌曲 ID 返回的歌词转换为带毫秒时间轴的 LRC', () => {
    expect(parseKuwoLyricsPayload({
      data: {
        lrclist: [
          { time: '0.0', lineLyric: '歌曲信息' },
          { time: '12.628', lineLyric: '第一句歌词' },
        ],
      },
    })).toBe('[00:00.000]歌曲信息\n[00:12.628]第一句歌词')
  })

  it('在响应无有效歌词行时返回 null', () => {
    expect(parseKuwoLyricsPayload({ data: { lrclist: [] } })).toBeNull()
  })
})

describe('fetchNativeLyric', () => {
  it('解析 QQ 音乐 Base64 的原文与翻译，并保持 LRC 时间轴', async () => {
    const lyric = '[00:01.000]原文'
    const translation = '[00:01.000]翻译'
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      lyric: Buffer.from(lyric).toString('base64'),
      trans: Buffer.from(translation).toString('base64'),
    })))
    vi.stubGlobal('fetch', fetch)

    await expect(fetchNativeLyric({ ...baseMusicInfo, source: 'tx', songmid: '001test' })).resolves.toEqual({
      lyric,
      tlyric: translation,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('使用咪咕歌曲随搜索结果保存的 lrcUrl，不按歌名重新搜索', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('[00:02.000]精确歌词'))
    vi.stubGlobal('fetch', fetch)

    await expect(fetchNativeLyric({
      ...baseMusicInfo,
      source: 'mg',
      songmid: '123',
      lrcUrl: 'https://lyrics.example.test/exact.lrc',
    })).resolves.toEqual({ lyric: '[00:02.000]精确歌词', tlyric: null })
    expect(fetch.mock.calls[0][0]).toBe('https://lyrics.example.test/exact.lrc')
  })

  it('酷我旧歌词接口无结果时，使用加密歌曲 ID 接口并还原普通 LRC', async () => {
    const plainLyric = '[00:01.000]<1,2>native lyric'
    const key = Buffer.from('yeelion')
    const encrypted = Buffer.from(plainLyric)
    for (let index = 0; index < encrypted.length; index++) encrypted[index] ^= key[index % key.length]
    const raw = Buffer.concat([
      Buffer.from('tp=content\r\n\r\n'),
      deflateSync(Buffer.from(encrypted.toString('base64'))),
    ])
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null })))
      .mockResolvedValueOnce(new Response(raw))
    vi.stubGlobal('fetch', fetch)

    await expect(fetchNativeLyric({ ...baseMusicInfo, source: 'kw', songmid: '306518865' })).resolves.toEqual({
      lyric: '[00:01.000]native lyric',
      tlyric: null,
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(String(fetch.mock.calls[1][0])).toContain('newlyric.kuwo.cn/newlyric.lrc?')
  })

  it('酷狗候选不匹配歌曲与歌手时不下载第一条搜索结果', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ id: 'wrong', accesskey: 'wrong', song: '另一首歌', singer: '另一位歌手' }],
    })))
    vi.stubGlobal('fetch', fetch)

    await expect(fetchNativeLyric({
      ...baseMusicInfo,
      source: 'kg',
      songmid: '123',
      hash: 'song-hash',
    })).resolves.toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

// ————— 逐字接线（酷狗 KRC / 咪咕 MRC）—————
const KRC_XOR_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105]
const encodeKrc = (text: string) => {
  const deflated = Uint8Array.from(deflateSync(Buffer.from(text, 'utf8')), (b, i) => b ^ KRC_XOR_KEY[i % KRC_XOR_KEY.length])
  return Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.from(deflated)]).toString('base64')
}

/** 9 行 × 3 块、末行到 113s（baseMusicInfo 的 03:00 时长要过 40% 覆盖判据） */
const WORD_KRC = ['[ti:测试歌曲]', '[ar:测试歌手]']
  .concat(Array.from({ length: 9 }, (_, i) => {
    const at = 80_000 + i * 3_000
    return `[${at},3000]<0,1000,0>第${i + 1}字<1000,1000,0>中间字<2000,1000,0>末字`
  }))
  .join('\n')

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

function mockKugou(handlers: { krc?: string; lrc?: string; hashHeader?: string }) {
  const search = { candidates: [{ id: 'lyric-1', accesskey: 'key-1', song: '测试歌曲', singer: '测试歌手' }] }
  return vi.fn(async (url: string) => {
    if (url.includes('/search')) return new Response(JSON.stringify(search))
    const fmt = new URL(url).searchParams.get('fmt')
    if (fmt === 'krc') {
      if (handlers.krc === undefined) return new Response(JSON.stringify({ fmt: 'krc', content: encodeKrc(WORD_KRC) }))
      return new Response(JSON.stringify({ fmt: 'krc', content: handlers.krc }))
    }
    return new Response(JSON.stringify({ fmt: 'lrc', content: b64(handlers.lrc ?? '[01:20.000]整行回落') }))
  })
}

const kgInfo = { ...baseMusicInfo, source: 'kg' as const, songmid: '123', hash: 'song-hash' }

describe('fetchNativeLyric 逐字接线', () => {
  it('酷狗 KRC 命中时，整行与逐字出自同一次解析', async () => {
    vi.stubGlobal('fetch', mockKugou({}))
    const result = await fetchNativeLyric(kgInfo)
    expect(result?.wordLyric).toContain('[01:20.000]<01:20.000>第1字<01:21.000>中间字<01:22.000>末字<01:23.000>')
    expect(result?.lyric.split('\n').filter(l => /^\[\d/.test(l))).toEqual(
      Array.from({ length: 9 }, (_, i) => `[01:${20 + i * 3}.000]第${i + 1}字中间字末字`),
    )
    expect(fetch).toHaveBeenCalledTimes(2) // search + krc，命中就不再要 lrc
  })

  it('KRC 头里的 [hash:] 与请求 FileHash 不符时回落整行，不下发逐字', async () => {
    const shifted = WORD_KRC.replace('[ti:测试歌曲]', '[hash:FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF]\n[ti:测试歌曲]')
    vi.stubGlobal('fetch', mockKugou({ krc: encodeKrc(shifted), lrc: '[01:20.000]回落文本' }))
    const result = await fetchNativeLyric(kgInfo)
    expect(result).toEqual({ lyric: '[01:20.000]回落文本', tlyric: null })
    expect(result?.wordLyric ?? null).toBeNull()
  })

  it('KRC 过不了结构闸门（实测串台返回 1 行「纯音乐，请欣赏」）时回落整行', async () => {
    const placeholder = '[ti:June]\n[ar:arkady sevidov]\n[1589,320317]<0,354,0>纯<354,300,0>音乐<654,300,0>，请欣赏'
    vi.stubGlobal('fetch', mockKugou({ krc: encodeKrc(placeholder), lrc: '[00:01.589]纯音乐，请欣赏' }))
    await expect(fetchNativeLyric(kgInfo)).resolves.toEqual({ lyric: '[00:01.589]纯音乐，请欣赏', tlyric: null })
  })

  it('下载接口不回 krc 格式时静默走原 lrc 路径', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes('/search')
        ? { candidates: [{ id: 'l1', accesskey: 'k1', song: '测试歌曲', singer: '测试歌手' }] }
        : new URL(url).searchParams.get('fmt') === 'krc'
          ? { fmt: 'lrc', content: b64('不该被用到') }
          : { fmt: 'lrc', content: b64('[00:01.000]老路径') },
    ))))
    await expect(fetchNativeLyric(kgInfo)).resolves.toEqual({ lyric: '[00:01.000]老路径', tlyric: null })
  })

  it('咪咕 mrcUrl 解不出可用逐字时，仍按 lrcUrl 取整行（行为不变）', async () => {
    const mgInfo = {
      ...baseMusicInfo, source: 'mg' as const, songmid: 'mg-1',
      mrcUrl: 'https://d.musicapp.migu.cn/x/mrc', lrcUrl: 'https://d.musicapp.migu.cn/x/lrc',
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
      url.endsWith('/mrc') ? '太短不足以解密，回落' : '[00:01.000]咪咕整行',
    )))
    await expect(fetchNativeLyric(mgInfo)).resolves.toEqual({ lyric: '[00:01.000]咪咕整行', tlyric: null })
  })
})

// 咪咕 MRC 只有解密版，测试里造不出加密载荷 ⇒ 用真机密文（gitignored），没有就跳过
const CAPTURED = path.resolve(process.cwd(), 'my/word-lyric-captured.json')
const captured = fs.existsSync(CAPTURED)
  ? (JSON.parse(fs.readFileSync(CAPTURED, 'utf8')) as Array<Record<string, string & number>>).filter(s => s.kind === 'mrc' && s.mrcRaw)
  : []
const describeReal = captured.length ? describe : describe.skip

describeReal('咪咕逐字接线（真机密文，my/capture-word-lyric.mjs 抓取）', () => {
  for (const sample of captured) {
    it(`${sample.song}`, async () => {
      const plainLrc = '[00:01.000]咪咕整行'
      vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
        String(url).endsWith('/mrc') ? sample.mrcRaw : plainLrc,
      )))
      const result = await fetchNativeLyric({
        ...baseMusicInfo, source: 'mg', songmid: String(sample.songId ?? 'mg-1'),
        interval: '03:00', mrcUrl: 'https://d.musicapp.migu.cn/x/mrc', lrcUrl: 'https://d.musicapp.migu.cn/x/lrc',
      })
      expect(result?.wordLyric, '真机 MRC 应命中逐字').toBeTruthy()
      const timed = (s: string) => s.split('\n').filter(l => /^\[\d{1,2}:\d{2}/.test(l))
      expect(timed(result!.lyric)).toHaveLength(timed(result!.wordLyric!).length)
      expect(result!.lyric).not.toContain('作词')
      expect(fetch).toHaveBeenCalledTimes(1) // 命中后不再请求 lrcUrl
    })
  }
})

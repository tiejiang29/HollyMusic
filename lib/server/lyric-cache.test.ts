/**
 * sidecar 路径工具。单独测是因为扩展名一旦漏认，audio-serve 的孤儿扫描会把仍在使用
 * 的歌词文件当垃圾清掉 —— 那是静默丢数据，不是报错。
 */
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  getLyricSidecarPath, getTranslationLyricSidecarPath, getWordLyricSidecarPath, isLyricSidecarPath,
} from './lyric-cache'

describe('歌词 sidecar 路径', () => {
  it('三种歌词各自成文件，互不覆盖', () => {
    const audio = path.join(path.sep + 'cache', 'a', 'song.flac')
    const names = [getLyricSidecarPath, getTranslationLyricSidecarPath, getWordLyricSidecarPath].map(fn => path.basename(fn(audio)))
    // 断言用 basename：Windows 上 path.join 会换成反斜杠，比整串路径会因平台而异
    expect(names).toEqual(['song.lrc', 'song.tlyric.lrc', 'song.wlrc'])
    expect(new Set(names).size).toBe(3)
    for (const one of names) expect(path.dirname(path.join(audio, '..', one))).toBe(path.dirname(audio))
  })

  it('孤儿扫描认得全部三种后缀（.wlrc 不以 .lrc 结尾，必须显式列出）', () => {
    expect(isLyricSidecarPath('a/song.lrc')).toBe(true)
    expect(isLyricSidecarPath('a/song.tlyric.lrc')).toBe(true)
    expect(isLyricSidecarPath('a/song.wlrc')).toBe(true)
    expect(isLyricSidecarPath('a/song.flac')).toBe(false)
    expect(isLyricSidecarPath('a/song.jpg')).toBe(false)
  })
})

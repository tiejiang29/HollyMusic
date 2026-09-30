/**
 * 客户端逐字（增强 LRC）解析。与 lib/server/word-lyric.ts 的出口格式对齐：
 * 行首 [mm:ss.xxx] + 每块前一个 <mm:ss.xxx> + 行尾一个无文本的 <mm:ss.xxx>。
 */
import { describe, it, expect } from 'vitest'
import { parseEnhancedLrc, findActiveWordIndex, parseLrc } from './lrc'

const ENHANCED = [
  '[ti:合成曲]',
  '[00:01.000]<00:01.000>第<00:02.000>一<00:03.000>行<00:04.000>',
  '[00:08.020]<00:08.020>The <00:08.400>rain <00:08.800>falls<00:09.400>',
  '[00:12.000]<00:12.000>没有行尾标签的一行',
].join('\n')

describe('parseEnhancedLrc', () => {
  const lines = parseEnhancedLrc(ENHANCED)

  it('解析出行与字，时间单位是秒', () => {
    expect(lines).toHaveLength(3)
    expect(lines[0].time).toBeCloseTo(1, 3)
    expect(lines[0].words?.map(w => w.text)).toEqual(['第', '一', '行'])
    expect(lines[0].words?.map(w => Number(w.time.toFixed(3)))).toEqual([1, 2, 3])
  })

  it('行尾那个没有后续文本的标签当结束时间，不当成一个字', () => {
    expect(lines[0].endTime).toBeCloseTo(4, 3)
    expect(lines[0].words).toHaveLength(3)
  })

  it('缺行尾标签时 endTime 为 undefined，字仍齐全', () => {
    expect(lines[2].endTime).toBeUndefined()
    expect(lines[2].words?.map(w => w.text)).toEqual(['没有行尾标签的一行'])
  })

  it('块内空格保留，整行文本不粘连', () => {
    expect(lines[1].words?.map(w => w.text)).toEqual(['The ', 'rain ', 'falls'])
    expect(lines[1].text).toBe('The rain falls')
  })

  it('普通 LRC（无尖括号）解析为空，由调用方回落', () => {
    expect(parseEnhancedLrc('[00:01.000]整行歌词')).toEqual([])
    expect(parseEnhancedLrc(null)).toEqual([])
  })

  it('[offset:] 与整行解析口径一致（客户端既有约定：time + offset/1000）', () => {
    const offset = ['[offset:-500]', '[00:01.000]<00:01.000>字<00:02.000>'].join('\n')
    expect(parseEnhancedLrc(offset)[0].time).toBeCloseTo(0.5, 3)
    expect(parseEnhancedLrc(offset)[0].words![0].time).toBeCloseTo(0.5, 3)
    expect(parseEnhancedLrc(offset)[0].endTime).toBeCloseTo(1.5, 3)
    // 同一份带 offset 的文本，行级与逐字必须给出相同时间（useLyrics 靠这条决定是否敢用逐字）
    expect(parseLrc(['[offset:-500]', '[00:01.000]字'].join('\n'))[0].time)
      .toBeCloseTo(parseEnhancedLrc(offset)[0].time, 3)
  })
})

describe('findActiveWordIndex', () => {
  const line = parseEnhancedLrc(ENHANCED)[0]

  it('行前返回 -1，行内按起始推进', () => {
    expect(findActiveWordIndex(line, 0.5)).toBe(-1)
    expect(findActiveWordIndex(line, 1)).toBe(0)
    expect(findActiveWordIndex(line, 2.5)).toBe(1)
    expect(findActiveWordIndex(line, 9)).toBe(2)
  })

  it('整行歌词（无 words）与无效时间都返回 -1', () => {
    expect(findActiveWordIndex({ time: 1, text: '整行' }, 5)).toBe(-1)
    expect(findActiveWordIndex(undefined, 5)).toBe(-1)
    expect(findActiveWordIndex(line, Number.NaN)).toBe(-1)
  })
})

import { describe, expect, it } from 'vitest'
import { dedupeByIdentity, songIdentity, splitSinger } from './song-identity'

describe('splitSinger', () => {
  it('按常见分隔符拆分并去重', () => {
    expect(splitSinger('周杰伦、费玉清')).toEqual(['周杰伦', '费玉清'])
    expect(splitSinger('A, B；C feat. D')).toEqual(['A', 'B', 'C', 'D'])
  })

  it('不按 "/" 拆，保护名字本身含斜杠的乐队', () => {
    expect(splitSinger('AC/DC')).toEqual(['AC/DC'])
  })

  it('空值返回空数组', () => {
    expect(splitSinger('')).toEqual([])
    expect(splitSinger(null)).toEqual([])
    expect(splitSinger(undefined)).toEqual([])
  })
})

describe('songIdentity', () => {
  it('大小写、空白、·・\' 归一化后等价', () => {
    const a = songIdentity({ name: '恼人的秋风 (Live)', singer: '那英、肖战' })
    const b = songIdentity({ name: '恼人的秋风(Live)', singer: '那英， 肖战' })
    expect(a).toBe(b)
  })

  it('歌手相同但顺序不同，标识相同', () => {
    expect(songIdentity({ name: '千里之外', singer: '费玉清、周杰伦' }))
      .toBe(songIdentity({ name: '千里之外', singer: '周杰伦、费玉清' }))
  })

  it('歌手集合不同（独唱 vs 合唱）标识不同', () => {
    expect(songIdentity({ name: '千里之外', singer: '费玉清、周杰伦' }))
      .not.toBe(songIdentity({ name: '千里之外', singer: '费玉清' }))
  })

  it('不同版本（Live 标记等）标识不同', () => {
    expect(songIdentity({ name: '晴天', singer: '周杰伦' }))
      .not.toBe(songIdentity({ name: '晴天(抒情钢琴版)', singer: '周杰伦' }))
  })
})

describe('dedupeByIdentity', () => {
  it('同曲多副本只保留一份，优先有封面的副本', () => {
    const items = [
      { name: '重复歌', singer: '歌手', img: '' },
      { name: '重复歌', singer: '歌手', img: 'http://x/2.jpg' },
      { name: '独立歌', singer: '歌手', img: '' },
    ]
    const out = dedupeByIdentity(items, s => s)
    expect(out).toHaveLength(2)
    expect(out.find(s => s.name === '重复歌')?.img).toBe('http://x/2.jpg')
  })

  it('位置取首次出现处，先出现的副本留在原位', () => {
    const items = [
      { name: '甲歌', singer: 'A', img: '' },
      { name: '乙歌', singer: 'B', img: 'http://x/b.jpg' },
      { name: '甲歌', singer: 'A', img: 'http://x/a.jpg' },
    ]
    const out = dedupeByIdentity(items, s => s)
    expect(out.map(s => s.name)).toEqual(['甲歌', '乙歌'])
    expect(out[0].img).toBe('http://x/a.jpg')
  })
})

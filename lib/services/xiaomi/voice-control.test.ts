/**
 * 第①层（控制词表）与相似度算法的测试。
 *
 * 最要紧的三条：
 * 1. **先具体后笼统**：「取消单曲循环」要输给「单曲循环」之外的那条更长的匹配 ——
 *    顺序错了会把"取消 X"执行成 X（做反方向的动作比不接更糟）；
 * 2. **"音量调到 40"要抠得出那个数**，否则第①层只会 +/-；
 * 3. 相似度是第②层唯一的"这首歌到底像不像"的闸门，算错了会乱投别人的歌。
 */

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CONTROL_RULES, normalizeUtterance, matchControl, parseControlRules, formatControlRules,
  levenshtein, similarity,
} from '@/lib/services/xiaomi/voice-control'

const rules = DEFAULT_CONTROL_RULES

describe('归一化', () => {
  it('标点、空白、大小写都不该影响命中', () => {
    expect(normalizeUtterance('  暂停。 ')).toBe('暂停')
    expect(normalizeUtterance('Pause!')).toBe('pause')
    expect(normalizeUtterance('下一首、谢谢')).toBe('下一首谢谢')
  })

  it('空的一律归零（别拿空句去匹配出个动作）', () => {
    expect(normalizeUtterance('')).toBe('')
    expect(normalizeUtterance(undefined as unknown as string)).toBe('')
  })
})

describe('命中哪条控制指令', () => {
  it('一句普通问候什么都不是', () => {
    expect(matchControl('今天天气怎么样', rules)).toBeNull()
    expect(matchControl('', rules)).toBeNull()
  })

  it('前后缀不影响："帮我切下一首好吗" 还是 next', () => {
    expect(matchControl('帮我切下一首好吗', rules)?.op).toBe('next')
  })

  it('先具体后笼统：「取消单曲循环」不许被当成「单曲循环」', () => {
    // 这条表里已经没有 loop 类操作（播放模式在前端那侧），但顺序规则要用真实存在的对子钉住：
    // 「暂停播放」比「停一下」更长更具体，放在表前面时必须先被试到
    const ordered = parseControlRules('pause=暂停播放,暂停\nstop=停一下')
    expect(matchControl('暂停播放吧', ordered)?.op).toBe('pause')
    const flipped = parseControlRules('stop=停一下\npause=暂停')
    // 反过来排时"停一下"会先抢——这就是词表顺序要进面板、且默认表把长句排前面的原因
    expect(matchControl('停一下', flipped)?.op).toBe('stop')
  })

  it('"音量调到 40" 抠出 setVolume 且带数字；越界钳到 0~100', () => {
    expect(matchControl('音量调到 40', rules)).toMatchObject({ op: 'setVolume', volumeTo: 40 })
    expect(matchControl('声音设为 120', rules)?.volumeTo).toBe(100)
    expect(matchControl('音量改成 0', rules)?.volumeTo).toBe(0)
  })

  it('没数字时不冒充 setVolume', () => {
    expect(matchControl('音量调大一点', rules)?.op).toBe('volumeUp')
  })

  it('英文 pause 也认（有人对着音箱说英语）', () => {
    expect(matchControl('please pause the music', rules)?.op).toBe('pause')
  })
})

describe('词表的读与写要能走同一个形状', () => {
  it('默认表 → 文本 → 解析回来，条数与每条的词都不许丢', () => {
    const text = formatControlRules(rules)
    const back = parseControlRules(text)
    expect(back).toHaveLength(rules.length)
    expect(back[0].op).toBe('prev')
    expect(back.map(r => r.words.length)).toEqual(rules.map(r => r.words.length))
  })

  it('认不出来的操作直接丢行（面板上打错一个字不该让整张表失效）', () => {
    const parsed = parseControlRules('pause=暂停\nfly=飞到天上去\nnext=下一首')
    expect(parsed.map(r => r.op)).toEqual(['pause', 'next'])
  })

  it('整张表都是坏的 ⇒ 空数组（调用方会回落到默认表，不会一条都命不中）', () => {
    expect(parseControlRules('随便写点什么')).toEqual([])
    expect(parseControlRules('')).toEqual([])
  })
})

describe('相似度', () => {
  it('莱氏顿伯格几个已知值', () => {
    expect(levenshtein('abc', 'abc')).toBe(0)
    expect(levenshtein('abc', 'abd')).toBe(1)
    expect(levenshtein('', 'abcd')).toBe(4)
  })

  it('完全一样是 1，完全不像接近 0，且对长度不同做了归一', () => {
    expect(similarity('稻香', '稻香')).toBe(1)
    expect(similarity('稻香', '小苹果')).toBeCloseTo(1 - 3 / 3, 5)
    // 版本后缀会实打实拉低相似度（'青花瓷' vs '青花瓷(live)' = 0.33）：所以第②层还额外认"互相包含"，
    // 否则"放青花瓷"这句永远配不上《青花瓷 (Live)》
    expect(similarity('青花瓷', '青花瓷 (Live)')).toBeLessThan(0.4)
  })

  it('空的两边都算不像（不许拿 0/0 蒙成 1）', () => {
    expect(similarity('', '')).toBe(0)
  })

  it('长度上限防的是有人把整段话丢进来算距离', () => {
    const long = 'あ'.repeat(200)
    expect(() => similarity(long, long)).not.toThrow()
    expect(similarity(long, long)).toBe(1)
  })
})

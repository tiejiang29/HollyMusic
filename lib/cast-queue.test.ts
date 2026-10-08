/**
 * 投放顺序算法的测试：这份逻辑必须与 `player-store` 里 `next()`/`handleTrackEnd()` 的消费顺序一致，
 * 否则"音箱播的"和"界面上高亮的"会是两回事。
 *
 * 四条要紧的：插播优先于一切模式、单曲循环交空表（靠设备循环这一首）、随机要**冻结成一份确定列表**
 * （服务端不能每首播完再回来问一次，那正是"关掉页面就断"的成因）、顺序模式播到队尾交空表让服务端收口。
 */

import { describe, expect, it } from 'vitest'

const {
  buildCastOrder, shuffled, syncCursorToUid, clampSpeakerVolume,
  volumeSendDelayMs, VOLUME_SEND_INTERVAL_MS,
} = await import('@/lib/cast-queue')
import type { Track } from '@/lib/types/player'

const track = (uid: string, duration = 200): Track => ({
  uid, duration, name: uid, artist: '歌手', album: '', source: 'tx',
  musicInfo: {} as Track['musicInfo'],
})
const snap = (over: Partial<Parameters<typeof buildCastOrder>[0]> = {}) => ({
  queue: [track('a'), track('b'), track('c')],
  playNextQueue: [],
  currentIndex: 0,
  currentTrack: track('a'),
  playbackMode: 'sequence' as const,
  ...over,
})

describe('buildCastOrder', () => {
  it('顺序模式：从当前游标往后交，队尾就没了（服务端据此 stop，不会从头循环）', () => {
    const atEnd = buildCastOrder(snap({ currentIndex: 2, currentTrack: track('c') }))
    expect(atEnd?.rest.map(t => t.uid)).toEqual([])
    expect(atEnd?.current.uid).toBe('c')
    const mid = buildCastOrder(snap({ currentIndex: 1, currentTrack: track('b') }))
    expect(mid?.rest.map(t => t.uid)).toEqual(['c'])
  })

  it('插播队列优先于一切模式，整个排在最前', () => {
    const r = buildCastOrder(snap({
      currentIndex: 1, currentTrack: track('b'),
      playNextQueue: [track('x'), track('y')],
    }))
    expect(r?.rest.map(t => t.uid)).toEqual(['x', 'y', 'c'])
  })

  it('当前曲就来自插播队列时，不把它自己再排进后面', () => {
    const r = buildCastOrder(snap({
      currentIndex: 0, currentTrack: track('x'),
      playNextQueue: [track('x'), track('y')],
    }))
    expect(r?.rest.map(t => t.uid)).toEqual(['y', 'a', 'b', 'c'])
  })

  it('单曲循环：rest 交空表并标 loopOne（让设备循环这一首，服务端不许补窗也不收口）', () => {
    const r = buildCastOrder(snap({ playbackMode: 'loop' }))
    expect(r).toEqual({ current: { uid: 'a', durSec: 200 }, rest: [], loopOne: true })
  })

  it('随机：摇一次定成一份确定列表（rng 注入后可断言），且不含当前曲', () => {
    // rng 恒为 0.5 → 每次 j 都落在中间，结果确定
    const r = buildCastOrder(snap({ playbackMode: 'random' }), { random: () => 0.5 })
    expect(r?.loopOne).toBe(false)
    expect(r?.rest.map(t => t.uid).sort()).toEqual(['b', 'c'])
    expect(r?.rest.map(t => t.uid)).not.toContain('a')
  })

  it('随机 + 插播：插播仍然排在摇出来的顺序之前', () => {
    const r = buildCastOrder(snap({
      playbackMode: 'random', currentIndex: 1, currentTrack: track('b'),
      playNextQueue: [track('x')],
    }), { random: () => 0 })
    expect(r?.rest[0].uid).toBe('x')
  })

  it('时长缺失给 0，不要伪造一个（服务端会用设备报的时长兜）', () => {
    const r = buildCastOrder(snap({ currentTrack: track('a', 0) }))
    expect(r?.current.durSec).toBe(0)
  })

  it('没有当前曲就不投（返回 null，让调用方不去发一条没内容的请求）', () => {
    expect(buildCastOrder(snap({ currentTrack: null }))).toBeNull()
  })
})

describe('shuffled', () => {
  it('不改原数组，且同样 rng 下结果可复现', () => {
    const src = [1, 2, 3, 4, 5]
    // rng 恒为 0 ⇒ 每步都跟队首换，顺序是定死的（交出去的就是这份顺序，服务端不会再摇）
    const out = shuffled(src, () => 0)
    expect(src).toEqual([1, 2, 3, 4, 5])
    expect(out).toEqual([2, 3, 4, 5, 1])
    expect(shuffled(src, () => 0)).toEqual(out)
  })
})

describe('syncCursorToUid：音箱报回来的游标落回队列', () => {
  it('主队列命中就挪游标', () => {
    const p = syncCursorToUid(snap({ currentIndex: 0, currentTrack: track('a') }), 'c')
    expect(p?.currentIndex).toBe(2)
    expect(p?.currentTrack.uid).toBe('c')
    expect(p?.playNextQueue).toBeUndefined()
  })

  it('插播命中时把它之前的插播一起消费掉（与本地 playFromPlayNext 同一语义）', () => {
    const p = syncCursorToUid(snap({ currentIndex: 0, currentTrack: track('a'), playNextQueue: [track('x'), track('y')] }), 'y')
    expect(p?.currentTrack.uid).toBe('y')
    expect(p?.playNextQueue).toEqual([])
  })

  it('认不出来就什么都不动（别把游标跳到一个不存在的歌上）', () => {
    expect(syncCursorToUid(snap(), 'zzz')).toBeNull()
  })
})

describe('clampSpeakerVolume', () => {
  it('夹到 0-100 并取整', () => {
    expect(clampSpeakerVolume(37.6, 50)).toBe(38)
    expect(clampSpeakerVolume(-5, 50)).toBe(0)
    expect(clampSpeakerVolume(240, 50)).toBe(100)
  })

  it('不是数字就保持原值，不把 NaN 发给小米', () => {
    expect(clampSpeakerVolume('', 42)).toBe(42)
    expect(clampSpeakerVolume(undefined, 42)).toBe(42)
  })
})

describe('volumeSendDelayMs：拖动音量条时的发送节奏（面板与播放页共用这一份）', () => {
  it('第一次（还没发过）立刻发', () => {
    expect(volumeSendDelayMs(1000, -Infinity)).toBeNull()
  })
  it('间隔内不发，并给出还要等的毫秒数', () => {
    expect(volumeSendDelayMs(1000, 900)).toBe(VOLUME_SEND_INTERVAL_MS - 100)
  })
  it('刚好攒够间隔就发（边界不算成"再等 0 毫秒"，那是一次空等）', () => {
    expect(volumeSendDelayMs(1000, 1000 - VOLUME_SEND_INTERVAL_MS)).toBeNull()
  })
  it('早就发过的一定发', () => {
    expect(volumeSendDelayMs(10_000, 1000)).toBeNull()
  })
})

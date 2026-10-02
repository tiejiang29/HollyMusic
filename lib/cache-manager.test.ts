/**
 * lib/cache-manager.ts 的淘汰语义测试
 *
 * 这里的行为不是摆设：图片和搜索结果一度共用同一个实例、只按条数 FIFO 淘汰，
 * 结果"首页一直在看的那批封面"因为插入最早，每次溢出都第一个被踢。
 * 现在要求：LRU 顺序、条数与字节双上限、单条超预算不缓存、默认实例行为不变。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CacheManager, imageCache, searchCache } from './cache-manager'

beforeEach(() => {
  // 构造函数里挂着 5 分钟的清理定时器，用假定时器免得拖住测试进程
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('淘汰顺序是 LRU', () => {
  it('get 命中会把键挪到队尾，溢出时淘汰的是最久未用的那条', () => {
    const c = new CacheManager<string>({ maxEntries: 3 })
    c.set('a', 'A', 60_000)
    c.set('b', 'B', 60_000)
    c.set('c', 'C', 60_000)

    expect(c.get('a')).toBe('A')   // a 变成"最近用过"，队头轮到 b
    c.set('d', 'D', 60_000)

    expect(c.get('b')).toBeNull()  // 被淘汰的必须是 b，不是 a（FIFO 会错踢 a）
    expect(c.get('a')).toBe('A')
    expect(c.get('c')).toBe('C')
    expect(c.get('d')).toBe('D')
    expect(c.getStats().size).toBe(3)
  })

  it('重复 set 同一个键也刷新位置，并且不会把字节记成两份', () => {
    const c = new CacheManager<string>({ maxEntries: 3, sizeOf: s => s.length })
    c.set('a', 'xx', 60_000)
    c.set('b', 'yyy', 60_000)
    c.set('a', 'zzzzzz', 60_000)   // 覆盖：旧值 2 字节要减掉，新值 6 字节 → 6+3=9

    expect(c.getStats().bytes).toBe(9)
    expect(c.get('a')).toBe('zzzzzz')
  })
})

describe('字节预算', () => {
  it('超出 maxBytes 时从最久未用的一端一直删到达标', () => {
    const c = new CacheManager<string>({ maxBytes: 100, sizeOf: s => s.length })
    c.set('a', 'x'.repeat(40), 60_000)
    c.set('b', 'x'.repeat(40), 60_000)
    c.set('c', 'x'.repeat(40), 60_000)   // 120 > 100 → 该踢 a

    expect(c.getStats().size).toBe(2)
    expect(c.getStats().bytes).toBeLessThanOrEqual(100)
    expect(c.get('a')).toBeNull()
    expect(c.get('c')).toBeTruthy()
  })

  it('单条目自己就超预算的直接不缓存（否则它会把整池挤空再把自己留下）', () => {
    const c = new CacheManager<string>({ maxBytes: 100, sizeOf: s => s.length })
    c.set('big', 'x'.repeat(150), 60_000)

    expect(c.get('big')).toBeNull()
    expect(c.getStats().size).toBe(0)
    expect(c.getStats().bytes).toBe(0)
  })

  it('没配 sizeOf 就不计字节，maxBytes 也就无从触发', () => {
    const c = new CacheManager<string>({ maxBytes: 10 })
    c.set('a', 'x'.repeat(500), 60_000)
    expect(c.get('a')).toBeTruthy()
    expect(c.getStats().bytes).toBe(0)
    expect(c.getStats().maxBytes).toBe(10)
  })
})

describe('默认行为与过期', () => {
  it('不传参数就是 2000 条上限、不计字节 —— 现有的 search/url/lyric 实例不受影响', () => {
    const s = searchCache.getStats()
    expect(s.maxEntries).toBe(2000)
    expect(s.maxBytes).toBeNull()
  })

  it('过期的条目在 get 时清掉，字节同步回收，不会变成负数', () => {
    const c = new CacheManager<string>({ sizeOf: s => s.length })
    c.set('a', 'abcd', 1000)
    expect(c.getStats().bytes).toBe(4)

    vi.advanceTimersByTime(1500)
    expect(c.get('a')).toBeNull()
    const st = c.getStats()
    expect(st.size).toBe(0)
    expect(st.bytes).toBe(0)
    expect(st.misses).toBe(1)
  })

  it('clear 把条目与计数一起归零', () => {
    const c = new CacheManager<string>({ sizeOf: s => s.length })
    c.set('a', 'xx', 60_000)
    c.get('a')
    c.clear()
    const st = c.getStats()
    expect(st).toMatchObject({ size: 0, bytes: 0, hits: 0, misses: 0 })
  })
})

describe('生产实例的口径（有人改常量要在这里留下动静）', () => {
  it('imageCache 是 500 条 / 24MB 的独立实例，不复用 searchCache', () => {
    const st = imageCache.getStats()
    expect(st.maxEntries).toBe(500)
    expect(st.maxBytes).toBe(24 * 1024 * 1024)
    expect(imageCache).not.toBe(searchCache)
  })
})

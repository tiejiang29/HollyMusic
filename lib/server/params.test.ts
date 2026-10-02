/**
 * lib/server/params.ts 单元测试
 *
 * 这些参数只决定"一次看多少条"，越界一律收敛而不是报错：老客户端传的奇怪值
 * （1e9、abc、负数、小数）不该换来 500，也不该换来全表拉取。
 */

import { describe, expect, it } from 'vitest'
import { readIntParam } from './params'

const BOUNDS = { def: 100, min: 1, max: 500 }

describe('readIntParam', () => {
  it('未传与空串取缺省值', () => {
    expect(readIntParam(null, BOUNDS)).toBe(100)
    expect(readIntParam('', BOUNDS)).toBe(100)
    expect(readIntParam('   ', BOUNDS)).toBe(100)
  })

  it('非数字取缺省值，而不是把 NaN 交给 Prisma take', () => {
    for (const raw of ['abc', '12abc', '1e', 'Infinity', '-Infinity', 'NaN']) {
      expect(readIntParam(raw, BOUNDS)).toBe(100)
    }
  })

  it.each([
    ['1', 1],
    ['500', 500],
    ['3.0', 3],
    [' 42 ', 42],
    ['+7', 7],
  ])('合法值 %s 原样取用', (raw, expected) => {
    expect(readIntParam(raw, BOUNDS)).toBe(expected)
  })

  it('越界收敛到区间两端', () => {
    expect(readIntParam('1000000', BOUNDS)).toBe(500)
    expect(readIntParam('1e9', BOUNDS)).toBe(500)
    expect(readIntParam('0', BOUNDS)).toBe(1)
    expect(readIntParam('-5', BOUNDS)).toBe(1)
  })

  it('小数向下取整（截断而不是四舍五入）', () => {
    expect(readIntParam('30.9', BOUNDS)).toBe(30)
    expect(readIntParam('-0.5', BOUNDS)).toBe(1) // 先截断成 0，再夹到 min
  })

  it('区间上下限同值时恒定返回该值', () => {
    expect(readIntParam('9', { def: 3, min: 5, max: 5 })).toBe(5)
  })
})

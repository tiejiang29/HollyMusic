/**
 * logger 回归测试。钉住一件很贵的事：Error 必须把原因打出来。
 *
 * 起因：`JSON.stringify(new Error('x'))` === `"{}"`（name/message/stack 都不可枚举），
 * 而仓库里几十处 `logger.error('...', err)` 都这么写 —— 于是 `音源初始化失败: … {}`
 * 这种日志连续几天看不出真正原因。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { logger } from '@/lib/logger'

function capture(spyTarget: 'log' | 'warn' | 'error', run: () => void): string {
  const spy = vi.spyOn(console, spyTarget).mockImplementation(() => {})
  run()
  const out = spy.mock.calls.map(c => String(c[0])).join('\n')
  spy.mockRestore()
  return out
}

describe('logger 参数渲染', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('Error 参数要带 name、message 和首帧，绝不能是 {}', () => {
    const err = new Error('脚本初始化失败')
    err.name = 'SourceInitError'
    const out = capture('error', () => logger.error('音源初始化失败: 聚合API', err))
    expect(out).toContain('SourceInitError: 脚本初始化失败')
    expect(out).not.toMatch(/\{\}/)
  })

  it('Error 子类同样能打出来（注意 name 取自 err.name，子类默认仍是 "Error"）', () => {
    class PrismaLike extends Error {}
    const out = capture('error', () => logger.error('写库失败', new PrismaLike('P2025: 记录不存在')))
    expect(out).toContain('P2025: 记录不存在')
    expect(out).not.toMatch(/\{\}/)
    // 真正带自己 name 的类型（Prisma / 多数库都会显式设）要原样显示
    const named = new PrismaLike('boom')
    named.name = 'PrismaClientKnownRequestError'
    expect(capture('error', () => logger.error('写库失败', named))).toContain('PrismaClientKnownRequestError: boom')
  })

  it('普通对象仍按 JSON 打印（既有调用方靠这个看字段）', () => {
    const out = capture('warn', () => logger.warn('配额', { usedGb: 3.2, quotaGb: 10 }))
    expect(out).toContain('{"usedGb":3.2,"quotaGb":10}')
  })

  it('循环引用不能把日志调用本身炸掉', () => {
    const cyc: Record<string, unknown> = { tag: 'ok' }
    cyc.self = cyc
    expect(() => capture('error', () => logger.error('带环', cyc))).not.toThrow()
  })

  it('非开发环境下 debug 不落输出（生产只留 info 以上，这条口径别被改动带偏）', () => {
    const out = capture('log', () => logger.debug('内部细节', { a: 1 }))
    expect(out).toBe('')
  })

  it('字符串与数字参数原样拼接（logger.info 走的是 console.log，不是 console.info）', () => {
    const out = capture('log', () => logger.info('周测完成', 'manual', 58))
    expect(out).toContain('周测完成 manual 58')
  })
})

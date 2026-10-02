/**
 * logger 回归测试。钉住一件很贵的事：Error 必须把原因打出来。
 *
 * 起因：`JSON.stringify(new Error('x'))` === `"{}"`（name/message/stack 都不可枚举），
 * 而仓库里几十处 `logger.error('...', err)` 都这么写 —— 于是 `音源初始化失败: … {}`
 * 这种日志连续几天看不出真正原因。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { logger, LogLevel, redactRequestUrl } from '@/lib/logger'

// 测试环境里 NODE_ENV≠development，logger 默认只到 INFO；改级别用完后要还原，
// 否则会污染同文件其它用例（其中一条就是钉"debug 不落输出"）
const originalLevel = logger.getLevel()

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

describe('redactRequestUrl（/rest 凭据不进日志）', () => {
  // Subsonic 的 t/s 是一对长期有效的凭据：t = md5(服务端密钥 + s)，没有时效。
  // 打日志时把整条 URL 抄下来 = 把一把能随时重放的钥匙写进明文文件。
  const TOKEN = '9a1b2c3d4e5f60718293a4b5c6d7e8f9'
  const SALT = 's3cr3t-s4lt'
  const url = `http://nas:3099/rest/getStarred2.view?u=admin&t=${TOKEN}&s=${SALT}&musicId=42`

  it('遮掉 t/s，其它参数（含用户名）原样留着', () => {
    const out = redactRequestUrl(url)

    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain(SALT)
    expect(out).toContain('t=***')            // `*` 在 query 值里合法，不会被编码成 %2A
    expect(out).toContain('u=admin')
    expect(out).toContain('musicId=42')
  })

  it('带明文口令 p 的客户端（部分第三方实现会发）同样遮掉', () => {
    expect(redactRequestUrl('http://h/rest/getUser.view?u=admin&p=hunter2'))
      .not.toContain('hunter2')
  })

  it('没有凭据参数时不改写 URL（避免重编码把既有日志格式打乱）', () => {
    const clean = 'http://nas:3099/rest/search3.view?query=%E5%91%A8%E6%9D%B0%E4%BC%A6&count=30'
    expect(redactRequestUrl(clean)).toBe(clean)
  })

  it('URL 对象与字符串两种入参都行；解析不了的原文返回，不把日志调用炸掉', () => {
    expect(redactRequestUrl(new URL(url))).not.toContain(TOKEN)
    expect(redactRequestUrl('/rest/getPing.view?t=abc')).toBe('/rest/getPing.view?t=abc')
    expect(redactRequestUrl('')).toBe('')
  })

  it('logger.debug 打出来的整行里没有凭据（把脱敏和渲染串起来验）', () => {
    logger.setLevel(LogLevel.DEBUG)
    try {
      const out = capture('log', () => logger.debug('[rest] requestUrl:', redactRequestUrl(url)))
      expect(out).not.toContain(TOKEN)
      expect(out).not.toContain(SALT)
    } finally {
      logger.setLevel(originalLevel)
    }
  })
})

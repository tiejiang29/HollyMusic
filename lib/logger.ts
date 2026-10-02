/**
 * 日志管理器
 * 支持不同日志级别，根据环境自动调整
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * 打日志前对请求 URL 脱敏。
 *
 * Subsonic 的 `t`/`s` 是一对长期有效的凭据（`t = md5(服务端密钥 + s)`），**没有时效**，
 * 落进日志文件就等于把一把随时能重放的钥匙留在明文里；`p` 是一些第三方客户端会带的明文口令。
 * 用户名 `u` 不遮——它本来就已经单独打在多处日志里，留着才好对齐"这条请求是谁发的"。
 */
const SECRET_QUERY_KEYS = ['t', 's', 'p']

export function redactRequestUrl(value: string | URL): string {
  const raw = typeof value === 'string' ? value : value.toString()
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    // 拿不到可解析的绝对 URL 就原样返回：脱敏失败不该把日志本身打成异常
    return raw
  }
  let touched = false
  for (const key of SECRET_QUERY_KEYS) {
    if (parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, '***')
      touched = true
    }
  }
  // 没有要遮的东西就原样返回：重新序列化会把 %20 之类改写成 +，白白打乱既有日志格式
  return touched ? parsed.toString() : raw
}

class Logger {
  private level: LogLevel
  private isDevelopment: boolean

  constructor() {
    this.isDevelopment = process.env.NODE_ENV === 'development'
    // 开发模式显示 DEBUG 日志，生产模式显示 INFO 及以上
    this.level = this.isDevelopment ? LogLevel.DEBUG : LogLevel.INFO
  }

  private formatMessage(level: string, message: string, ...args: unknown[]): string {
    const timestamp = new Date().toISOString()
    const argsStr = args.length > 0 ? ' ' + args.map(arg => this.renderArg(arg)).join(' ') : ''
    return `[${timestamp}] [${level}] ${message}${argsStr}`
  }

  /**
   * Error 的 name/message/stack 都是**不可枚举**属性，`JSON.stringify(new Error('x'))` 得到 `"{}"`。
   * 所以此前全仓库几十处 `logger.error('...', err)` 一直在把失败原因打印成空对象
   * ——`音源初始化失败: 聚合API接口 (CF) v3 {}` 排查数日无果，就是这个而不是脚本没报错。
   */
  private renderArg(arg: unknown): string {
    if (arg instanceof Error) {
      const frame = (arg.stack || '').split('\n').slice(1, 3).map(s => s.trim()).join(' <- ')
      return `${arg.name}: ${arg.message}${frame ? `  @ ${frame}` : ''}`
    }
    if (arg !== null && typeof arg === 'object') {
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    }
    return String(arg)
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.level
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.log(this.formatMessage('DEBUG', message, ...args))
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.log(this.formatMessage('INFO', message, ...args))
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(this.formatMessage('WARN', message, ...args))
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error(this.formatMessage('ERROR', message, ...args))
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  getLevel(): LogLevel {
    return this.level
  }
}

// 单例实例
export const logger = new Logger()

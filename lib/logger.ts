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

/**
 * 服务端可变配置的读写（键值，值是 JSON 文本）。
 *
 * 只用来放"管理员在面板上改、又不值得单独建表"的配置。存的东西都是本库明文列，
 * 所以约定写死在这里：**任何要出网的视图都必须过 `maskSecret`**，不许把原值带进
 * GET 响应或日志（见 lib/services/source-discovery.ts 的设置视图口径）。
 */

import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

export async function readSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } })
    if (!row?.value) return fallback
    const parsed = JSON.parse(row.value) as Partial<T>
    // 逐键合并而不是整体替换：老数据缺新加的键时用默认值兜，不丢用户已配的值
    return { ...fallback, ...parsed }
  } catch (err) {
    logger.warn('[settings] 读取配置失败，回落到默认值:', { key, error: err })
    return fallback
  }
}

export async function writeSetting(key: string, value: unknown): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  })
}

/** 脱敏后的凭据尾巴：够管理员认出"是不是那一枚"，不够被当成凭据用 */
export function maskSecret(value: string): string {
  if (!value) return ''
  const tail = value.slice(-4)
  return `****${tail}`
}

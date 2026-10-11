/**
 * 音箱流出口的查询参数读法（从 `app/api/speaker/stream/route.ts` 挪出来的）。
 *
 * 为什么单独一个文件：Next 会对 route 文件生成一份"只许导出 HTTP 处理器"的类型校验，
 * 路由里多导一个工具函数就让 `pnpm build --webpack` 在类型检查那一步红掉
 * （2026-10-11 CI run #61 就是这么挂的：`readParams` is not assignable to type 'never'）。
 */
import { NextRequest } from 'next/server'
import { logger } from '@/lib/logger'

/**
 * 读查询参数，顺手处理"固件把 & 换成空格"。
 *
 * 令牌在第一位，所以空格之后的内容一定是被吞掉的分隔符：`st=<jwt> uid=<x> quality=320k`。
 * JWT 自己不含空格（base64url + '.' + hex），可以按空格安全切开还原。
 */
export function readParams(request: NextRequest): URLSearchParams {
  const raw = new URL(request.url).searchParams
  const token = raw.get('st')
  if (!token || !token.includes(' ')) return raw
  const pieces = token.split(/\s+/)
  const fixed = new URLSearchParams(raw)
  fixed.set('st', pieces[0])
  for (const piece of pieces.slice(1)) {
    const eq = piece.indexOf('=')
    if (eq > 0) fixed.set(piece.slice(0, eq), piece.slice(eq + 1))
  }
  logger.info('[speaker/stream] 还原了被固件改写成分隔符的查询参数')
  return fixed
}

/**
 * `seek=<秒>`：音箱侧没有设备端 seek（2026-10-08 真机实测：重推一条流会让它**从 0 起播**），
 * 所以"拖进度条"只能重推一条从中间开始的地址。坏值一律当 0（不改位置），不做"猜一个"的事。
 */
export function readSeekSec(params: URLSearchParams): number {
  const raw = params.get('seek')
  if (!raw) return 0
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

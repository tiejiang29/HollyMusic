/**
 * 查询参数解析
 *
 * 列表类接口的 limit/offset/page 之前各写各的：有的 clamp 了（stats/song-plays、
 * recent-contexts），有的把 `parseInt` 结果直传 Prisma take —— `limit=1e9` 会变成全表拉取，
 * `limit=abc` 变 NaN 直接 500。这里统一成"越界收敛到安全区间"，而不是报错：
 * 这些参数只影响一次能看多少条，收敛比拒绝更符合调用方意图（老客户端零改动）。
 */

export interface IntParamBounds {
  /** 缺省或非法时用的值 */
  def: number
  min: number
  max: number
}

export function readIntParam(raw: string | null, { def, min, max }: IntParamBounds): number {
  if (raw === null || raw.trim() === '') return def
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return Math.min(Math.max(Math.trunc(n), min), max)
}

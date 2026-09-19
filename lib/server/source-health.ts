/**
 * 音源健康账本（3b：只做观测，不影响任何取址行为）。
 *
 * 为什么需要它：运行时此前对"源可用性"是零记录——瀑布里每个源的成败只进日志（而且
 * 大半是 debug 级，生产根本看不到），成功路径连耗时都不记。于是"哪个源在拖后腿"
 * 只能靠人肉 grep 日志。
 *
 * 键是 `音源名 × 平台`，不是音源整体：一个源对 kw 强、对 tx 弱是常态，`pt` 白名单就是
 * 这个经验的粗粒度手工版。音质维度只记不参与统计——样本太稀疏（实测 600 行新曲库里
 * 只有 1 条声明 flac24bit）。
 *
 * 三条铁律，都是实测换来的：
 * 1. **「没找到 / 不支持」不是「坏了」**。pt 不含该平台、脚本没声明该平台或该音质、
 *    歌曲元数据里没这档、脚本返回空地址 —— 一律不计入失败（只单独计数供人看）。
 *    否则一个版权面窄但音质很好的源会被迅速误判成坏源。
 * 2. **缓存与音乐库命中不入账**。这些路径压根没碰源，记进去会把热门歌刷成 100% 成功
 *    并稀释真实信号。这条是结构性保证：埋点只存在于瀑布和 audio-serve 的 openUpstream
 *    里，两者都只在 miss 路径上被执行。
 * 3. **本机网络故障期间不计坏**。一次 DNS/出口故障会把所有源同时记成超时，等于把它们
 *    一起冤枉掉。audio-serve 抓到 ENOTFOUND / EAI_AGAIN / ECONNREFUSED 这类错误时调
 *    markNetworkOutage()，此后一小段时间内"坏"信号直接丢弃（"好"信号仍记，因为好的
 *    时候一定可信）。
 *
 * 内存为主、不落库：这是分钟级信号，重启清零是可接受的（也正是最干净的紧急回滚）。
 * 持久校准由周测负责，那边才需要落库。
 */

/** 解析段结局。bad 列为准：ok/no-address 不计坏 */
export type ResolveOutcome = 'ok' | 'timeout' | 'error' | 'ssrf' | 'no-address'
/** 字节段结局（唯一能识破"有地址但播不了"的一段） */
export type ByteOutcome = 'audio' | 'fake' | 'http-error' | 'truncated' | 'unverified'

const RESOLVE_BAD: ReadonlySet<ResolveOutcome> = new Set(['timeout', 'error', 'ssrf'])
const BYTE_BAD: ReadonlySet<ByteOutcome> = new Set(['fake', 'http-error', 'truncated'])

/** 每键保留的样本数（滑动窗口） */
const WINDOW = 50
/** 最多多少个 `源×平台` 键；超出按最久未更新淘汰 */
const MAX_KEYS = 256
/** 样本少于此数不下结论（band=no-data），避免一次抖动就定生死 */
const MIN_SAMPLES = 5
/** 网络中断豁免窗口的默认长度 */
const OUTAGE_MS = 60_000
/** 坏样本超过这个时长就过期，不再把源一直挂在 degraded 上 */
const BAD_TTL_MS = 30 * 60 * 1000

interface Sample {
  t: number
  /** 是否算坏（解析段的 timeout/error/ssrf，或字节段的 fake/http-error/truncated） */
  bad: boolean
  /** 解析段耗时（ms），失败样本也可能没有 */
  ms: number | null
  /** 展示用：这次样本的具体结局 */
  kind: string
  /** 展示用：最后一次坏的原因 */
  reason?: string
}

interface KeyState {
  samples: Sample[]
  /** 不计坏的信息量：能力/版权不符的次数 */
  noMatch: number
  /** 字节段确认是真音频的次数（跨窗口累计，用于"这个源出货是否真的能播"） */
  byteOk: number
  byteUnverified: number
  lastTouchedAt: number
}

export interface SourceHealthView {
  source: string
  platform: string
  /** 窗口内样本数 */
  samples: number
  /** 窗口内坏样本数 */
  bad: number
  /** 解析段出货数（拿到地址） */
  resolveOk: number
  /** 窗口内坏样本的结局分布，如 { timeout: 2, fake: 1 } */
  badKinds: Record<string, number>
  /** 不计坏的"能力/版权不符"次数 */
  noMatch: number
  byteOk: number
  byteUnverified: number
  consecutiveBad: number
  latencyP50Ms: number | null
  latencyP90Ms: number | null
  /** 最后一次坏的原因（给人看的） */
  lastBadReason: string | null
  lastBadAt: number | null
  lastOkAt: number | null
  /**
   * 分档而非连续打分：可解释、抗抖动，且方便下一步（3c）直接按档动作。
   * no-data: 样本不足；healthy: 无近期坏；degraded: 窗口内有零星坏；
   * cooling: 连续坏达到阈值（3c 会在此档跳过该源，本档目前只展示）
   */
  band: 'no-data' | 'healthy' | 'degraded' | 'cooling'
}

/** 我们自己 abort 的 stall 超时不算本机故障，故不含 ABORT_ERR */
const NETWORK_FAULT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOENT_NETWORK'])
const NETWORK_FAULT_MESSAGES = ['getaddrinfo', 'Unable to resolve', 'network unreachable', 'No such host is known']

class SourceHealthLedger {
  private states = new Map<string, KeyState>()
  /** 网络中断豁免的截止时间戳；Date.now() 小于它时不记"坏" */
  private outageUntil = 0

  private key(source: string, platform: string): string {
    return `${source}\u0000${platform}`
  }

  private touch(source: string, platform: string): KeyState {
    const k = this.key(source, platform)
    let st = this.states.get(k)
    if (!st) {
      st = { samples: [], noMatch: 0, byteOk: 0, byteUnverified: 0, lastTouchedAt: 0 }
      this.states.set(k, st)
      this.evictIfNeeded()
    }
    st.lastTouchedAt = Date.now()
    return st
  }

  /** 键数封顶：按最久未更新淘汰，防止音源名/平台异常膨胀吃内存 */
  private evictIfNeeded(): void {
    if (this.states.size <= MAX_KEYS) return
    const victims = [...this.states.entries()]
      .sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt)
      .slice(0, this.states.size - MAX_KEYS)
    for (const [k] of victims) this.states.delete(k)
  }

  /** 解析段：一次 (源×平台) 的取址尝试结局。ms 为该次调用耗时 */
  recordResolve(source: string, platform: string, outcome: ResolveOutcome, ms: number | null, reason?: string): void {
    if (!source) return
    // 能力/版权不符：单独计数，不进样本窗，否则好源会被误判
    if (outcome === 'no-address') {
      this.touch(source, platform).noMatch++
      return
    }
    const bad = RESOLVE_BAD.has(outcome)
    // 豁免期内不记坏；早退发生在建键之前，所以不会留下 0 样本的空键污染快照
    if (bad && this.inOutage()) return
    this.push(this.touch(source, platform), { t: Date.now(), bad, ms, kind: outcome, reason })
  }

  /**
   * 字节段：audio-serve 真拉过首块之后的判定。
   * 这是唯一能识破"HTTP 200 但内容是 HTML 错误页"的一段，证据强度最高。
   */
  recordByte(source: string, platform: string, outcome: ByteOutcome, reason?: string): void {
    if (!source) return
    const bad = BYTE_BAD.has(outcome)
    if (bad && this.inOutage()) return
    const st = this.touch(source, platform)
    if (outcome === 'audio') {
      st.byteOk++
    } else if (outcome === 'unverified') {
      // 既不肯定也不否定：只计数，不进窗口，免得污染分档
      st.byteUnverified++
      return
    }
    this.push(st, { t: Date.now(), bad, ms: null, kind: `byte:${outcome}`, reason })
  }

  private push(st: KeyState, s: Sample): void {
    st.samples.push(s)
    if (st.samples.length > WINDOW) st.samples.shift()
  }

  /** 本机网络疑似故障：此后 OUTAGE_MS 内不记坏。返回是否真的进入了豁免窗 */
  markNetworkOutage(ms = OUTAGE_MS): boolean {
    const until = Date.now() + ms
    const changed = until > this.outageUntil
    this.outageUntil = Math.max(this.outageUntil, until)
    return changed
  }

  private inOutage(): boolean {
    return Date.now() < this.outageUntil
  }

  /**
   * 分档（3b 只用于展示；3c 才按档动作）。
   * cooling 只看"窗口末尾连续坏"，不看比例：实测一次挂起就毁掉一整首歌，
   * 连续三次坏再跳过去已经太晚，但样本不足时又绝不能下结论。
   */
  private bandOf(sampleCount: number, consecutiveBad: number, lastBadAt: number | null, now: number): SourceHealthView['band'] {
    if (sampleCount < MIN_SAMPLES) return 'no-data'
    if (consecutiveBad >= 3) return 'cooling'
    if (lastBadAt !== null && now - lastBadAt < BAD_TTL_MS) return 'degraded'
    return 'healthy'
  }

  private percentile(values: number[], p: number): number | null {
    if (values.length === 0) return null
    const sorted = [...values].sort((a, b) => a - b)
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
    return sorted[idx]
  }

  view(source: string, platform: string): SourceHealthView | null {
    const st = this.states.get(this.key(source, platform))
    if (!st) return null
    return this.toView(source, platform, st)
  }

  /** 某个音源在各平台上的视图（供 /api/health 按源挂载） */
  ofSource(source: string): SourceHealthView[] {
    return this.snapshot().filter(v => v.source === source)
  }

  /** 全量快照，按 (band 严重度, 坏样本数) 排好，便于面板与日志直接展示 */
  snapshot(): SourceHealthView[] {
    const views: SourceHealthView[] = []
    for (const [k, st] of this.states) {
      const [source, platform] = k.split('\u0000')
      views.push(this.toView(source, platform, st))
    }
    const rank: Record<SourceHealthView['band'], number> = { cooling: 0, degraded: 1, 'no-data': 2, healthy: 3 }
    return views.sort((a, b) => (rank[a.band] - rank[b.band]) || (b.bad - a.bad) || a.source.localeCompare(b.source))
  }

  private toView(source: string, platform: string, st: KeyState): SourceHealthView {
    const now = Date.now()
    const badKinds: Record<string, number> = {}
    let bad = 0
    let resolveOk = 0
    let lastBadAt: number | null = null
    let lastBadReason: string | null = null
    let lastOkAt: number | null = null
    for (const s of st.samples) {
      if (s.bad) {
        bad++
        badKinds[s.kind] = (badKinds[s.kind] || 0) + 1
        if (lastBadAt === null || s.t > lastBadAt) {
          lastBadAt = s.t
          lastBadReason = s.reason || s.kind
        }
      } else {
        if (s.kind === 'ok') resolveOk++
        if (lastOkAt === null || s.t > lastOkAt) lastOkAt = s.t
      }
    }
    // 窗口末尾连续坏：从最后一条往前数，遇到非坏样本即停
    let consecutiveBad = 0
    for (let i = st.samples.length - 1; i >= 0 && st.samples[i].bad; i--) consecutiveBad++

    const ms = st.samples.map(s => s.ms).filter((v): v is number => typeof v === 'number')
    return {
      source,
      platform,
      samples: st.samples.length,
      bad,
      resolveOk,
      badKinds,
      noMatch: st.noMatch,
      byteOk: st.byteOk,
      byteUnverified: st.byteUnverified,
      consecutiveBad,
      latencyP50Ms: this.percentile(ms, 0.5),
      latencyP90Ms: this.percentile(ms, 0.9),
      lastBadReason,
      lastBadAt,
      lastOkAt,
      band: this.bandOf(st.samples.length, consecutiveBad, lastBadAt, now),
    }
  }

  /** 仅供单测与"配置热重载后清零"使用 */
  reset(): void {
    this.states.clear()
    this.outageUntil = 0
  }
}

/**
 * 判断一次 fetch 失败是不是"本机/出口"的问题，而不是音源的问题。
 *
 * 只有 DNS 解析失败、连不上、连接被重置这类才算——它们发生时所有源都会同时失败，
 * 若照样记坏，一次断网就能把全部音源一起冤枉掉（实测护栏之一）。
 * 我们自己 abort 的 stall 超时不在此列，那是源真的没在传数据。
 */
export function isLikelyLocalNetworkFault(err: unknown): boolean {
  let cur: unknown = err
  for (let depth = 0; cur != null && depth < 4; depth++) {
    const code = (cur as { code?: string; errno?: string }).code
    if (typeof code === 'string' && NETWORK_FAULT_CODES.has(code)) return true
    const msg = cur instanceof Error ? cur.message : String(cur)
    if (NETWORK_FAULT_MESSAGES.some(m => msg.includes(m))) return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

export const sourceHealth = new SourceHealthLedger()

/**
 * 音源健康账本（3b 观测 → 3c 起会动作：瀑布按本账本临时跳过冷却中的源）。
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
 * 冷却参数（连续 2 次坏 / 快速失败 60s / 挂起 5min / 半开失败翻倍上限 30min）不是拍的，
 * 来自全矩阵摸底实测 62 格（两轮）：0 次取址超时，坏样 p50 1031ms / max 2224ms，健康源
 * 取址 p50 0-1860ms、单次成功最大 4558ms。所以「坏」的主流形态是快速报错与死链，不是挂起；
 * 也因此不按延迟分位数熔断——那会砍掉唯一支持 mg 的两个源里较慢的那个。
 *
 * 内存为主、不落库：这是分钟级信号，重启清零是可接受的（也正是最干净的紧急回滚，
 * 以及 3c 的冷却态在冷启动时一律不成立）。持久校准由周测负责，那边才需要落库。
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
/** 样本少于此数时「波动/正常」不作结论（band=no-data），避免一次抖动就定性 */
const MIN_SAMPLES = 5
/** 网络中断豁免窗口的默认长度 */
const OUTAGE_MS = 60_000
/** 坏样本超过这个时长就过期，不再把源一直挂在 degraded 上；同时是冷却翻倍的上限 */
const BAD_TTL_MS = 30 * 60 * 1000
/** 连续坏达到这个数就进冷却窗（3c 在此档跳过该源）。不设 MIN_SAMPLES 门槛：跨歌
 *  连续两次全坏本身就是强证据，等满 5 个样本意味着死源在头几首歌上每首都烧掉 8s 预算 */
const COOLING_TRIP = 2
/** 快速失败类坏（脚本报错 / 假地址 / ssrf）的冷却基时长 */
const COOL_BASE_FAST_MS = 60_000
/** 挂起类坏的冷却基时长：取址超时，以及字节段 stall 中断（同一种"上游不给数据"） */
const COOL_BASE_HANG_MS = 5 * 60_000
const HANG_KINDS: ReadonlySet<string> = new Set(['timeout', 'byte:truncated'])
/**
 * 半开探测的租约时长。探测请求若在记账之前就异常退出（总预算到点、进程被掐），
 * 槽位靠这个时限自动释放，否则该源会被永久锁在"有人在测"的状态。
 */
const PROBE_LEASE_MS = 60_000

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
  /** 冷却截止时刻；0 = 未在冷却。到期后放一次半开探测，不直接恢复 */
  coolUntil: number
  /** 半开探测在途的起始时刻；null = 无探测占用槽位 */
  probeStartedAt: number | null
  /** 已翻倍次数（半开失败一次 +1），决定冷却时长 = 基时长 × 2^n，上限 BAD_TTL_MS */
  backoffs: number
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
  /** 冷却截止时刻（0 = 未冷却）。3c 的跳过依据就是这个字段 */
  coolingUntil: number
  /** 仍在冷却时距离半开还有多少毫秒 */
  retryAfterMs: number
  /** 半开探测槽位被占用中（其它请求据此继续跳过） */
  probing: boolean
  /** 冷却时长已翻倍几次 */
  backoffs: number
  /**
   * 分档而非连续打分：可解释、抗抖动，且方便下一步直接按档动作。
   * no-data: 样本不足；healthy: 无近期坏；degraded: 窗口内有零星坏；
   * cooling: 连续坏达到阈值 —— 3c 在此档跳过该源（排序不变，冷却到期放一次半开）
   */
  band: 'no-data' | 'healthy' | 'degraded' | 'cooling'
}

/**
 * 「这首歌真没有」类文案 → 记 no-address（不计坏）的判据。
 *
 * 为什么必须有：很多音源脚本对"没有版权/没有该版本"不是返回空地址，而是**抛错**
 * （`播放地址解析失败`、`所有后端均失败…无数据`、`Failed to get audio URL at all quality
 * levels`）。全矩阵摸底实测过：NAS 上按播放量选出的两首 kg 基准曲，7 个源里 6 个都这样抛错
 * ——那是样本没版权，不是源坏了，却被记成坏证据。真实播放路径同理：用户连点两首冷门歌，
 * 就能把一个只是没版权的好源推进冷却。
 *
 * 刻意**不收**的一类：`服务端返回非 JSON 数据`、`get url failed` 这类**传输层**失败。
 * 它们说的是"这次请求没谈拢"，不是"这首歌没有"——HYWmusic 在 NAS 首批里 8/8 报前者，
 * 30 分钟后同一容器同一请求 8/8 正常，正是需要被记坏的那种抖动。
 *
 * 残余风险（已知、先不处理）：一个源若对所有歌都回"无数据"，就再也不会被记坏。
 * 缓解是 noMatch 计数在面板上可见（长期高 noMatch 一眼能看出来），而不是靠熔断。
 */
const CONTENT_MISS_PATTERNS: readonly RegExp[] = [
  /无数据/, /没有(找到|相关)/, /未找到/, /无版权/, /暂无/, /需要\s*vip/i, /无该?音质/, /不支持的?(歌曲|音质)/,
  /播放地址解析失败/, /all quality levels/i, /no\s+(such\s+)?(track|song|result)/i, /not\s+found/i,
]

/** 传输层/协议类失败：无论消息里还带什么词，都算坏（优先级高于上面的白名单） */
const TRANSPORT_FAIL_PATTERNS: readonly RegExp[] = [
  /非\s*JSON/, /解析\s*(响应|JSON)/i, /超时/, /timeout/i, /(返回|响应)\s*(码|status)?\s*[45]\d\d/, /\b[45]\d\d\s+(bad|forbidden|unauthor)/i,
  /get url failed/i, /请求失败/, /网络/, /ECONN/i, /限流/, /频繁/,
]

/** 一次抛错是"这首歌真没有"（true）还是"源这次不行"（false） */
export function isContentMiss(message: string | null | undefined): boolean {
  if (!message) return false
  if (TRANSPORT_FAIL_PATTERNS.some(re => re.test(message))) return false
  return CONTENT_MISS_PATTERNS.some(re => re.test(message))
}

/** 我们自己 abort 的 stall 超时不算本机故障，故不含 ABORT_ERR */
const NETWORK_FAULT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOENT_NETWORK'])
const NETWORK_FAULT_MESSAGES = ['getaddrinfo', 'Unable to resolve', 'network unreachable', 'No such host is known']

/**
 * 冷却基时长看"这一串连续坏"里最恶劣的那种：掺了挂起（取址超时 / 字节段 stall 中断）
 * 就按 5min，全是快速失败按 60s。理由是两者对用户的影响不同——快速失败只浪费 1-2s，
 * 挂起会把单源预算 8s 整个烧掉。
 */
function coolBaseMs(samples: Sample[]): number {
  for (let i = samples.length - 1; i >= 0 && samples[i].bad; i--) {
    if (HANG_KINDS.has(samples[i].kind)) return COOL_BASE_HANG_MS
  }
  return COOL_BASE_FAST_MS
}

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
      st = {
        samples: [], noMatch: 0, byteOk: 0, byteUnverified: 0, lastTouchedAt: 0,
        coolUntil: 0, probeStartedAt: null, backoffs: 0,
      }
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
      const st = this.touch(source, platform)
      st.noMatch++
      // 半开探测即使「没搜到」也算走完了，槽位必须释放，否则要空等一个租约期
      st.probeStartedAt = null
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
      st.probeStartedAt = null
      return
    }
    this.push(st, { t: Date.now(), bad, ms: null, kind: `byte:${outcome}`, reason })
  }

  private push(st: KeyState, s: Sample): void {
    st.samples.push(s)
    if (st.samples.length > WINDOW) st.samples.shift()
    const now = s.t
    // 只有租约仍在期内的探测才算「半开失败」；过期租约是探测请求自己中途死了，
    // 不能拿它去翻倍冷却，否则一次异常退出会让源多罚一整轮
    const wasProbing = st.probeStartedAt !== null && now - st.probeStartedAt < PROBE_LEASE_MS
    st.probeStartedAt = null

    if (!s.bad) {
      // 一次成功就把冷却与翻倍全部清零：3c 要的是"现在能用"，不是"历史清白"
      st.coolUntil = 0
      st.backoffs = 0
      return
    }
    let consecutiveBad = 0
    for (let i = st.samples.length - 1; i >= 0 && st.samples[i].bad; i--) consecutiveBad++

    if (wasProbing || consecutiveBad >= COOLING_TRIP) {
      // 半开失败（wasProbing）不要求攒满连续次数：刚试过就不行，直接进下一轮冷却
      const mult = wasProbing ? st.backoffs + 1 : 0
      st.backoffs = mult
      st.coolUntil = now + Math.min(coolBaseMs(st.samples) * 2 ** mult, BAD_TTL_MS)
    }
  }

  /**
   * 只读：这个 `源×平台` 现在该不该被跳过。3c 的瀑布据此换下一个源，
   * 不放行时也不产生任何副作用——占用半开槽位要另外调 claimProbe。
   */
  coolStatus(source: string, platform: string): { skip: boolean; retryAfterMs: number; cooling: boolean } {
    const st = this.states.get(this.key(source, platform))
    if (!st || !st.coolUntil) return { skip: false, retryAfterMs: 0, cooling: false }
    const now = Date.now()
    if (now < st.coolUntil) return { skip: true, retryAfterMs: st.coolUntil - now, cooling: true }
    if (st.probeStartedAt !== null && now - st.probeStartedAt < PROBE_LEASE_MS) {
      return { skip: true, retryAfterMs: PROBE_LEASE_MS - (now - st.probeStartedAt), cooling: true }
    }
    // 冷却到期且无人占槽 → 允许放行一次，由调用方 claimProbe 占位
    return { skip: false, retryAfterMs: 0, cooling: true }
  }

  /** 占用半开探测槽位（冷却已到期且无人占用才成功） */
  claimProbe(source: string, platform: string): boolean {
    const st = this.states.get(this.key(source, platform))
    if (!st || !st.coolUntil) return false
    const now = Date.now()
    if (now < st.coolUntil) return false
    if (st.probeStartedAt !== null && now - st.probeStartedAt < PROBE_LEASE_MS) return false
    st.probeStartedAt = now
    return true
  }

  /**
   * 用外部证据（周测）注入冷却先验，让刚重启、账本全空的进程也知道"上次主动探测说这格是坏的"。
   *
   * 只设冷却 + 一条标明出处的坏样本，不伪造成功样本：真实流量的证据必须是自己的，否则面板上
   * "窗口 N 次：出货 x"就成了假数。到期后照常放半开，一次真实成功即彻底恢复——先验判错最多
   * 浪费一首歌。已经有实测冷却在跑时不覆盖（先验不该比实测更悲观）。
   */
  seedCooldown(source: string, platform: string, opts: { hangLike: boolean; reason: string }): void {
    if (!source || this.inOutage()) return
    const st = this.touch(source, platform)
    const now = Date.now()
    if (st.coolUntil > now) return
    this.push(st, { t: now, bad: true, ms: null, kind: 'probe-inherited', reason: opts.reason })
    st.coolUntil = now + (opts.hangLike ? COOL_BASE_HANG_MS : COOL_BASE_FAST_MS)
    st.backoffs = 0
    st.probeStartedAt = null
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
   * 分档。cooling 直接由状态机给出（与 3c 的跳过判据同源，避免两处判断漂移）；
   * 其余档位在样本不足时不下结论。
   */
  private bandOf(st: KeyState, sampleCount: number, lastBadAt: number | null, now: number): SourceHealthView['band'] {
    if (st.coolUntil > now) return 'cooling'
    if (sampleCount < MIN_SAMPLES) return 'no-data'
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
    const probing = st.probeStartedAt !== null && now - st.probeStartedAt < PROBE_LEASE_MS
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
      coolingUntil: st.coolUntil,
      retryAfterMs: st.coolUntil > now ? st.coolUntil - now : 0,
      probing,
      backoffs: st.backoffs,
      band: this.bandOf(st, st.samples.length, lastBadAt, now),
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

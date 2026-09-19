/**
 * 音源管理服务
 * 管理多个 LXEnvironmentSimulator 实例，提供智能 URL 获取
 * 支持配置文件热重载
 */

import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import type { MusicInfo, QualityType, HealthStatus, SourceInfo } from './types/music'
import { ConfigValidator } from './config-validator'
import { logger } from './logger'
import { decodeLyricEntities } from './server/lyric-decode'
import { normalizeStructuredLyricText } from './server/lyric-normalize'
import { findBestAlternative } from './services/source-toggle'
import { sourceHealth, type ResolveOutcome } from './server/source-health'

/** 换源元信息：本次取址发生跨平台自动换源时填充，供 API 层透出给前端展示 */
export interface SourceToggleInfo {
  from: string
  to: string
  name: string
  singer: string
}

// 音源执行托管在独立子进程（vm 沙箱之上叠加进程隔离，见 lib/music-core/runner-client.js）
// SOURCE_RUNNER_MODE=inline 可回退主进程直连（等价 P0 行为）
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getSourceRunner } = require('./music-core/runner-client')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { blockedNetworkReason } = require('./music-core/sandbox')

/**
 * 校验音源返回的 URL 必须是公网 http(s) 地址。
 * 恶意脚本可返回内网 URL 借服务端回源请求（SSRF），此处统一拒绝。
 */
function isTrustworthyUrl(url: string): boolean {
  return blockedNetworkReason(url) === null
}

/** 音源 slot 代理（子进程或 inline 直连），使用面与 LXEnvironmentSimulator 对齐 */
interface SourceSlot {
  loadScript(scriptPath: string): Promise<SourceInfo>
  getMusicUrl(source: string, musicInfo: MusicInfo, quality?: string): Promise<string>
  getLyric(source: string, musicInfo: MusicInfo): Promise<unknown>
  getPic(...args: unknown[]): Promise<unknown>
  dispose?(): Promise<void> | void
}

export interface SimulatorInstance {
  simulator: SourceSlot
  config: {
    name: string
    priority: number
    enabled: boolean
    timeout?: number
    pt?: string[] // 用户声明的支持平台，优先于脚本 sourceInfo 用于过滤
  }
  initialized: boolean
  initTime?: number
  sourceInfo?: SourceInfo
  error?: string
}

/**
 * 计算文件的 MD5 哈希值
 */
function getFileHash(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    return crypto.createHash('md5').update(content).digest('hex')
  } catch {
    return null
  }
}

/**
 * 从音源返回值中提取歌词。
 * 兼容两种返回：
 *  - 字符串（直接作 lyric）
 *  - 对象 { lyric, tlyric, rlyric, lxlyric }（LX 音源标准结构）
 */
function extractLyric(result: unknown): { lyric: string; tlyric: string | null } | null {
  if (!result) return null
  if (typeof result === 'string') {
    // 部分音源返回 HTML 实体编码歌词（&#x660E; 等），归一化时统一解码
    const s = normalizeStructuredLyricText(decodeLyricEntities(result.trim()))
    return s ? { lyric: s, tlyric: null } : null
  }
  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>
    const lyric = obj.lyric != null ? normalizeStructuredLyricText(decodeLyricEntities(String(obj.lyric).trim())) : ''
    if (!lyric) return null
    const tlyricRaw = obj.tlyric != null ? normalizeStructuredLyricText(decodeLyricEntities(String(obj.tlyric).trim())) : ''
    return { lyric, tlyric: tlyricRaw || null }
  }
  return null
}

/**
 * 取址瀑布的三级预算。必须满足两条关系：
 *
 *   perSourceMs < totalMs < audio-serve 的外层解析预算（AUDIO_CACHE_READINESS_TIMEOUT_MS，默认 20s）
 *
 * 第二条最要命：总预算一旦超过外层，外层先 reject，客户端拿到的是 502 READINESS_TIMEOUT，
 * 而不是"瀑布真的试完了"的结论。实测（HANDOFF 2026-09-19 摸底）旧值"单次 15s / 总 45s"
 * 对外层 20s —— 一个挂起的头源能在多个音质档上各烧满 15s 吃满全程，只要它挂了这首歌必然
 * 播不出来，排在后面的可用源一次都轮不到。perSourceMs 就是堵这一格的：一个源在这首歌上
 * 累计花完它就换下一个源。
 *
 * urlMs 只是单次调用的上限，实际取值会被夹到"本源/全程剩余预算"以内，允许大于 perSourceMs。
 */
export interface UrlBudgets {
  /** 单次 getMusicUrl 调用的上限 */
  urlMs: number
  /** 同一个源在一首歌上的累计上限（跨音质档位累加） */
  perSourceMs: number
  /** 整条瀑布（所有源×所有音质）的总上限 */
  totalMs: number
}

/**
 * 一次尝试值得花的最小剩余预算。低于它就直接换源：给 0-2ms 的"尘埃调用"既不可能出货，
 * 又会把一次真实脚本调用丢进 runner —— 我们放弃了它的 promise，slot 却还占着。
 * 也顺带消除了"定时器在预算边界前一瞬触发导致同一个源被多调一次"的抖动。
 */
const MIN_USEFUL_ATTEMPT_MS = 250

function readBudget(envVar: string, fallback: number): number {
  const raw = process.env[envVar]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : fallback
}

export function readUrlBudgets(): UrlBudgets {
  const budgets: UrlBudgets = {
    urlMs: readBudget('SOURCE_URL_TIMEOUT_MS', 15_000),
    perSourceMs: readBudget('SOURCE_URL_PER_SOURCE_TIMEOUT_MS', 8_000),
    totalMs: readBudget('SOURCE_URL_TOTAL_TIMEOUT_MS', 18_000),
  }
  // 预算配歪了不会报错、只会悄悄让后面的源轮不到，所以这里显式提醒一次
  if (budgets.perSourceMs >= budgets.totalMs) {
    logger.warn(
      `[source-budget] 单源预算 ${budgets.perSourceMs}ms ≥ 总预算 ${budgets.totalMs}ms，` +
      '一条瀑布只够试一个音源，降级链会失效（SOURCE_URL_PER_SOURCE_TIMEOUT_MS / SOURCE_URL_TOTAL_TIMEOUT_MS）'
    )
  }
  return budgets
}

export class MusicSourceManager {
  private instances: SimulatorInstance[] = []
  private initialized: boolean = false
  private configPath: string = ''
  private configHash: string | null = null
  // 简单内存缓存，降低重复请求频率
  private lyricCache: Map<string, { value: { lyric: string; tlyric: string | null }; expires: number }> = new Map()
  private picCache: Map<string, { value: Buffer | string; expires: number }> = new Map()
  private defaultCacheTtl = 60 * 60 * 1000 // 1 hour
  /** 取址瀑布预算（见 UrlBudgets 的三级关系） */
  private budgets: UrlBudgets = readUrlBudgets()

  /** 给 Promise 加超时的通用辅助（超时后 reject，定时器清理） */
  private async withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null
    try {
      return await Promise.race([
        p,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label}（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 检测配置文件是否改变
   */
  private checkConfigChanged(): boolean {
    const configPath = path.resolve(process.cwd(), 'config/music-sources.json')
    const currentHash = getFileHash(configPath)
    
    if (currentHash === null) {
      logger.warn('无法读取配置文件 hash')
      return false
    }

    const changed = this.configHash !== currentHash
    if (changed) {
      logger.info('检测到配置文件变更，将重新加载')
      this.configHash = currentHash
    }
    return changed
  }

  /**
   * 重置实例（先释放旧 slot 的沙箱资源避免孤儿定时器，再清空重建）
   */
  private resetInstances(): void {
    for (const instance of this.instances) {
      try {
        instance.simulator.dispose?.()
      } catch {}
    }
    this.instances = []
    this.initialized = false
  }

  private initPromise: Promise<void> | null = null

  /**
   * 初始化音源管理器
   * 多次并发调用会复用同一个初始化 Promise，避免重复加载脚本
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.debug('音源管理器已初始化')
      return
    }
    if (this.initPromise) {
      return this.initPromise
    }
    this.initPromise = this.doInitialize().finally(() => {
      this.initPromise = null
    })
    return this.initPromise
  }

  /**
   * 强制重建所有音源实例。
   * 供管理端 CRUD（增删改配置）后主动调用，使改动立即生效，
   * 无需等待下次播放/歌词/封面请求触发 MD5 懒重载。
   */
  async reload(): Promise<void> {
    logger.info('触发音源实例重建（管理端 CRUD）...')
    this.resetInstances()
    await this.initialize()
  }

  /**
   * 配置文件有变更（MD5 对比）时才重建实例；无变化时零开销。
   * 供 health 等读状态入口刷新内存态，避免展示过期配置。
   */
  async ensureFresh(): Promise<void> {
    if (this.initialized && this.checkConfigChanged()) {
      logger.info('配置文件已变更，重新加载音源...')
      this.resetInstances()
    }
    if (!this.initialized) {
      await this.initialize()
    }
  }

  private async doInitialize(): Promise<void> {
    logger.info('开始初始化音源管理器...')

    // 读取配置文件
    const configPath = path.resolve(process.cwd(), 'config/music-sources.json')
    this.configPath = configPath
    this.configHash = getFileHash(configPath)
    
    let config

    try {
      config = ConfigValidator.loadConfig(configPath)
      logger.info(`加载配置文件成功，找到 ${config.sources.length} 个音源`)
    } catch (error) {
      // 配置文件缺失（首次部署/空 config 目录）按空配置处理，不阻断启动；
      // 其余错误（JSON 解析失败等）仍抛出
      const errMsg = error instanceof Error ? error.message : String(error)
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || /配置文件不存在/.test(errMsg)) {
        logger.warn(`配置文件不存在（${configPath}），按空配置启动`)
        config = { sources: [] }
      } else {
        logger.error('加载配置文件失败:', error)
        throw error
      }
    }

    // 过滤已启用的音源并按优先级排序
    const enabledSources = config.sources
      .filter(s => s.enabled)
      .sort((a, b) => a.priority - b.priority)

    logger.info(`已启用 ${enabledSources.length} 个音源`)

    // 初始化每个音源
    for (const sourceConfig of enabledSources) {
      const startTime = Date.now()
      const instance: SimulatorInstance = {
        simulator: await getSourceRunner().acquireSlot(),
        config: {
          name: sourceConfig.name || sourceConfig.path,
          priority: sourceConfig.priority,
          enabled: sourceConfig.enabled,
          timeout: sourceConfig.timeout,
          pt: sourceConfig.pt,
        },
        initialized: false,
      }

      try {
        const scriptPath = path.resolve(process.cwd(), sourceConfig.path)
        logger.debug(`初始化音源: ${instance.config.name} (${scriptPath})`)

        const sourceInfo = await instance.simulator.loadScript(scriptPath)
        
        instance.initialized = true
        instance.initTime = Date.now() - startTime
        instance.sourceInfo = sourceInfo

        const supportedSources = Object.keys(sourceInfo.sources).join(', ')
        logger.info(
          `音源初始化成功: ${instance.config.name} ` +
          `[${instance.initTime}ms] 支持: ${supportedSources}`
        )

        this.instances.push(instance)
      } catch (error) {
        instance.error = error instanceof Error ? error.message : String(error)
        logger.error(`音源初始化失败: ${instance.config.name}`, error)
        
        // 不阻塞其他音源的初始化
        this.instances.push(instance)
      }
    }

    const successCount = this.instances.filter(i => i.initialized).length
    logger.info(`音源管理器初始化完成，成功: ${successCount}/${this.instances.length}`)

    this.initialized = true
  }

  /**
   * 获取音乐 URL（智能降级 + 跨平台自动换源）
   * 依次尝试所有音源，支持音质降级；全部失败后按歌名/歌手/时长
   * 在其他平台找同款歌曲重试一次（换源结果带缓存）。
   * @param ctx 可选上下文：发生换源时写入 toggle 字段，供上层展示
   */
  async getMusicUrl(
    musicInfo: MusicInfo,
    requestedQuality: QualityType = '320k',
    ctx?: { toggle?: SourceToggleInfo | null }
  ): Promise<string> {
    return (await this.getMusicUrlWithProvider(musicInfo, requestedQuality, ctx)).url
  }

  /**
   * 同 getMusicUrl，但同时回传命中的音源名（provider）。
   *
   * 用途：调用方（audio-serve）在下载阶段发现上游返回的是 HTML/JSON 假地址时，
   * 需要知道「是哪个音源给的」，才能把它排除后重新解析（见 excludeProviders）。
   */
  async getMusicUrlWithProvider(
    musicInfo: MusicInfo,
    requestedQuality: QualityType = '320k',
    ctx?: { toggle?: SourceToggleInfo | null; excludeProviders?: ReadonlySet<string> }
  ): Promise<{ url: string; provider: string | null; platform: string | null }> {
    try {
      return await this._getMusicUrlSamePlatform(
        musicInfo,
        requestedQuality,
        ctx?.excludeProviders
      )
    } catch (err) {
      // 同平台全部失败 → 尝试跨平台换源（仅一次，替代版本失败不再递归）
      if (!musicInfo.name) throw err
      logger.warn(
        `[source-toggle] ${musicInfo.source} 平台全失败（${musicInfo.name}），尝试跨平台换源...`
      )
      const alternative = await findBestAlternative(musicInfo)
      if (!alternative) throw err
      const result = await this._getMusicUrlSamePlatform(
        alternative,
        requestedQuality,
        ctx?.excludeProviders
      )
      if (ctx) {
        ctx.toggle = {
          from: musicInfo.source,
          to: alternative.source,
          name: alternative.name,
          singer: alternative.singer,
        }
      }
      return result
    }
  }

  /**
   * 获取音乐 URL（智能降级）——原同平台瀑布逻辑
   * 依次尝试所有音源，支持音质降级
   * 支持配置文件热重载
   * @param excludeProviders 需跳过的音源名（上层已证实其返回假地址，见 audio-serve）
   */
  private async _getMusicUrlSamePlatform(
    musicInfo: MusicInfo,
    requestedQuality: QualityType = '320k',
    excludeProviders?: ReadonlySet<string>
  ): Promise<{ url: string; provider: string | null; platform: string | null }> {
    // 在获取 URL 时检查配置是否变更
    if (this.initialized && this.checkConfigChanged()) {
      logger.info('配置文件已变更，重新加载音源...')
      this.resetInstances()
    }

    if (!this.initialized) {
      await this.initialize()
    }

    let availableInstances = this.instances.filter(i => i.initialized)

    // 如果当前没有可用实例，尝试重新加载配置并初始化一次
    if (availableInstances.length === 0) {
      logger.warn('当前没有已初始化的音源，尝试重新加载配置并初始化...')
      this.resetInstances()
      await this.initialize()

      availableInstances = this.instances.filter(i => i.initialized)
      if (availableInstances.length === 0) {
        throw new Error('没有可用的音源')
      }
    }

    // 音质降级顺序
    const qualityFallback: QualityType[] = ['flac24bit', 'flac', '320k', '128k']
    const startIndex = qualityFallback.indexOf(requestedQuality)
    const qualitiesToTry = startIndex >= 0 
      ? qualityFallback.slice(startIndex)
      : [requestedQuality, ...qualityFallback]

    logger.debug(`获取音乐URL: ${musicInfo.name} - ${musicInfo.singer}`)
    logger.debug(`音源: ${musicInfo.source}, 请求音质: ${requestedQuality}`)

    // 总预算：全音源×音质尝试不无限串行（上游全挂时限制客户端等待时间）
    const deadline = Date.now() + this.budgets.totalMs

    // 候选源：pt 白名单 + 脚本声明 + musicUrl 能力 + 上层排除，四道门槛一次过完。
    // 必须先拿到完整候选集，3c 才知道"跳掉冷却中的源之后还剩不剩人"。
    const candidates = this.eligibleFor(availableInstances, musicInfo.source, excludeProviders)

    // 3c：跳过处于冷却的 `源×平台`。排序（priority）一律不动，跳过只是临时行为，
    // 冷却到期放一次半开探测，成功即恢复。
    // 保底护栏：同平台至少留一个源上场——摸底实测 mg 只有两个源支持，且其中之一
    // （gdstudio）本身就是全场最慢的，一次抖动就能让 mg 全灭，宁可慢不可全灭。
    const cooled = new Set<string>()
    for (const instance of candidates) {
      if (candidates.length - cooled.size <= 1) break
      if (sourceHealth.coolStatus(instance.config.name, musicInfo.source).skip) {
        cooled.add(instance.config.name)
      }
    }

    // 尝试所有音源和音质组合
    outer: for (const instance of candidates) {
      if (cooled.has(instance.config.name)) {
        logger.debug(`[source-health] 跳过冷却中的音源: ${instance.config.name} (${musicInfo.source})`)
        continue
      }
      // 冷却刚到期时占下半开槽位（并发请求据此继续跳过）；不在该状态时是无副作用的 no-op
      sourceHealth.claimProbe(instance.config.name, musicInfo.source)

      const sourceConfig = instance.sourceInfo!.sources[musicInfo.source]

      // 单源累计预算：这个源在一首歌上最多花这么多时间（跨音质档累加），到点就换
      // 下一个源。没有它，一个挂起的源能在多个音质档上各烧满单次超时，把整条瀑布
      // 的预算吃光——外层解析超时先到，结果是这首歌必然失败。
      const sourceDeadline = Date.now() + this.budgets.perSourceMs

      // 一次播放里同一个源最多记一个坏样本：一首歌会在多个音质档上重试同一个源，
      // 全记进去会把 consecutiveBad 灌水成"一首歌=三次坏"，让分档虚高。
      let badRecorded = false
      const recordBad = (outcome: ResolveOutcome, ms: number | null, reason: string) => {
        if (badRecorded) return
        badRecorded = true
        sourceHealth.recordResolve(instance.config.name, musicInfo.source, outcome, ms, reason)
      }

      // 尝试不同音质
      for (const quality of qualitiesToTry) {
        const now = Date.now()
        // 总预算用尽：整条瀑布到此为止
        if (deadline - now < MIN_USEFUL_ATTEMPT_MS) break outer
        // 本源预算用尽：换下一个源，而不是终止瀑布
        if (sourceDeadline - now < MIN_USEFUL_ATTEMPT_MS) {
          logger.debug(
            `音源 ${instance.config.name} 取址累计超过 ${this.budgets.perSourceMs}ms，跳过余下音质换下一个源`
          )
          // 慢到用尽单源预算，本身就是一次"这个源这档太慢"的坏证据
          recordBad('timeout', Date.now() - now, `超过单源预算 ${this.budgets.perSourceMs}ms`)
          continue outer
        }
        // 单次调用的实际上限：不超过本源剩余预算，也不超过整条瀑布的剩余预算
        const callTimeoutMs = Math.min(this.budgets.urlMs, sourceDeadline - now, deadline - now)

        // 检查音源是否支持该音质
        if (!sourceConfig.qualitys.includes(quality)) {
          continue
        }

        // 检查歌曲是否有该音质
        if (!musicInfo._types[quality]) {
          continue
        }

        const attemptAt = Date.now()
        try {
          logger.debug(
            `尝试: ${instance.config.name} - ${musicInfo.source} - ${quality}`
          )

          // 单次调用加超时（洛雪脚本挂起时不阻塞整个请求），并被单源/总预算夹住
          const url = await this.withTimeout(
            instance.simulator.getMusicUrl(musicInfo.source, musicInfo, quality),
            callTimeoutMs,
            `获取音乐URL超时: ${instance.config.name} - ${quality}`,
          )
          const tookMs = Date.now() - attemptAt

          if (url && typeof url === 'string' && url.trim()) {
            // 回源 SSRF 防护：拒绝私网/非 http(s) 地址
            if (!isTrustworthyUrl(url)) {
              logger.warn(
                `音源 ${instance.config.name} 返回了不可信播放地址，已拒绝并尝试下一源`
              )
              recordBad('ssrf', tookMs, '返回私网/非 http(s) 地址')
              continue
            }
            logger.info(
              `获取成功: ${instance.config.name} - ${quality} - ${musicInfo.name}`
            )
            // 注意这只说明「拿到了地址」；到底能不能播由 audio-serve 的字节段判定入账
            sourceHealth.recordResolve(instance.config.name, musicInfo.source, 'ok', tookMs)
            return { url, provider: instance.config.name, platform: musicInfo.source }
          }
          // 返回空地址：多半是该源没有这首歌的版权，属正常事件，不计坏
          sourceHealth.recordResolve(instance.config.name, musicInfo.source, 'no-address', tookMs)
        } catch (error) {
          const tookMs = Date.now() - attemptAt
          const message = error instanceof Error ? error.message : String(error)
          // 耗时顶到本次上限即视为挂起，否则是脚本内部报错——两者都算坏，分开记便于归因
          recordBad(tookMs >= callTimeoutMs ? 'timeout' : 'error', tookMs, message.slice(0, 120))
          logger.debug(`获取失败: ${instance.config.name} - ${quality}`, message)
        }
      }
    }

    // 所有音源都失败
    if (Date.now() > deadline) {
      throw new Error('无法获取播放链接: 所有音源均失败（总超时）')
    }
    throw new Error(`无法获取播放链接: 所有音源均失败 (歌曲: ${musicInfo.name})`)
  }

  /**
   * 从已加载的音源按优先级尝试获取歌词
   * 返回 { lyric, tlyric } 或 null。兼容音源返回的字符串或 {lyric, tlyric, ...} 对象。
   */
  async getLyric(musicInfo: MusicInfo, timeoutMs = 5000): Promise<{ lyric: string; tlyric: string | null } | null> {
    try {
      if (this.initialized && this.checkConfigChanged()) {
        this.resetInstances()
      }
      if (!this.initialized) await this.initialize()

      const key = `lyric:${musicInfo.songmid || musicInfo.name}`
      const now = Date.now()
      const cached = this.lyricCache.get(key)
      if (cached && cached.expires > now) return cached.value

      const available = this.instances.filter(i => i.initialized)
      if (available.length === 0) return null

      // 音源脚本的歌词方法签名统一为 (source, musicInfo)（见 music-core/index.js getLyric）
      const candidateNames = ['getLyric', 'getLyricInfo', 'lyrics', 'lyric']
      type AnyFunction = (...args: unknown[]) => unknown

      for (const instance of available) {
        if (!this.isAllowedByPt(instance, musicInfo.source)) continue
        if (!instance.sourceInfo?.sources[musicInfo.source]) continue

        for (const fnName of candidateNames) {
          const simRec = instance.simulator as unknown as Record<string, unknown>
          const fn = simRec[fnName] as AnyFunction | undefined
          if (typeof fn !== 'function') continue

          try {
            const result = await Promise.race([
              Promise.resolve(fn.call(instance.simulator, musicInfo.source, musicInfo)),
              new Promise((_res, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
            ]) as unknown

            const extracted = extractLyric(result)
            if (extracted) {
              this.lyricCache.set(key, { value: extracted, expires: Date.now() + this.defaultCacheTtl })
              logger.info(`getLyric: 从 ${instance.config.name}.${fnName} 获取到歌词，len=${extracted.lyric.length}`)
              return extracted
            }
          } catch (err) {
            logger.debug(`getLyric: ${instance.config.name}.${fnName} 调用失败:`, err instanceof Error ? err.message : err)
          }
        }
      }

      return null
    } catch (err) {
      logger.warn('getLyric error:', err)
      return null
    }
  }

  /**
   * 从已加载的音源按优先级尝试获取封面（返回 Buffer | URL string | null）
   */
  async getPic(musicInfo: MusicInfo, timeoutMs = 5000): Promise<Buffer | string | null> {
    try {
      if (this.initialized && this.checkConfigChanged()) {
        this.resetInstances()
      }
      if (!this.initialized) await this.initialize()

      const key = `pic:${musicInfo.songmid || musicInfo.name}`
      const now = Date.now()
      const cached = this.picCache.get(key)
      if (cached && cached.expires > now) return cached.value

      const available = this.instances.filter(i => i.initialized)
      if (available.length === 0) return null

      const candidateNames = ['getPic', 'getPicPath', 'pic', 'cover']
      type AnyFunction = (...args: unknown[]) => unknown

      for (const instance of available) {
        if (!this.isAllowedByPt(instance, musicInfo.source)) continue
        if (!instance.sourceInfo?.sources[musicInfo.source]) continue

        for (const fnName of candidateNames) {
          const simRec = instance.simulator as unknown as Record<string, unknown>
          const fn = simRec[fnName] as AnyFunction | undefined
          if (typeof fn !== 'function') continue

          try {
            const attempt1 = Promise.resolve(fn.call(instance.simulator, musicInfo))
            const attempt2 = Promise.resolve(fn.call(instance.simulator, musicInfo.source, musicInfo))

            const raced = await Promise.race([
              attempt1,
              attempt2,
              new Promise((_res, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
            ]) as unknown
            const result = raced as unknown

            if (!result) continue

            // Buffer-like
            if (Buffer.isBuffer(result)) {
              this.picCache.set(key, { value: result, expires: Date.now() + this.defaultCacheTtl })
              logger.info(`getPic: 从 ${instance.config.name}.${fnName} 获取到 Buffer，size=${result.length}`)
              return result
            }

            if (typeof result === 'string') {
              const s = result.trim()
              // data URI
              if (s.startsWith('data:')) {
                const comma = s.indexOf(',')
                if (comma > 0) {
                  const b64 = s.slice(comma + 1)
                  const buf = Buffer.from(b64, 'base64')
                  this.picCache.set(key, { value: buf, expires: Date.now() + this.defaultCacheTtl })
                  return buf
                }
              }

              // URL-like
              if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('//')) {
                // 回源 SSRF 防护：封面 URL 同样不允许指向内网
                if (!isTrustworthyUrl(s.startsWith('//') ? `https:${s}` : s)) {
                  logger.debug(`getPic: ${instance.config.name}.${fnName} 返回不可信地址，跳过`)
                  continue
                }
                this.picCache.set(key, { value: s, expires: Date.now() + this.defaultCacheTtl })
                logger.info(`getPic: 从 ${instance.config.name}.${fnName} 获取到图片 URL`)
                return s
              }

              // 其他字符串，可能是相对路径或自定义标识，直接返回
              this.picCache.set(key, { value: s, expires: Date.now() + this.defaultCacheTtl })
              return s
            }
          } catch (err) {
            logger.debug(`getPic: ${instance.config.name}.${fnName} 调用失败:`, err instanceof Error ? err.message : err)
          }
        }
      }

      return null
    } catch (err) {
      logger.warn('getPic error:', err)
      return null
    }
  }

  /**
   * 获取健康状态
   */
  getHealthStatus(): HealthStatus[] {
    return this.instances.map(instance => {
      const status: HealthStatus = {
        source: instance.config.name,
        name: instance.config.name,
        enabled: instance.config.enabled,
        initialized: instance.initialized,
        initTime: instance.initTime,
        supportedSources: [],
        supportedActions: {},
        supportedQualities: {},
        error: instance.error,
      }

      if (instance.initialized && instance.sourceInfo) {
        status.supportedSources = Object.keys(instance.sourceInfo.sources)
        
        for (const [source, config] of Object.entries(instance.sourceInfo.sources)) {
          status.supportedActions[source] = config.actions
          status.supportedQualities[source] = config.qualitys
        }
      }

      // 声明之外再挂一份运行实测：supported* 是脚本自报的，health 是真跑出来的
      const health = sourceHealth.ofSource(instance.config.name)
      if (health.length > 0) status.health = health

      return status
    })
  }

  /**
   * 检查管理器是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * 仅供单测：注入实例清单与预算，绕开真实配置文件与 runner 子进程
   * （命名前缀沿用 audio-serve 的 _resetAudioServeConfigForTest 约定）。
   * 顺带把 configHash 冻结成当前文件 hash，免得 checkConfigChanged 触发 reload 把注入的实例冲掉。
   */
  _setInstancesForTest(instances: SimulatorInstance[]): void {
    this.instances = instances
    this.initialized = true
    this.configHash = getFileHash(path.resolve(process.cwd(), 'config/music-sources.json'))
  }

  /** 仅供单测：改取址预算 */
  _setBudgetsForTest(budgets: Partial<UrlBudgets>): void {
    this.budgets = { ...this.budgets, ...budgets }
  }

  /**
   * pt 配置优先过滤
   * 若实例配置了 pt（非空），则只有 source 在 pt 内才允许；
   * 未配置 pt 时回退到 sourceInfo 判定（保持原有行为）。
   * 用于在脚本声明支持、但某平台实际失效时，通过 pt 手动排除。
   */
  private isAllowedByPt(instance: SimulatorInstance, source: string): boolean {
    const pt = instance.config.pt
    if (pt && pt.length > 0 && !pt.includes(source)) {
      logger.debug(`${instance.config.name} 的 pt 配置未包含音源: ${source}，跳过`)
      return false
    }
    return true
  }

  /**
   * 某个平台上可用的音源（保持 priority 顺序）。四道门槛：上层排除、pt 白名单、
   * 脚本声明了该平台、该平台有 musicUrl 操作。
   *
   * 从瀑布主循环里抽出来，是因为 3c 需要"这个平台一共有几个候选"才能判断跳过之后
   * 是否还留有人上场（见 _getMusicUrlSamePlatform 的保底护栏）。
   */
  private eligibleFor(
    instances: SimulatorInstance[],
    platform: string,
    excludeProviders?: ReadonlySet<string>
  ): SimulatorInstance[] {
    return instances.filter(instance => {
      // 上层已证实该音源返回假地址（HTML/JSON/垃圾字节）→ 本次解析跳过，
      // 避免「换源后又被同一个坏源挡住」（见 audio-serve 的重试逻辑）
      if (excludeProviders?.has(instance.config.name)) {
        logger.debug(`跳过已排除音源: ${instance.config.name}`)
        return false
      }
      if (!this.isAllowedByPt(instance, platform)) return false
      if (!instance.sourceInfo?.sources[platform]) {
        logger.debug(`${instance.config.name} 不支持音源: ${platform}`)
        return false
      }
      if (!instance.sourceInfo.sources[platform].actions.includes('musicUrl')) {
        logger.debug(`${instance.config.name} 不支持 musicUrl 操作`)
        return false
      }
      return true
    })
  }
}

// 单例实例
export const musicSourceManager = new MusicSourceManager()

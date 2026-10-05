/**
 * 音源配置管理服务。
 *
 * 职责：
 * - 原子读写 config/music-sources.json（临时文件 + rename）
 * - 脚本预校验（用 LXEnvironmentSimulator 试加载，确认能 inited 才保存）
 * - CRUD 业务封装（增删改后主动通知 MusicSourceManager 重建实例，立即生效）
 *
 * 脚本路径约定：相对项目根，存于 custom-sources/ 目录。
 */

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import dns from 'dns/promises'
import net from 'net'
import { createHash } from 'crypto'
import { gitBlobSha } from '@/lib/server/git-blob-sha'
import { logger } from '@/lib/logger'
import { isPublicIp } from '@/lib/server/url-guard'
import { sourceHealth, type SourceHealthView } from '@/lib/server/source-health'
import { sanitizeFilename } from '@/lib/server/download-utils'
import type { MusicSourcesConfig, SourceConfig } from '@/lib/types/music'
import { musicSourceManager } from '@/lib/music-source-manager'

const CONFIG_PATH = path.resolve(process.cwd(), 'config/music-sources.json')
const SCRIPTS_DIR = path.resolve(process.cwd(), 'custom-sources')

const VALID_PLATFORMS = ['tx', 'wy', 'kw', 'kg', 'mg'] as const
const MAX_SCRIPT_SIZE = 5 * 1024 * 1024 // 5MB
const SUBSCRIPTION_REQUEST_TIMEOUT_MS = 15_000
const MAX_SUBSCRIPTION_REDIRECTS = 3

export class SourceSubscriptionError extends Error {
  constructor(message: string, public readonly status: number = 422) {
    super(message)
    this.name = 'SourceSubscriptionError'
  }
}

/**
 * 通知 MusicSourceManager 重建实例，使配置改动立即生效。
 * 失败不抛错：配置已成功写入，下次播放请求的 MD5 懒重载会兜底。
 */
async function notifyReload(): Promise<void> {
  try {
    await musicSourceManager.reload()
  } catch (e) {
    logger.warn('[source-manager-service] 重建音源实例失败，将依赖下次请求懒重载:', e instanceof Error ? e.message : e)
  }
}

// 动态 require 模拟器（CommonJS 模块）
type SimulatorConstructor = new () => {
  executeScript(content: string): Promise<unknown>
  sourceInfo: Record<string, unknown>
}
let LXEnvironmentSimulatorCtor: SimulatorConstructor | null = null
async function getSimulatorCtor(): Promise<SimulatorConstructor> {
  if (LXEnvironmentSimulatorCtor) return LXEnvironmentSimulatorCtor
  // 复用 lib/music-core/index.js（与 music-source-manager.ts 一致的加载方式）
  // 相对路径 require，避免 Turbopack 对别名 '@/lx-env-simulator' 的静态解析失败
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../music-core/index')
  LXEnvironmentSimulatorCtor = (mod.default || mod) as SimulatorConstructor
  return LXEnvironmentSimulatorCtor
}

/** 读取配置（带缓存校验）。文件不存在时自动初始化空配置并落盘，避免首次部署报 ENOENT。 */
export async function readConfig(): Promise<MusicSourcesConfig> {
  let raw: string
  try {
    raw = await fsp.readFile(CONFIG_PATH, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      logger.warn(`[source-manager-service] ${CONFIG_PATH} 不存在，初始化空配置`)
      const empty: MusicSourcesConfig = { sources: [] }
      await writeConfig(empty)
      return empty
    }
    throw e
  }
  const parsed = JSON.parse(raw) as MusicSourcesConfig
  if (!Array.isArray(parsed.sources)) {
    throw new Error('配置文件格式无效：sources 必须是数组')
  }
  return parsed
}

/** 原子写入配置（临时文件 + rename） */
export async function writeConfig(config: MusicSourcesConfig): Promise<void> {
  // 按 priority 升序排列
  const sorted = {
    ...config,
    sources: [...config.sources].sort((a, b) => a.priority - b.priority),
  }
  const json = JSON.stringify(sorted, null, 2)
  const tmp = CONFIG_PATH + '.tmp'
  await fsp.writeFile(tmp, json, 'utf-8')
  try {
    await fsp.rename(tmp, CONFIG_PATH)
  } catch {
    // Windows 下若 CONFIG_PATH 被占用 rename 可能失败，回退直接写
    await fsp.writeFile(CONFIG_PATH, json, 'utf-8')
    await fsp.unlink(tmp).catch(() => {})
  }
  logger.debug('[source-manager-service] 配置已写入')
}

/** 检查脚本文件是否存在 */
export async function scriptExists(relativePath: string): Promise<boolean> {
  try {
    const abs = path.resolve(process.cwd(), relativePath)
    await fsp.access(abs)
    return true
  } catch {
    return false
  }
}

export interface ScriptValidationResult {
  ok: boolean
  sourceInfo?: Record<string, unknown>
  error?: string
}

/**
 * 从脚本头部 JSDoc 注释提取 @name / @version（LX 音源脚本标准元数据）。
 * 脚本 inited 事件只回传平台列表，名称只能从注释头解析；
 * 上传通道文件名损坏（含 U+FFFD 乱码）时用它兜底命名。
 */
export function parseScriptMeta(content: string): { name?: string; version?: string } {
  const head = content.slice(0, 2048)
  const pick = (key: string): string | undefined => {
    const m = head.match(new RegExp(`@${key}\\s+([^\\r\\n]+)`))
    if (!m) return undefined
    // 去掉行尾注释星号与空白
    return m[1].replace(/\s*\*\s*$/, '').trim() || undefined
  }
  return { name: pick('name'), version: pick('version') }
}

/** 文件名是否为编码损坏的乱码（UTF-8 解码失败会产生 U+FFFD 替换符，信息不可逆） */
export function isMojibakeName(name: string): boolean {
  return name.includes('\uFFFD')
}

/** 用脚本元数据构建干净文件名（无元数据时退化为 unnamed-source） */
export function buildMetaFilename(meta: { name?: string; version?: string }): string {
  const base = [meta.name, meta.version].filter(Boolean).join(' ')
  return `${sanitizeFilename(base || 'unnamed-source')}.js`
}

/** 一次性进程通道的最小面（真身是 runner-client 的 SourceRunnerClient） */
interface RunnerClientLike {
  readonly mode: string
  validateScript(scriptContent: string, timeoutMs?: number): Promise<ScriptValidationResult>
}

function getSourceRunnerClient(): RunnerClientLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../music-core/runner-client').getSourceRunner() as RunnerClientLike
}

let runnerClientOverride: RunnerClientLike | null = null

/**
 * 仅供测试：把一次性进程通道换成假的。
 *
 * 为什么要开这个口子：`validateScriptContent` 取 runner 用的是 `require()`，Vitest 的模块 mock
 * 拦不住它，于是"blob sha 复验排在执行之前"这条**顺序**判据钉不住 —— 实测把 sha 检查挪到
 * 执行之后，测试照样全绿。没有假通道就只能验"最后报了 409"，而那恰恰不是这条的性质。
 * 与 source-discovery 的 `_setRunnerForTest` 同构。
 */
export function _setRunnerClientForTest(runner: RunnerClientLike | null): void {
  runnerClientOverride = runner
}

/**
 * 预校验脚本（同步等待 inited）。
 * - 默认：在一次性子进程中执行（不可信代码首跑不碰主进程与常驻 runner）
 * - SOURCE_RUNNER_MODE=inline：与运行时一致在主进程 vm 沙箱内执行
 * - 成功 → { ok: true, sourceInfo }；失败 → { ok: false, error }
 */
export async function validateScriptContent(scriptContent: string): Promise<ScriptValidationResult> {
  const runner = runnerClientOverride ?? getSourceRunnerClient()

  if (runner.mode !== 'inline') {
    return runner.validateScript(scriptContent, SUBSCRIPTION_REQUEST_TIMEOUT_MS)
  }

  try {
    const Ctor = await getSimulatorCtor()
    const sim = new Ctor()
    await sim.executeScript(scriptContent)
    return {
      ok: true,
      sourceInfo: sim.sourceInfo,
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * 保存上传的脚本文件。
 * - 文件名 sanitize
 * - 重名冲突时追加数字后缀
 * - 不做内容校验（校验由 upload route 在保存前完成）
 *
 * @param originalName 原始文件名
 * @param content 文件内容（字符串）
 * @returns 最终保存的相对路径（相对项目根）
 */
export async function saveScript(originalName: string, content: string): Promise<string> {
  await fsp.mkdir(SCRIPTS_DIR, { recursive: true })

  // sanitize 文件名（保留中文字符，去危险字符）
  let name = sanitizeFilename(originalName)
  if (!name.endsWith('.js')) name += '.js'

  // 重名冲突追加数字
  let target = path.join(SCRIPTS_DIR, name)
  let counter = 1
  while (fs.existsSync(target)) {
    const ext = path.extname(name)
    const base = path.basename(name, ext)
    target = path.join(SCRIPTS_DIR, `${base}-${counter}${ext}`)
    counter++
  }

  await fsp.writeFile(target, content, 'utf-8')
  const rel = path.relative(process.cwd(), target).replace(/\\/g, '/')
  logger.info(`[source-manager-service] 脚本已保存: ${rel}`)
  return rel
}

/**
 * 把脚本相对路径解析成"必须落在 custom-sources 下的 .js 文件"，否则抛错。
 *
 * 为什么要单独抽出来：`deleteScript` 删的是磁盘文件、`addSource` 写的 path 会进配置文件
 * 并被 `removeSource` 原样传回 `deleteScript`。之前只有 `replaceScript` 有这道校验，
 * 于是"注册一个 path=../../xxx 的源 → 删除它"就能删到 custom-sources 之外的文件。
 */
function assertScriptPath(relativePath: string): string {
  const target = path.resolve(process.cwd(), relativePath)
  const relativeToScriptsDir = path.relative(SCRIPTS_DIR, target)
  if (
    !relativeToScriptsDir ||
    relativeToScriptsDir.startsWith('..') ||
    path.isAbsolute(relativeToScriptsDir) ||
    path.extname(target).toLowerCase() !== '.js'
  ) {
    throw new SourceSubscriptionError('脚本路径必须位于 custom-sources 目录且为 .js 文件', 400)
  }
  return target
}

/** 将已存在的 custom-sources 脚本原子替换为新内容。 */
async function replaceScript(relativePath: string, content: string): Promise<void> {
  const target = assertScriptPath(relativePath)

  const tempPath = `${target}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tempPath, content, 'utf-8')
  try {
    await fsp.rename(tempPath, target)
  } catch (err) {
    await fsp.unlink(tempPath).catch(() => {})
    throw err
  }
}

/** 校验远程订阅地址，拒绝本机及私网地址，避免管理员接口成为 SSRF 入口。 */
async function validateSubscriptionUrl(value: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SourceSubscriptionError('请输入有效的在线脚本链接', 400)
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SourceSubscriptionError('订阅链接仅支持 HTTP 或 HTTPS', 400)
  }
  if (url.username || url.password) {
    throw new SourceSubscriptionError('订阅链接不能包含账号信息', 400)
  }
  if (url.hostname.toLowerCase() === 'localhost') {
    throw new SourceSubscriptionError('不允许访问本机或内网订阅地址', 400)
  }

  const addresses = net.isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await dns.lookup(url.hostname, { all: true, verbatim: true }).catch(() => [])
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new SourceSubscriptionError('不允许访问本机、内网或无法解析的订阅地址', 400)
  }
  return url
}

function getSubscriptionFilename(url: URL): string {
  const filename = path.basename(decodeURIComponent(url.pathname))
  return filename && filename !== '/' ? filename : 'lx-subscription.js'
}

/** 下载在线洛雪脚本，处理超时、大小限制和重定向。 */
async function fetchSubscriptionScript(subscriptionUrl: string): Promise<{ content: string; filename: string }> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), SUBSCRIPTION_REQUEST_TIMEOUT_MS)
  try {
    let url = await validateSubscriptionUrl(subscriptionUrl.trim())
    const filename = getSubscriptionFilename(url)

    for (let redirectCount = 0; redirectCount <= MAX_SUBSCRIPTION_REDIRECTS; redirectCount++) {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'HollyMusic Source Subscription' },
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw new SourceSubscriptionError('订阅链接重定向地址无效')
        url = await validateSubscriptionUrl(new URL(location, url).toString())
        continue
      }
      if (!response.ok) {
        throw new SourceSubscriptionError(`下载订阅脚本失败：HTTP ${response.status}`)
      }

      const contentLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(contentLength) && contentLength > MAX_SCRIPT_SIZE) {
        throw new SourceSubscriptionError(`订阅脚本过大，上限 ${MAX_SCRIPT_SIZE / 1024 / 1024}MB`)
      }
      const content = await response.text()
      if (Buffer.byteLength(content, 'utf-8') > MAX_SCRIPT_SIZE) {
        throw new SourceSubscriptionError(`订阅脚本过大，上限 ${MAX_SCRIPT_SIZE / 1024 / 1024}MB`)
      }
      return { content, filename }
    }
    throw new SourceSubscriptionError('订阅链接重定向次数过多')
  } catch (err) {
    if (err instanceof SourceSubscriptionError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      throw new SourceSubscriptionError('下载订阅脚本超时，请稍后重试')
    }
    throw new SourceSubscriptionError(`下载订阅脚本失败：${err instanceof Error ? err.message : '未知错误'}`)
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * 删除脚本文件（best-effort：不存在就算了，但不再把真错误伪装成"不存在"）。
 * 路径必须先过目录限定校验——它可能被 `removeSource` 用配置文件里的原值传回来。
 */
export async function deleteScript(relativePath: string): Promise<void> {
  let target: string
  try {
    target = assertScriptPath(relativePath)
  } catch (err) {
    // 调用点之一是订阅导入失败的回滚（在 catch 里），这里抛异常会盖掉真正的失败原因
    logger.warn('[source-manager-service] 拒绝删除 custom-sources 之外或非 .js 的路径:', relativePath, err)
    return
  }
  try {
    await fsp.unlink(target)
    logger.info(`[source-manager-service] 脚本已删除: ${relativePath}`)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return
    logger.warn(`[source-manager-service] 脚本删除失败: ${relativePath}`, err)
  }
}

/** 列出所有源配置（附带脚本文件存在状态 + sourceInfo） */
export interface SourceWithStatus extends SourceConfig {
  scriptExists: boolean
  /** 从 sourceInfo 提取的平台列表（可能未加载过，为空） */
  supportedPlatforms?: string[]
  /**
   * 运行实测健康度（按平台分别）。与上面声明式字段的区别：supported* 是脚本自报的，
   * health 是真实取址与字节校验跑出来的。来自内存账本，重启即清零。
   */
  health?: SourceHealthView[]
  /** 最近一次周测（主动全矩阵探测）的结论，按平台分别；库里没记录时缺省 */
  probe?: SourceProbeVerdict[]
}

/**
 * 周测结论的一份快照。与 health 的分工：health 是"真实用户身上发生了什么"（重启清零），
 * probe 是"上次主动探测说这格怎么样"（落库，跨重启）。两者口径不同，界面上也不能合并。
 */
export interface SourceProbeVerdict {
  platform: string
  /** ok | no-address | timeout | error | ssrf | fake | http-error | head-error | unverified */
  outcome: string
  reason: string | null
  /** 该批次开始时刻（ms epoch），面板据此说明"什么时候测的" */
  runAt: number
  latencyMs: number | null
}

export async function listSourcesWithStatus(): Promise<SourceWithStatus[]> {
  const config = await readConfig()
  const result: SourceWithStatus[] = []
  for (const s of config.sources) {
    const exists = await scriptExists(s.path)
    // 账本的键是音源名，且沿用 manager 的同一个回退（name 缺省时用 path），
    // 两边不一致的话面板会对所有源都显示"无实测"
    const health = sourceHealth.ofSource(s.name || s.path)
    result.push({ ...s, scriptExists: exists, ...(health.length ? { health } : {}) })
  }
  return result
}

/** 新增一条源配置（path 唯一性校验） */
export async function addSource(opts: {
  path: string
  name?: string
  description?: string
  priority?: number
  timeout?: number
  enabled?: boolean
  pt?: string[]
  subscription?: SourceConfig['subscription']
}): Promise<SourceConfig> {
  const config = await readConfig()

  // 注册时就拦住越界路径：这个 path 之后会被 removeSource 原样传回 deleteScript 去删文件
  assertScriptPath(opts.path)

  // path 唯一性
  if (config.sources.some(s => s.path === opts.path)) {
    throw new Error(`脚本路径已存在: ${opts.path}`)
  }

  // priority 默认 = 当前最大 +1
  const maxPriority = config.sources.reduce((max, s) => Math.max(max, s.priority), 0)

  const newSource: SourceConfig = {
    path: opts.path,
    enabled: opts.enabled ?? true,
    priority: opts.priority ?? maxPriority + 1,
  }
  if (opts.name) newSource.name = opts.name
  if (opts.description) newSource.description = opts.description
  if (opts.timeout) newSource.timeout = opts.timeout
  if (opts.pt && opts.pt.length > 0) {
    newSource.pt = opts.pt.filter(p => (VALID_PLATFORMS as readonly string[]).includes(p))
  }
  if (opts.subscription) newSource.subscription = opts.subscription

  config.sources.push(newSource)
  await writeConfig(config)
  await notifyReload()
  logger.info(`[source-manager-service] 新增源: ${newSource.path}`)
  return newSource
}

/**
 * 从在线链接导入洛雪脚本，校验通过后自动注册为可更新订阅。
 *
 * 两个复验锚点，**都排在执行之前**：`validateScriptContent` 会真跑这份脚本，
 * 内容对不上就不该有执行这一步。
 * - `expectedBlobSha`：候选来自仓库 tree 时，树接口给的 blob sha（`git hash-object` 那套算法）；
 * - `expectedSha256`：候选来自 release 资产时，GitHub 记录的文件 sha256 —— 资产不是 git blob，
 *   没有 blob sha 可对，这条才是它的同源锚点。
 */
export async function importSubscription(
  subscriptionUrl: string,
  options: { expectedBlobSha?: string; expectedSha256?: string } = {},
): Promise<SourceConfig> {
  const normalizedUrl = subscriptionUrl.trim()
  const { content, filename } = await fetchSubscriptionScript(normalizedUrl)

  const expectedDigest = (options.expectedSha256 || '').trim().toLowerCase()
  if (expectedDigest) {
    const actual = createHash('sha256').update(content, 'utf8').digest('hex')
    if (actual !== expectedDigest) {
      throw new SourceSubscriptionError(
        `内容与发布资产记录的 sha256 不一致（期望 ${expectedDigest.slice(0, 8)}…，实到 ${actual.slice(0, 8)}…），`
        + '可能上游刚重发过、也可能地址被改写，拒绝导入',
        409,
      )
    }
  }

  const expected = (options.expectedBlobSha || '').toLowerCase()
  if (expected) {
    const actual = gitBlobSha(content)
    if (actual !== expected) {
      throw new SourceSubscriptionError(
        `内容与仓库 tree 记录的 blob 不一致（期望 ${expected.slice(0, 8)}…，实到 ${actual.slice(0, 8)}…），`
        + '可能上游刚改过、也可能地址被改写，拒绝导入',
        409,
      )
    }
  }

  const validation = await validateScriptContent(content)
  if (!validation.ok) {
    throw new SourceSubscriptionError(`脚本校验失败：${validation.error || '未知错误'}`)
  }

  // URL 文件名可能编码损坏（U+FFFD 不可逆），改用脚本 @name/@version 元数据命名
  const meta = parseScriptMeta(content)
  const effectiveFilename = isMojibakeName(filename) ? buildMetaFilename(meta) : filename
  const relativePath = await saveScript(effectiveFilename, content)
  try {
    const sourceInfo = validation.sourceInfo as { name?: string; description?: string } | undefined
    const source = await addSource({
      path: relativePath,
      name: sourceInfo?.name || effectiveFilename.replace(/\.js$/i, ''),
      description: sourceInfo?.description,
      enabled: true,
      pt: extractPlatforms(validation.sourceInfo),
      subscription: { url: normalizedUrl, updatedAt: new Date().toISOString() },
    })
    logger.info(`[source-manager-service] 已导入订阅脚本: ${normalizedUrl} → ${relativePath}`)
    return source
  } catch (err) {
    await deleteScript(relativePath)
    throw err
  }
}

/** 手动拉取并更新一个已订阅的洛雪脚本。 */
export async function updateSubscribedSource(sourcePath: string): Promise<SourceConfig> {
  const config = await readConfig()
  const index = config.sources.findIndex(source => source.path === sourcePath)
  if (index < 0) throw new SourceSubscriptionError(`找不到源配置: ${sourcePath}`, 404)

  const source = config.sources[index]
  if (!source.subscription?.url) {
    throw new SourceSubscriptionError('该音源不是在线订阅，无法更新', 400)
  }

  const { content } = await fetchSubscriptionScript(source.subscription.url)
  const validation = await validateScriptContent(content)
  if (!validation.ok) {
    throw new SourceSubscriptionError(`脚本校验失败：${validation.error || '未知错误'}`)
  }

  await replaceScript(source.path, content)
  const updated: SourceConfig = {
    ...source,
    pt: extractPlatforms(validation.sourceInfo),
    subscription: { ...source.subscription, updatedAt: new Date().toISOString() },
  }
  config.sources[index] = updated
  await writeConfig(config)
  await notifyReload()
  logger.info(`[source-manager-service] 已更新订阅脚本: ${source.subscription.url} → ${source.path}`)
  return updated
}

/** 更新一条源配置（按 path 定位） */
export async function updateSource(
  sourcePath: string,
  opts: {
    name?: string
    description?: string
    priority?: number
    timeout?: number
    enabled?: boolean
    pt?: string[]
  }
): Promise<SourceConfig> {
  const config = await readConfig()
  const idx = config.sources.findIndex(s => s.path === sourcePath)
  if (idx < 0) throw new Error(`找不到源配置: ${sourcePath}`)

  const updated = { ...config.sources[idx] }
  if (opts.name !== undefined) updated.name = opts.name
  if (opts.description !== undefined) updated.description = opts.description
  if (opts.priority !== undefined) updated.priority = opts.priority
  if (opts.timeout !== undefined) updated.timeout = opts.timeout
  if (opts.enabled !== undefined) updated.enabled = opts.enabled
  if (opts.pt !== undefined) {
    updated.pt = opts.pt.filter(p => (VALID_PLATFORMS as readonly string[]).includes(p))
  }

  config.sources[idx] = updated
  await writeConfig(config)
  await notifyReload()
  logger.info(`[source-manager-service] 更新源: ${sourcePath}`)
  return updated
}

/** 删除一条源配置 + 关联脚本文件 */
export async function removeSource(sourcePath: string): Promise<void> {
  const config = await readConfig()
  const idx = config.sources.findIndex(s => s.path === sourcePath)
  if (idx < 0) throw new Error(`找不到源配置: ${sourcePath}`)

  config.sources.splice(idx, 1)
  await writeConfig(config)
  await notifyReload()

  // 删除关联脚本文件
  await deleteScript(sourcePath)
  logger.info(`[source-manager-service] 删除源 + 脚本: ${sourcePath}`)
}

/** 从脚本 sourceInfo 提取支持平台（用于上传后自动填充 pt） */
export function extractPlatforms(sourceInfo: Record<string, unknown> | undefined): string[] {
  if (!sourceInfo?.sources || typeof sourceInfo.sources !== 'object') return []
  const platforms = Object.keys(sourceInfo.sources as Record<string, unknown>)
  return platforms.filter(p => (VALID_PLATFORMS as readonly string[]).includes(p))
}

export const SOURCE_MANAGER_CONSTANTS = {
  MAX_SCRIPT_SIZE,
  VALID_PLATFORMS,
  SCRIPTS_DIR,
  CONFIG_PATH,
  SUBSCRIPTION_REQUEST_TIMEOUT_MS,
}

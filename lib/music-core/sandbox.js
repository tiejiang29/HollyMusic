/**
 * 音源脚本 vm 沙箱
 *
 * 对齐 lx-music-desktop 原版脚本环境（userApi 隐藏窗口：
 * nodeIntegration=false + contextBridge 只暴露 lx API）——脚本只能看到
 * `lx`（由 index.js 注入）与浏览器式全局（console / 定时器 / URL /
 * TextEncoder / TextDecoder / atob / btoa），没有任何 Node 能力
 * （require / process / Buffer 全局 / module / global 等）。
 *
 * 跨界安全纪律（防 `x.constructor.constructor('return process')()` 逃逸）：
 * - 传给脚本的一切值都在沙箱域构造：函数经 wrapFn 包装、字节转沙箱
 *   Uint8Array、结构化数据经 JSON 桥、Promise/Error 在沙箱域 new；
 * - 宿主侧调用脚本回调时，参数同样先转为沙箱域对象；
 * - 宿主对象（Buffer、Error、Promise、URL 实例等）绝不直接进入沙箱。
 */

'use strict'

const vm = require('vm')
const net = require('net')
// 与 lib/server/url-guard.ts 同一份 promises 版查询（回调版没有 Promise，await 它会当场炸）
const dnsPromises = require('dns/promises')
const { Buffer } = require('buffer')
const { TextDecoder: HostTextDecoder } = require('util')

const DEFAULT_SYNC_TIMEOUT = 10_000
const MAX_ACTIVE_TIMERS = 200
const MAX_TIMER_DELAY = 60_000
const MAX_LOG_LENGTH = 2_000
const MAX_LOG_ARG_LENGTH = 500

/** toHostValue 递归时跳过的键（防沙箱对象借 __proto__/constructor 注入宿主原型链）。 */
const SKIP_HOST_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * 私网/保留 IPv4 段判定。口径与 lib/server/url-guard.ts 的 isPublicIp 对齐——
 * 两处各有一份（沙箱是 CommonJS、跑在 runner 子进程里，引不动 TS 模块），改一段要同时改另一段。
 */
function blockedIPv4Reason(text) {
  const parts = String(text).split('.')
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) {
    return `不允许的地址: ${text}` // 畸形形态（含简写 IP）统一拒绝
  }
  const a = Number(parts[0])
  const b = Number(parts[1])
  if (a === 0 || a === 10 || a === 127) return `不允许的地址: ${text}`
  if (a >= 224) return `不允许的地址: ${text}` // 组播 + 保留
  if (a === 100 && b >= 64 && b <= 127) return `不允许的地址: ${text}` // CGNAT
  if (a === 169 && b === 254) return `不允许的地址: ${text}` // 链路本地 / 云 metadata
  if (a === 172 && b >= 16 && b <= 31) return `不允许的地址: ${text}`
  if (a === 192 && b === 168) return `不允许的地址: ${text}`
  if (a === 198 && (b === 18 || b === 19)) return `不允许的地址: ${text}` // 运营商基准测试段
  return null
}

/**
 * 把 IPv6 文本展开成 16 字节，无法解析返回 null。
 * 输入已由 WHATWG URL 规范化（小写、:: 压缩），这里只需覆盖标准写法与尾段点分 IPv4。
 */
function ipv6ToBytes(text) {
  if (text.includes('%')) return null // 带 zone id 判不出归属，按拒绝处理
  let addr = text
  const v4 = addr.match(/(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4) {
    const p = v4[1].split('.').map(Number)
    if (p.some(n => n > 255)) return null
    // 尾段点分 IPv4 换成它的两个 16 位分组，后面的 :: 压缩逻辑就能统一处理
    addr = addr.slice(0, addr.length - v4[1].length)
      + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16)
  }
  const toWords = (segment) => {
    if (!segment) return []
    const words = []
    for (const w of segment.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(w)) return null
      words.push(parseInt(w, 16))
    }
    return words
  }
  const gap = addr.indexOf('::')
  if (gap >= 0) {
    const headWords = toWords(addr.slice(0, gap))
    const endWords = toWords(addr.slice(gap + 2))
    if (!headWords || !endWords) return null
    const missing = 8 - headWords.length - endWords.length
    if (missing < 0) return null
    return wordsToBytes([...headWords, ...new Array(missing).fill(0), ...endWords])
  }
  const words = toWords(addr)
  if (!words || words.length !== 8) return null
  return wordsToBytes(words)
}

function wordsToBytes(words) {
  const bytes = []
  for (const w of words) bytes.push((w >> 8) & 0xff, w & 0xff)
  return bytes
}

/** bytes[start, end) 是否全为 0。 */
function isZeroRun(bytes, start, end) {
  for (let i = start; i < end; i++) if (bytes[i] !== 0) return false
  return true
}

/**
 * IPv6 判定：先把内嵌 IPv4 的形态（v4-mapped / v4-compatible / 6to4 / NAT64）还原成 v4
 * 再按 v4 段查——只按首段前缀匹配会漏掉 `::ffff:7f00:1`（= 127.0.0.1）这类写法。
 */
function blockedIPv6Reason(text) {
  const bytes = ipv6ToBytes(text)
  if (!bytes) return `不允许的地址: ${text}`
  const embedded = (offset) => blockedIPv4Reason(
    `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`)
  if (isZeroRun(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return embedded(12)
  if (isZeroRun(bytes, 0, 12)) return embedded(12) // v4-compatible（已废弃，但仍会被解析）
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return embedded(2) // 6to4 2002::/16
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b
      && isZeroRun(bytes, 4, 12)) return embedded(12) // NAT64 常用前缀 64:ff9b::/96
  if ((bytes[0] & 0xfe) === 0xfc) return `不允许的地址: ${text}` // ULA fc00::/7
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return `不允许的地址: ${text}` // 链路本地 fe80::/10
  return null
}

/** 单个 IP 字面量的判定入口。 */
function blockedIpReason(address) {
  const version = net.isIP(address)
  if (version === 4) return blockedIPv4Reason(address)
  if (version === 6) return blockedIPv6Reason(address.toLowerCase())
  return `不允许的地址: ${address}`
}

/**
 * 判定 URL 的 host 字面量是否指向本机/私网/链路本地地址（SSRF 防护）。
 * 返回 null 表示放行；返回字符串为拒绝原因。
 * 域名在这里返回 null，由 assertPublicUrlForScript 解析后再判（见其注释）。
 */
function blockedNetworkReason(rawUrl) {
  let parsed
  try {
    parsed = new URL(String(rawUrl))
  } catch {
    return 'URL 无法解析'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `不允许的协议: ${parsed.protocol}`
  }
  if (process.env.SOURCE_ALLOW_PRIVATE_NET === 'true') return null
  const host = parsed.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return `不允许的地址: ${host}`
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (net.isIP(literal) === 0) return null // 域名：字面量放行，交给解析后判定
  return blockedIpReason(literal)
}

/**
 * 音源脚本出网的完整校验：字面量 + DNS 解析后的地址都要过。
 *
 * 为什么要多做解析：只判字面量时，把内网服务挂到一个域名上（example.com → A 127.0.0.1
 * 或 169.254.169.254）就能绕过；订阅导入与图片代理走的是 url-guard，早就解析后判定，
 * 沙箱这一侧补齐同一口径。
 * 仍然存在的余量：needle 建连时会再解析一次，理论上可在两次解析之间翻牌（DNS rebinding），
 * 真要堵死得把已验证的 IP 固定下来建连；这里拦的是"域名直指内网"这一类常态。
 */
async function assertPublicUrlForScript(rawUrl) {
  const literal = blockedNetworkReason(rawUrl)
  if (literal) return literal
  if (process.env.SOURCE_ALLOW_PRIVATE_NET === 'true') return null
  const host = new URL(String(rawUrl)).hostname.toLowerCase()
  if (net.isIP(host.replace(/^\[|\]$/g, '')) !== 0) return null // 字面量已判过
  let addresses
  try {
    addresses = await dnsPromises.lookup(host, { all: true, verbatim: true })
  } catch {
    // 解析失败与"解析到内网"同等对待：判不出地址就不建连，也不给脚本重试的机会
    return `地址解析失败: ${host}`
  }
  if (addresses.length === 0) return `地址解析失败: ${host}`
  for (const { address } of addresses) {
    const reason = blockedIpReason(address)
    if (reason) return `不允许的地址: ${address}（由 ${host} 解析）`
  }
  return null
}

/** 宿主侧 URL 解析，返回纯数据（字段 + searchParams 键值对数组）。 */
function hostUrlParse(input, base) {
  let parsed
  try {
    parsed = base ? new URL(input, base) : new URL(input)
  } catch {
    throw new Error(`Invalid URL: ${input}`)
  }
  const fields = {
    href: parsed.href,
    protocol: parsed.protocol,
    username: parsed.username,
    password: parsed.password,
    host: parsed.host,
    hostname: parsed.hostname,
    port: parsed.port,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
    origin: parsed.origin,
  }
  const searchParams = []
  for (const [key, value] of parsed.searchParams) searchParams.push([key, value])
  return { fields, searchParams }
}

/**
 * 沙箱引导代码：在沙箱域定义 URL / URLSearchParams / TextEncoder /
 * TextDecoder（atob / btoa 直接挂宿主包装函数）。
 * 所有宿主能力都通过入参传入的"沙箱包装函数"获取，返回纯数据或沙箱字节。
 */
const BOOTSTRAP = `
((urlParse, openTextDecoder, decodeWith, encodeUtf8, hostAtob, hostBtoa) => {
  class URLSearchParams {
    constructor(init) {
      this._list = []
      if (typeof init === 'string') {
        const raw = init.startsWith('?') ? init.slice(1) : init
        for (const pair of raw.split('&')) {
          if (!pair) continue
          const eq = pair.indexOf('=')
          const k = eq < 0 ? pair : pair.slice(0, eq)
          const v = eq < 0 ? '' : pair.slice(eq + 1)
          this._list.push([decodeURIComponent(k), decodeURIComponent(v)])
        }
      } else if (Array.isArray(init)) {
        for (const entry of init) this._list.push([String(entry[0]), String(entry[1])])
      } else if (init && typeof init === 'object') {
        for (const key of Object.keys(init)) this._list.push([key, String(init[key])])
      }
    }
    _sync() {
      if (!this._url) return
      const qs = this.toString()
      this._url.search = qs ? '?' + qs : ''
      const base = this._url.origin && this._url.origin !== 'null'
        ? this._url.origin
        : this._url.protocol + '//' + this._url.host
      this._url.href = base + this._url.pathname + this._url.search + this._url.hash
    }
    append(key, value) { this._list.push([String(key), String(value)]); this._sync() }
    set(key, value) {
      const k = String(key)
      const i = this._list.findIndex((p) => p[0] === k)
      if (i >= 0) this._list[i][1] = String(value)
      else this._list.push([k, String(value)])
      this._sync()
    }
    get(key) { const p = this._list.find((p) => p[0] === String(key)); return p ? p[1] : null }
    getAll(key) { return this._list.filter((p) => p[0] === String(key)).map((p) => p[1]) }
    has(key) { return this._list.some((p) => p[0] === String(key)) }
    delete(key) { this._list = this._list.filter((p) => p[0] !== String(key)); this._sync() }
    toString() { return this._list.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&') }
    *entries() { yield* this._list }
    *keys() { for (const [k] of this._list) yield k }
    *values() { for (const [, v] of this._list) yield v }
    forEach(cb, thisArg) { for (const [k, v] of this._list) cb.call(thisArg, v, k, this) }
  }

  class URL {
    constructor(input, base) {
      const info = urlParse(String(input), base == null ? null : String(base))
      for (const key of Object.keys(info.fields)) this[key] = info.fields[key]
      this._list = info.searchParams
    }
    get searchParams() {
      if (!this._sp) { this._sp = new URLSearchParams(this._list); this._sp._url = this }
      return this._sp
    }
    toString() { return this.href }
  }

  class TextEncoder {
    encode(input) { return encodeUtf8(input) }
  }

  class TextDecoder {
    constructor(label = 'utf-8') { this._decoderId = openTextDecoder(String(label)) }
    decode(input) { return decodeWith(this._decoderId, input) }
  }

  Object.defineProperty(globalThis, 'URL', { value: URL })
  Object.defineProperty(globalThis, 'URLSearchParams', { value: URLSearchParams })
  Object.defineProperty(globalThis, 'TextEncoder', { value: TextEncoder })
  Object.defineProperty(globalThis, 'TextDecoder', { value: TextDecoder })
  Object.defineProperty(globalThis, 'atob', { value: hostAtob })
  Object.defineProperty(globalThis, 'btoa', { value: hostBtoa })
})
`

/**
 * 创建音源脚本沙箱。
 *
 * @param {object} [options]
 * @param {(level: string, message: string) => void} [options.onLog]
 *   脚本 console 输出的转发目标，默认转发到宿主 console。
 * @param {number} [options.syncTimeout] 同步执行超时（毫秒），防死循环。
 * @returns 沙箱句柄（见各方法注释）
 */
function createScriptSandbox(options = {}) {
  const syncTimeout = options.syncTimeout || DEFAULT_SYNC_TIMEOUT
  const onLog =
    typeof options.onLog === 'function'
      ? options.onLog
      : (level, message) => {
          if (level === 'error') console.error(`[music-source] ${message}`)
          else if (level === 'warn') console.warn(`[music-source] ${message}`)
          else console.log(`[music-source] ${message}`)
        }

  const context = vm.createContext(Object.create(null))

  // 预取沙箱域构造器（宿主侧持引用，用于在沙箱域创建对象）
  const sandboxJSON = vm.runInContext('JSON', context)
  const sandboxUint8Array = vm.runInContext('Uint8Array', context)
  const sandboxErrorCtor = vm.runInContext('Error', context)
  const sandboxPromise = vm.runInContext('Promise', context)

  /**
   * 宿主值 → 沙箱数据（JSON 桥，彻底断开原型链）。
   * 原始类型直通；无法序列化的值降级为占位字符串。
   */
  function toData(value) {
    if (value === null || value === undefined) return value
    const type = typeof value
    if (type === 'string' || type === 'number' || type === 'boolean') return value
    try {
      return sandboxJSON.parse(JSON.stringify(value))
    } catch {
      return '[Unserializable]'
    }
  }

  /** 宿主 Buffer/TypedArray → 沙箱 Uint8Array（数据拷贝，原型链在沙箱）。 */
  function toBytes(buffer) {
    return new sandboxUint8Array(buffer)
  }

  /** 在沙箱域构造 Error（err 可为 Error 或任意值）。 */
  function sandboxError(err) {
    const message = err && err.message ? String(err.message) : String(err)
    return new sandboxErrorCtor(message)
  }

  /** 宿主 Promise → 沙箱 Promise（resolve 值经 conv 转换，reject 转沙箱 Error）。 */
  function toSandboxPromise(promise, conv) {
    return new sandboxPromise((resolve, reject) => {
      Promise.resolve(promise).then(
        (value) => resolve(conv ? conv(value) : undefined),
        (err) => reject(sandboxError(err))
      )
    })
  }

  // 沙箱域函数工厂：返回的函数原型链在沙箱域，内部闭包持有宿主 dispatch，
  // 脚本无法触达 dispatch 本身。
  const dispatchCtor = vm.runInContext(
    '(dispatch) => function (...args) { return dispatch(args) }',
    context,
    { filename: 'lx-sandbox-bridge.js' }
  )

  /**
   * 包装宿主函数为沙箱函数。
   * @param {Function} hostImpl 宿主实现；入参保持沙箱域原样（实现内自行
   *   用 toHostValue 转换需要的参数），抛出的异常会被转为沙箱 Error。
   * @param {string | Function} ret 返回值转换策略：
   *   'data'（默认，JSON 桥）/ 'bytes' / 'fn'（返回取消函数等）/ 'promise' /
   *   'promiseBytes' / 'none'，或自定义 (hostValue) => sandboxValue。
   */
  function wrapFn(hostImpl, ret = 'data') {
    const conv = typeof ret === 'function' ? ret : retConverters[ret]
    return dispatchCtor(function dispatch(args) {
      let result
      try {
        result = hostImpl.apply(undefined, args)
      } catch (err) {
        throw sandboxError(err)
      }
      return conv ? conv(result) : result
    })
  }

  const retConverters = {
    data: (v) => toData(v),
    bytes: (v) => toBytes(v),
    fn: (v) => (typeof v === 'function' ? wrapFn(v) : undefined),
    promise: (p) => toSandboxPromise(p, toData),
    promiseBytes: (p) => toSandboxPromise(p, toBytes),
    none: () => undefined,
  }

  /**
   * 沙箱值 → 宿主值（脚本传给 lx API 的参数用）。
   * 原始类型直通；沙箱 Uint8Array → 宿主 Buffer（拷贝）；沙箱对象/数组
   * 递归转宿主纯数据；沙箱函数保留引用（宿主侧直接调用，调用方负责
   * 把传给它的参数转回沙箱域）。
   */
  function toHostValue(value, depth = 0) {
    if (value === null || value === undefined) return value
    const type = typeof value
    if (type !== 'object' && type !== 'function') return value
    if (type === 'function') return value
    if (value instanceof sandboxUint8Array) return Buffer.from(value)
    if (depth >= 8) return '[MaxDepth]'
    if (Array.isArray(value)) return value.map((item) => toHostValue(item, depth + 1))
    const out = {}
    for (const key of Object.keys(value)) {
      if (SKIP_HOST_KEYS.has(key)) continue
      out[key] = toHostValue(value[key], depth + 1)
    }
    return out
  }

  // ---- TextDecoder 句柄表（宿主实例绝不进沙箱，沙箱只持有数字 id） ----
  const decoders = new Map()
  let decoderSeq = 1
  function openDecoder(label) {
    const id = decoderSeq++
    try {
      decoders.set(id, new HostTextDecoder(label))
    } catch {
      decoders.set(id, new HostTextDecoder('utf-8'))
    }
    return id
  }
  function decodeById(id, input) {
    const decoder = decoders.get(id)
    if (!decoder) throw new Error('TextDecoder 已失效')
    const bytes =
      input instanceof sandboxUint8Array ? Buffer.from(input) : Buffer.from(String(input), 'binary')
    return decoder.decode(bytes)
  }
  function encodeUtf8(input) {
    return Buffer.from(String(input), 'utf8')
  }

  // ---- 引导：URL / TextEncoder / TextDecoder / atob / btoa ----
  vm.runInContext(BOOTSTRAP, context, { filename: 'lx-sandbox-env.js' })(
    wrapFn(hostUrlParse, 'data'),
    wrapFn(openDecoder, 'data'),
    wrapFn(decodeById, 'data'),
    wrapFn(encodeUtf8, 'bytes'),
    wrapFn((input) => Buffer.from(String(input), 'base64').toString('binary'), 'data'),
    wrapFn((input) => Buffer.from(String(input), 'binary').toString('base64'), 'data')
  )

  // ---- console（受限：转发宿主、单条截断） ----
  function fmtLogArg(value) {
    if (value === null || value === undefined) return String(value)
    const type = typeof value
    if (type !== 'object') return String(value)
    if (value instanceof sandboxUint8Array) return `[Uint8Array(${value.length})]`
    try {
      const text = sandboxJSON.stringify(value)
      return text.length > MAX_LOG_ARG_LENGTH ? `${text.slice(0, MAX_LOG_ARG_LENGTH)}...` : text
    } catch {
      return String(value)
    }
  }
  const consoleObject = vm.runInContext('({})', context)
  for (const level of ['log', 'debug', 'info', 'warn', 'error']) {
    consoleObject[level] = wrapFn(
      (...args) => {
        onLog(level, args.map(fmtLogArg).join(' ').slice(0, MAX_LOG_LENGTH))
      },
      'none'
    )
  }
  // 分组输出：脚本（尤其聚合类音源）常用 console.group/groupEnd 组织日志，
  // 缺失会让脚本在初始化阶段直接抛错（表现为"脚本未调用初始化事件"）。
  // 这里按普通日志转发，保留可见性但不做缩进。
  for (const level of ['group', 'groupCollapsed']) {
    consoleObject[level] = wrapFn(
      (...args) => {
        const text = args.map(fmtLogArg).join(' ')
        if (text) onLog('log', text.slice(0, MAX_LOG_LENGTH))
      },
      'none'
    )
  }
  // 其余浏览器 console 方法（打表/计时/断言等）：脚本会用到，但沙箱里没有对应能力，
  // 一律降为无副作用的空实现，避免因"方法不存在"中断脚本执行。
  for (const name of [
    'groupEnd', 'table', 'trace', 'dir', 'dirxml', 'assert', 'count', 'countReset',
    'time', 'timeEnd', 'timeLog', 'clear', 'profile', 'profileEnd', 'timeStamp',
  ]) {
    consoleObject[name] = wrapFn(() => {}, 'none')
  }
  context.console = consoleObject

  // ---- 定时器（上限保护，dispose 时统一清理） ----
  const timers = new Map()
  let timerSeq = 1
  function addTimer(fn, delay, repeat) {
    if (timers.size >= MAX_ACTIVE_TIMERS) throw new Error('沙箱定时器数量超限')
    const safeDelay = Math.max(0, Math.min(Number(delay) || 0, MAX_TIMER_DELAY))
    const id = timerSeq++
    const run = () => {
      try {
        fn()
      } catch (err) {
        onLog('error', `定时器回调错误: ${err && err.message ? err.message : String(err)}`)
      }
    }
    if (repeat) {
      timers.set(id, setInterval(run, safeDelay))
    } else {
      timers.set(id, setTimeout(() => {
        timers.delete(id)
        run()
      }, safeDelay))
    }
    return id
  }
  function removeTimer(id) {
    const handle = timers.get(Number(id))
    if (handle === undefined) return
    clearInterval(handle)
    timers.delete(Number(id))
  }
  context.setTimeout = wrapFn((fn, delay) => (typeof fn === 'function' ? addTimer(fn, delay, false) : 0), 'data')
  context.clearTimeout = wrapFn((id) => removeTimer(id), 'none')
  context.setInterval = wrapFn((fn, delay) => (typeof fn === 'function' ? addTimer(fn, delay, true) : 0), 'data')
  context.clearInterval = wrapFn((id) => removeTimer(id), 'none')

  return {
    context,

    /** 在沙箱中执行脚本代码（filename 用于报错定位）。 */
    runScript(code, filename) {
      const script = new vm.Script(String(code), { filename: filename || 'custom-source-script.js' })
      return script.runInContext(context, { timeout: syncTimeout, displayErrors: true })
    },

    /** 在沙箱域创建空对象（用于组装返回给脚本的对象树）。 */
    newObject() {
      return vm.runInContext('({})', context)
    },

    /** 设置沙箱全局（value 必须已是沙箱域对象或原始类型）。 */
    setGlobal(name, value) {
      context[name] = value
    },

    wrapFn,
    toData,
    toBytes,
    toHostValue,
    sandboxError,

    /** 销毁沙箱：清理全部定时器（音源实例重载脚本前调用）。 */
    dispose() {
      for (const handle of timers.values()) clearInterval(handle)
      timers.clear()
    },
  }
}

module.exports = { createScriptSandbox, blockedNetworkReason, assertPublicUrlForScript }

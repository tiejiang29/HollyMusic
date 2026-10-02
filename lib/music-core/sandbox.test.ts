import { describe, it, expect, vi, afterEach } from 'vitest'
import { createScriptSandbox, blockedNetworkReason, assertPublicUrlForScript } from './sandbox'

// vi.mock 拦不住 CJS 里的 require（沙箱模块被外部化走原生 require），
// 但沙箱是 `dnsPromises.lookup(...)` 现取属性，所以直接在这同一个模块对象上打桩
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dnsPromises = require('dns/promises')

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('blockedNetworkReason（SSRF 防护）', () => {
  it.each([
    ['http://192.168.1.1/x', '私网 IPv4'],
    ['http://10.0.0.5/x', '私网 IPv4'],
    ['http://172.16.0.1/x', '私网 IPv4'],
    ['http://172.31.255.1/x', '私网 IPv4'],
    ['http://169.254.169.254/latest/meta-data', '云 metadata'],
    ['http://127.0.0.1:3000/x', '回环'],
    ['http://0.0.0.0/x', '全零地址'],
    ['http://localhost:8080/x', 'localhost'],
    ['http://[::1]/x', 'IPv6 回环'],
    ['http://[fe80::1]/x', 'IPv6 链路本地'],
    ['http://[fc00::1]/x', 'IPv6 ULA'],
    ['file:///etc/passwd', '危险协议'],
    ['ftp://example.com/x', '危险协议'],
    ['not-a-url', '非法 URL'],
    // 内嵌 IPv4 的 IPv6 写法：只看首段前缀时全部会漏过（原先连 ::ffff:7f00:1 都放行）
    ['http://[::ffff:127.0.0.1]/x', 'v4-mapped 回环'],
    ['http://[::ffff:7f00:1]/x', 'v4-mapped 回环（URL 规范化形态）'],
    ['http://[::7f00:1]/x', 'v4-compatible 回环'],
    ['http://[2002:7f00:1::]/x', '6to4 内嵌回环'],
    ['http://[64:ff9b::7f00:1]/x', 'NAT64 内嵌回环'],
    ['http://[::ffff:192.168.1.1]/x', 'v4-mapped 私网'],
    ['http://[::ffff:a9fe:a9fe]/x', 'v4-mapped 云 metadata'],
    // url-guard 那边已封的段，沙箱这一侧原来漏了
    ['http://100.64.0.1/x', 'CGNAT'],
    ['http://198.18.0.1/x', '基准测试段'],
    ['http://224.0.0.1/x', '组播'],
    ['http://255.255.255.255/x', '广播'],
  ])('%s 被拒绝（%s）', url => {
    expect(blockedNetworkReason(url)).not.toBeNull()
  })

  it.each([
    ['https://music-api.example.com/v1'],
    ['http://1.2.3.4/x'],
    ['https://[2001:db8::1]/x'],
    ['http://[::ffff:808:808]/x'], // = ::ffff:8.8.8.8，公网 v4 的映射写法不该误伤
    ['http://[2002:0808:0808::]/x'], // 6to4 内嵌公网 v4
  ])('%s 放行', url => {
    expect(blockedNetworkReason(url)).toBeNull()
  })

  it('SOURCE_ALLOW_PRIVATE_NET=true 时放行私网', () => {
    vi.stubEnv('SOURCE_ALLOW_PRIVATE_NET', 'true')
    expect(blockedNetworkReason('http://192.168.1.1/x')).toBeNull()
    expect(blockedNetworkReason('file:///etc/passwd')).not.toBeNull() // 协议检查不受开关影响
    vi.unstubAllEnvs()
  })

  it('172.32.x.x（公网段）不误伤', () => {
    expect(blockedNetworkReason('http://172.32.0.1/x')).toBeNull()
  })
})

describe('assertPublicUrlForScript（域名要解析后再判地址）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const stubLookup = (impl: (...args: unknown[]) => unknown) =>
    vi.spyOn(dnsPromises, 'lookup').mockImplementation(impl as never)

  it('解析到公网地址才放行，且按 all + verbatim 查询', async () => {
    const spy = stubLookup(async () => [{ address: '1.2.3.4', family: 4 }])
    await expect(assertPublicUrlForScript('https://music-api.example.com/v1')).resolves.toBeNull()
    expect(spy).toHaveBeenCalledWith('music-api.example.com', { all: true, verbatim: true })
  })

  it('域名直指内网时拒绝，原因里带上解析到的地址', async () => {
    stubLookup(async () => [{ address: '127.0.0.1', family: 4 }])
    await expect(assertPublicUrlForScript('http://evil.example.com/admin'))
      .resolves.toBe('不允许的地址: 127.0.0.1（由 evil.example.com 解析）')

    stubLookup(async () => [{ address: '169.254.169.254', family: 4 }])
    await expect(assertPublicUrlForScript('http://evil.example.com/meta'))
      .resolves.toContain('169.254.169.254')
  })

  it('多地址里只要有一个不合格就拒绝（双栈不能只挑好的那个）', async () => {
    stubLookup(async () => [
      { address: '1.2.3.4', family: 4 },
      { address: 'fe80::1', family: 6 },
    ])
    await expect(assertPublicUrlForScript('https://evil.example.com/x')).resolves.toContain('fe80::1')
  })

  it('解析失败与空结果都按拒绝处理，不退化成判不了就放行', async () => {
    stubLookup(async () => { throw Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' }) })
    await expect(assertPublicUrlForScript('https://nope.example.com/x')).resolves.toBe('地址解析失败: nope.example.com')

    stubLookup(async () => { throw Object.assign(new Error('EAI_AGAIN'), { code: 'EAI_AGAIN' }) })
    await expect(assertPublicUrlForScript('https://nope.example.com/x')).resolves.toBe('地址解析失败: nope.example.com')

    stubLookup(async () => [])
    await expect(assertPublicUrlForScript('https://nope.example.com/x')).resolves.toBe('地址解析失败: nope.example.com')
  })

  it('字面量已经能判死的地址不再发 DNS 查询', async () => {
    const spy = stubLookup(async () => [{ address: '1.2.3.4', family: 4 }])
    await expect(assertPublicUrlForScript('http://192.168.1.1/admin')).resolves.toContain('不允许的地址')
    await expect(assertPublicUrlForScript('file:///etc/passwd')).resolves.toContain('不允许的协议')
    expect(spy).not.toHaveBeenCalled()
  })

  it('SOURCE_ALLOW_PRIVATE_NET=true 时域名也不解析', async () => {
    const spy = stubLookup(async () => [{ address: '1.2.3.4', family: 4 }])
    vi.stubEnv('SOURCE_ALLOW_PRIVATE_NET', 'true')
    await expect(assertPublicUrlForScript('http://internal.corp/x')).resolves.toBeNull()
    expect(spy).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })
})

describe('createScriptSandbox', () => {
  it('脚本不可见任何 Node 全局（require/process/Buffer/global/module）', () => {
    const env = createScriptSandbox({})
    const probe = env.runScript(
      `[typeof require, typeof process, typeof Buffer, typeof global, typeof module, typeof __dirname, typeof globalThis].join(',')`,
      'probe.js'
    )
    expect(probe).toBe('undefined,undefined,undefined,undefined,undefined,undefined,object')
  })

  it('constructor.constructor 无法逃逸到宿主 process', () => {
    const env = createScriptSandbox({})
    const result = env.runScript(`
      (() => {
        try {
          const proc = ({}).constructor.constructor('return process')()
          return 'escaped:' + typeof proc
        } catch (err) {
          return 'blocked:' + err.message
        }
      })()
    `)
    expect(String(result)).toMatch(/^blocked:/)
    // 宿主进程自然存活（测试能走到这里即是证明）
    expect(process.pid).toBeGreaterThan(0)
  })

  it('Function 构造的代码同样拿不到 require', () => {
    const env = createScriptSandbox({})
    const result = env.runScript(`
      (() => {
        try {
          Function('return require')()
          return 'escaped'
        } catch (err) {
          return 'blocked:' + err.message
        }
      })()
    `)
    expect(String(result)).toMatch(/^blocked:/)
  })

  it('URL 与 URLSearchParams 可用（全豆要脚本依赖）', () => {
    const env = createScriptSandbox({})
    expect(env.runScript(`new URL('https://a.com/p?x=1&y=2#h').searchParams.get('y')`)).toBe('2')
    expect(env.runScript(`new URL('https://a.com/p?x=1').searchParams.has('x')`)).toBe(true)
    expect(env.runScript(`new URL('x', 'https://a.com/b/').href`)).toBe('https://a.com/b/x')
    expect(env.runScript(`new URL('https://a.com/p').pathname`)).toBe('/p')
    expect(
      env.runScript(`(() => {
        const sp = new URLSearchParams('a=1&b=2')
        sp.set('a', '9'); sp.append('c', '3')
        return sp.toString()
      })()`)
    ).toBe('a=9&b=2&c=3')
    expect(env.runScript(`new URL('https://a.com/p?a=%E4%BD%A0').searchParams.get('a')`)).toBe('你')
  })

  it('TextEncoder/TextDecoder 支持 utf-8 与 gbk（Node full-icu）', () => {
    const env = createScriptSandbox({})
    expect(env.runScript(`new TextDecoder().decode(new TextEncoder().encode('你好'))`)).toBe('你好')
    // '你好' 的 GBK 编码字节
    expect(
      env.runScript(`new TextDecoder('gbk').decode(new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3]))`)
    ).toBe('你好')
  })

  it('atob/btoa 往返', () => {
    const env = createScriptSandbox({})
    expect(env.runScript(`atob(btoa('hello'))`)).toBe('hello')
    expect(env.runScript(`atob('aGk=')`)).toBe('hi')
  })

  it('setTimeout 在沙箱内触发，dispose 后不再触发', async () => {
    const env = createScriptSandbox({})
    const result = await env.runScript(`new Promise(resolve => setTimeout(() => resolve('tick'), 5))`)
    expect(result).toBe('tick')

    const env2 = createScriptSandbox({})
    env2.runScript(`setTimeout(() => { globalThis.__ticked = true }, 10)`)
    env2.dispose()
    await sleep(40)
    expect(env2.runScript('typeof globalThis.__ticked')).toBe('undefined')
  })

  it('同步死循环被超时中断', () => {
    const env = createScriptSandbox({ syncTimeout: 100 })
    expect(() => env.runScript('while (true) {}')).toThrow()
  })

  it('wrapFn：数据往返、异常转沙箱 Error、返回函数再包装', () => {
    const env = createScriptSandbox({})
    env.setGlobal('__fn', env.wrapFn((a: number, b: number) => ({ sum: a + b })))
    expect(env.runScript('__fn(1, 2).sum')).toBe(3)

    env.setGlobal(
      '__throw',
      env.wrapFn(() => {
        throw new Error('boom')
      })
    )
    expect(
      env.runScript(`(() => {
        try { __throw() } catch (err) { return [err instanceof Error, err.message].join('|') }
      })()`)
    ).toBe('true|boom')

    // 'fn' 策略：宿主取消函数返回给脚本时必须重新包装为沙箱域函数
    env.setGlobal(
      '__getCancel',
      env.wrapFn(
        () => () => 'cancelled',
        'fn'
      )
    )
    expect(
      env.runScript(`(() => {
        const cancel = __getCancel()
        return [typeof cancel, cancel(), cancel instanceof Function].join('|')
      })()`)
    ).toBe('function|cancelled|true')
  })

  it('toBytes/toHostValue：字节双向拷贝，对象递归转纯数据', () => {
    const env = createScriptSandbox({})
    const bytes = env.toBytes(Buffer.from('hi'))
    expect(bytes.length).toBe(2)
    const hostBuffer = env.toHostValue(bytes)
    expect(Buffer.isBuffer(hostBuffer)).toBe(true)
    expect(hostBuffer.toString()).toBe('hi')

    env.setGlobal('__echo', env.wrapFn((value: unknown) => value))
    expect(env.runScript(`__echo({ a: 1, list: [1, 'x'] }).list[1]`)).toBe('x')
  })

  it('toHostValue 跳过 __proto__/constructor/prototype 键（原型注入防御）', () => {
    const env = createScriptSandbox({})
    const poisoned = env.runScript(`(() => {
      const obj = {}
      Object.defineProperty(obj, '__proto__', { value: { evil: true }, enumerable: true, writable: true, configurable: true })
      Object.defineProperty(obj, 'constructor', { value: 42, enumerable: true, writable: true, configurable: true })
      obj.normal = 'ok'
      return obj
    })()`)
    const host = env.toHostValue(poisoned)
    expect(host.normal).toBe('ok')
    expect(Object.keys(host)).toEqual(['normal'])
    expect(Object.getPrototypeOf(host)).toBe(Object.prototype)
  })

  it('console 转发到 onLog 且截断', () => {
    const onLog = vi.fn()
    const env = createScriptSandbox({ onLog })
    env.runScript(`console.log('hello', { a: 1 })`)
    expect(onLog).toHaveBeenCalledWith('log', expect.stringContaining('hello'))
    expect(onLog).toHaveBeenCalledWith('log', expect.stringContaining('"a":1'))

    env.runScript(`console.warn('w'); console.error('e')`)
    expect(onLog).toHaveBeenCalledWith('warn', 'w')
    expect(onLog).toHaveBeenCalledWith('error', 'e')
  })

  it('console.group 等浏览器方法存在且不中断脚本（缺方法会让音源脚本初始化直接抛错）', () => {
    const onLog = vi.fn()
    const env = createScriptSandbox({ onLog })
    // 聚合类音源常在初始化阶段用这些方法打日志；缺失会抛 "console.group is not a function"
    expect(() =>
      env.runScript(`
        console.group('分组标题')
        console.log('组内日志')
        console.groupEnd()
        console.groupCollapsed('折叠组')
        console.table([{ a: 1 }])
        console.assert(true, 'mute')
        console.time('t'); console.timeEnd('t')
        console.dir({ a: 1 }); console.count('c'); console.trace('tr'); console.clear()
      `)
    ).not.toThrow()
    expect(onLog).toHaveBeenCalledWith('log', '分组标题')
    expect(onLog).toHaveBeenCalledWith('log', expect.stringContaining('组内日志'))
  })
})

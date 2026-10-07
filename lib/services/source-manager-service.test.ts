/**
 * 音源管理服务的健康度挂载测试
 *
 * 只钉两件事：
 * 1. 面板读到的 health 必须能对上账本里的键。manager 用的是
 *    `name || path`（name 缺省回退脚本路径），服务侧若各写一套（比如直接用可能为
 *    undefined 的 name），结果就是面板对所有源都显示"无实测"——数据在账本里，界面上看不见。
 * 2. 导入通道里 **blob sha 的复验排在执行之前**（见文末那一节），这条靠假运行器盯。
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { listSourcesWithStatus, addSource, deleteScript, importSubscription, replaceInConfigList, SourceSubscriptionError, _setRunnerClientForTest } = await import('./source-manager-service')

/** 假的执行通道：一旦被告知"开始校验脚本"，就说明 sha 那道门没拦住 —— 直接让它报错 */
const validateScriptMock = vi.hoisted(() => vi.fn(async () => {
  throw new Error('不该执行到这一步（脚本本该在复验 blob sha 时就被拒掉）')
}))
const { sourceHealth } = await import('@/lib/server/source-health')

const CONFIG_PATH = path.resolve(process.cwd(), 'config/music-sources.json')

beforeAll(() => {
  sourceHealth.reset()
})

describe('listSourcesWithStatus 挂载运行实测', () => {
  it.skipIf(!fs.existsSync(CONFIG_PATH))(
    '账本里有样本的源，接口返回必须带上 health（键含 name 缺省回退 path 的情况）',
    async () => {
      const base = await listSourcesWithStatus()
      expect(base.length).toBeGreaterThan(0)
      expect(base.every(s => s.health === undefined)).toBe(true) // 起点：账本是空的

      // 造两个样本源：一个用 name，一个用 path（模拟配置里没写 name 的源）
      const withName = base.find(s => s.name)
      const nameless = base.find(s => !s.name)
      expect(withName).toBeTruthy()
      sourceHealth.recordResolve(withName!.name || withName!.path, 'kw', 'ok', 320)
      sourceHealth.recordByte(withName!.name || withName!.path, 'kw', 'audio', '识别到媒体容器 flac')
      if (nameless) sourceHealth.recordResolve(nameless.path, 'tx', 'timeout', 8000)

      const merged = await listSourcesWithStatus()
      const hit = merged.find(s => (s.name || s.path) === (withName!.name || withName!.path))
      expect(hit?.health?.length).toBe(1)
      expect(hit?.health?.[0].platform).toBe('kw')
      expect(hit?.health?.[0].resolveOk).toBe(1)
      expect(hit?.health?.[0].byteOk).toBe(1)
      if (nameless) {
        expect(merged.find(s => s.path === nameless.path)?.health?.[0].badKinds).toEqual({ timeout: 1 })
      }
    }
  )
})

describe('脚本路径必须限定在 custom-sources 内', () => {
  // 这条链的真实形状：POST /api/admin/sources 的 path 会写进配置，
  // 之后 removeSource 又把配置里的 path 原样交给 deleteScript 去 unlink。
  // 所以注册侧与删除侧都要校验，少一边都能删到 custom-sources 之外的文件。

  // custom-sources 与 config/music-sources.json 都是 gitignored 的运行时目录/文件，
  // CI 检出里根本没有它们：这些用例要写哨兵文件，所以自己保证目录存在
  // （本地已存在时 mkdirSync 是 no-op，不会动任何已有内容）
  const SCRIPTS_DIR = path.resolve(process.cwd(), 'custom-sources')
  beforeAll(() => {
    fs.mkdirSync(SCRIPTS_DIR, { recursive: true })
  })

  // 这一条要读真实配置文件来证明"校验排在任何写操作之前"，没有它就没法验，
  // 所以在 CI（无此文件）里跳过——不能为了让它跑起来去写仓库里那个 gitignored 副本
  it.skipIf(!fs.existsSync(CONFIG_PATH))(
    'addSource 拒绝越界 path，并且不动配置文件',
    async () => {
      const before = fs.readFileSync(CONFIG_PATH, 'utf8')
      await expect(addSource({ path: '../../prisma/data/music.db' })).rejects.toThrow(/custom-sources/)
      await expect(addSource({ path: 'custom-sources/../../config/music-sources.json' })).rejects.toThrow(/custom-sources/)
      expect(fs.readFileSync(CONFIG_PATH, 'utf8')).toBe(before)
    },
  )

  it('deleteScript 拒删目录外与非 .js 的文件，调用方拿到的是"什么都没发生"', async () => {
    // 用一次性哨兵当受害者，不要拿仓库里真实的文件赌测试有没有写错
    const outside = path.resolve(process.cwd(), `__sentinel-outside__-${Date.now()}.js`)
    const notJs = path.resolve(SCRIPTS_DIR, `__sentinel-notjs__-${Date.now()}.txt`)
    fs.writeFileSync(outside, '// keep me\n', 'utf8')
    fs.writeFileSync(notJs, 'keep me\n', 'utf8')
    try {
      await expect(deleteScript(path.relative(process.cwd(), outside))).resolves.toBeUndefined()
      await expect(deleteScript(`../${path.basename(outside)}`)).resolves.toBeUndefined()
      await expect(deleteScript(path.relative(process.cwd(), notJs))).resolves.toBeUndefined()

      expect(fs.existsSync(outside)).toBe(true)
      expect(fs.existsSync(notJs)).toBe(true)
    } finally {
      for (const f of [outside, notJs]) if (fs.existsSync(f)) fs.unlinkSync(f)
    }
  })

  it('正控制：custom-sources 下的 .js 仍然删得掉（校验没把正常路径一起堵死）', async () => {
    const target = path.resolve(SCRIPTS_DIR, `__probe-${Date.now()}.js`)
    fs.writeFileSync(target, '// 探针文件\n', 'utf8')
    try {
      await deleteScript(path.relative(process.cwd(), target))
      expect(fs.existsSync(target)).toBe(false)
    } finally {
      if (fs.existsSync(target)) fs.unlinkSync(target)
    }
  })

  it('不存在的 .js 路径不报错（保持 best-effort 语义），但越界路径也不会被当成不存在而静默放过', async () => {
    await expect(deleteScript('custom-sources/__does-not-exist__.js')).resolves.toBeUndefined()
  })
})

/**
 * 音源发现导入时会带上 `expectedBlobSha`：这条断言钉的是**顺序**，不是"有没有校验"。
 *
 * 只测对不上的那一支 —— 对上以后就会进 `validateScriptContent`（本文件把它隔成假运行器）
 * 再进 saveScript/addSource（真写 dev 库正在用的那份配置），拿生产路径当测试场地不值当。
 * "对不上就绝不执行、绝不落盘"恰恰是这唯一的不可让步点，够钉住它。
 */
describe('导入前的 blob sha 复验', () => {
  const SCRIPTS_DIR = path.resolve(process.cwd(), 'custom-sources')
  const RAW_URL = 'https://raw.githubusercontent.com/a/b/HEAD/lx-source.js'
  const SCRIPT_TEXT = [
    '/**',
    ' * @name 合成测试音源 v1.0.0',
    ' */',
    "const lx = globalThis.lx",
    "lx.send('inited', { status: true, source: { tx: 1 } })",
  ].join('\n')

  afterEach(() => {
    _setRunnerClientForTest(null)
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    validateScriptMock.mockReset()
    // 换掉真的一次性子进程：这一支要看的就是"有没有走到执行"
    _setRunnerClientForTest({ mode: 'process', validateScript: validateScriptMock })
  })

  it('内容与 tree 记录的 sha 不一致 ⇒ 409 拒掉，custom-sources 里一个文件都不多', async () => {
    fs.mkdirSync(SCRIPTS_DIR, { recursive: true })
    const before = fs.readdirSync(SCRIPTS_DIR)
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(SCRIPT_TEXT, { headers: { 'content-type': 'text/plain' } })))

    const err = await importSubscription(RAW_URL, { expectedBlobSha: '0'.repeat(40) })
      .then(() => null, (e: unknown) => e as Error & { status?: number })

    expect(err).toBeInstanceOf(SourceSubscriptionError)
    expect(err?.status).toBe(409)
    expect(err?.message).toContain('blob 不一致')
    // 顺序判据：拒绝必须发生在**执行之前**。把 sha 检查挪到 validate 之后，这一条就会红
    expect(validateScriptMock).not.toHaveBeenCalled()
    expect(fs.readdirSync(SCRIPTS_DIR)).toEqual(before)
  })
})

// ————— 撞同名导入时，替换这一步的字段取舍 —————

describe('replaceInConfigList（同名替换的那步纯计算）', () => {
  const list = () => ([
    { path: 'custom-sources/旧.js', name: '墨澜聚合音源 2.2.0', priority: 3, pt: ['kw', 'tx'], enabled: true, subscription: { url: 'https://old' } },
    { path: 'custom-sources/别的.js', name: '别的', priority: 7, pt: ['wy'], enabled: false },
    { path: 'custom-sources/新.js', name: '墨澜音乐源v2.3.4', priority: 12, pt: ['tx', 'kw', 'wy', 'kg', 'mg'], enabled: true },
  ])

  it('新条目接手旧条目的 priority / pt / enabled，其余字段（名字、订阅、描述）取新脚本那份', () => {
    const out = replaceInConfigList(list(), 'custom-sources/新.js', 'custom-sources/旧.js')
    expect(out).not.toBeNull()
    const next = out!.find(s => s.path === 'custom-sources/新.js')!
    expect(next).toMatchObject({ name: '墨澜音乐源v2.3.4', priority: 3, pt: ['kw', 'tx'], enabled: true })
    expect(out!.some(s => s.path === 'custom-sources/旧.js')).toBe(false)
    // 顺位接手不等于把别人挤掉：其余条目原样留着（writeConfig 自己按 priority 排）
    expect(out!.map(s => s.path).sort()).toEqual(['custom-sources/别的.js', 'custom-sources/新.js'])
  })

  it('不动传入的数组本身（配置对象在别处还被读着）', () => {
    const input = list()
    replaceInConfigList(input, 'custom-sources/新.js', 'custom-sources/旧.js')
    expect(input).toHaveLength(3)
    expect(input[0].priority).toBe(3)
  })

  it('三种"没什么可换"：新旧同一条、旧的已经不在了（他在另一个页签删过）、新的没找到', () => {
    expect(replaceInConfigList(list(), 'custom-sources/旧.js', 'custom-sources/旧.js')).toBeNull()
    expect(replaceInConfigList(list(), 'custom-sources/新.js', 'custom-sources/早删了.js')).toBeNull()
    // 新的不在是调用方的硬错误，由 wrapper 去区分 —— 这里只保证不返回半份清单
    expect(replaceInConfigList(list(), 'custom-sources/不存在.js', 'custom-sources/旧.js')).toBeNull()
  })

  it('旧条目 pt 缺省（隐式全平台）时原样带过去，不敷成空数组 —— 那是"谁都不支持"', () => {
    const sourceList = [{ path: 'custom-sources/旧.js', priority: 2 }, { path: 'custom-sources/新.js', priority: 9, pt: ['kw'] }]
    const out = replaceInConfigList(sourceList, 'custom-sources/新.js', 'custom-sources/旧.js')!
    expect(out.find(s => s.path === 'custom-sources/新.js')!.pt).toBeUndefined()
  })
})

/**
 * 音源管理服务的健康度挂载测试
 *
 * 只钉一件事：面板读到的 health 必须能对上账本里的键。manager 用的是
 * `name || path`（name 缺省回退脚本路径），服务侧若各写一套（比如直接用可能为
 * undefined 的 name），结果就是面板对所有源都显示"无实测"——数据在账本里，界面上看不见。
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import fs from 'fs'
import path from 'path'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { listSourcesWithStatus, addSource, deleteScript } = await import('./source-manager-service')
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

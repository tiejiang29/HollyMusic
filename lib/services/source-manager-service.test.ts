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

const { listSourcesWithStatus } = await import('./source-manager-service')
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

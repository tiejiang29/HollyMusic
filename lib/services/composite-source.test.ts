import { beforeEach, describe, expect, it, vi } from 'vitest'

const { store, readConfig } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  readConfig: vi.fn(async () => ({ sources: [{ name: '源A' }, { path: 'custom-sources/b.js' }] })),
}))

vi.mock('@/lib/services/app-setting', () => ({
  readSetting: vi.fn(async <T>(key: string, fallback: T): Promise<T> => {
    const raw = store.get(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  }),
  writeSetting: vi.fn(async (key: string, value: unknown) => { store.set(key, JSON.stringify(value)) }),
}))

vi.mock('@/lib/services/source-manager-service', () => ({ readConfig }))

const {
  COMPOSITE_SETTING_KEY,
  DEFAULT_COMPOSITE_SETTINGS,
  CompositeSourceError,
  _clearCompositeSettingsCacheForTest,
  getCompositeSettings,
  normalizeCompositeMembers,
  normalizeCompositeSettings,
  saveCompositeSettings,
} = await import('./composite-source')

beforeEach(() => {
  store.clear()
  readConfig.mockClear()
  _clearCompositeSettingsCacheForTest()
})

describe('复合源配置归一化', () => {
  it('默认关闭、波宽 1，参数保持灰度安全值', () => {
    expect(DEFAULT_COMPOSITE_SETTINGS).toMatchObject({ enabled: false, width: 1, holdMs: 2_000 })
    expect(normalizeCompositeSettings()).toEqual(DEFAULT_COMPOSITE_SETTINGS)
  })

  it('成员按音源×平台去重，非法平台与空名字丢掉', () => {
    expect(normalizeCompositeMembers([
      { sourceName: '源A', platform: 'tx' },
      { sourceName: '源A', platform: 'tx' },
      { sourceName: '源A', platform: 'bad' },
      { sourceName: ' ', platform: 'wy' },
      { sourceName: '源A', platform: 'wy' },
    ])).toEqual([
      { sourceName: '源A', platform: 'tx' },
      { sourceName: '源A', platform: 'wy' },
    ])
  })

  it('越界参数夹到合法区间，解析/首块不会超过整链', () => {
    const settings = normalizeCompositeSettings({
      width: 99,
      holdMs: -1,
      resolveMs: 99_000,
      headerMs: 99_000,
      chainMs: 99_000,
    })
    expect(settings).toMatchObject({ width: 6, holdMs: 0, resolveMs: 19_000, headerMs: 19_000, chainMs: 19_000 })
  })
})

describe('复合源配置持久化', () => {
  it('启用前至少一个成员，拒绝空成员启用', async () => {
    await expect(saveCompositeSettings({ enabled: true, members: [] })).rejects.toBeInstanceOf(CompositeSourceError)
    expect(store.has(COMPOSITE_SETTING_KEY)).toBe(false)
  })

  it('成员必须仍是配置里的音源；name 缺省时按 path 认', async () => {
    await expect(saveCompositeSettings({
      enabled: true,
      members: [{ sourceName: '已删除的源', platform: 'tx' }],
    })).rejects.toThrow('成员音源已不存在')
    await expect(saveCompositeSettings({
      enabled: true,
      members: [{ sourceName: 'custom-sources/b.js', platform: 'wy' }],
    })).resolves.toMatchObject({ enabled: true, width: 1 })
    expect(JSON.parse(store.get(COMPOSITE_SETTING_KEY) || '{}').members).toEqual([
      { sourceName: 'custom-sources/b.js', platform: 'wy' },
    ])
  })

  it('成员已被删除时仍允许一键关闭，回滚不被成员校验挡住', async () => {
    store.set(COMPOSITE_SETTING_KEY, JSON.stringify({
      enabled: true,
      members: [{ sourceName: '已删除的源', platform: 'tx' }],
    }))
    await expect(saveCompositeSettings({ enabled: false })).resolves.toMatchObject({ enabled: false })
    expect(readConfig).not.toHaveBeenCalled()
  })

  it('读取会补齐旧配置缺失的新字段', async () => {
    store.set(COMPOSITE_SETTING_KEY, JSON.stringify({ enabled: true, members: [{ sourceName: '源A', platform: 'tx' }] }))
    await expect(getCompositeSettings()).resolves.toMatchObject({ enabled: true, width: 1, chainMs: 12_000 })
  })

  it('部分更新不清掉未传的成员与参数', async () => {
    await saveCompositeSettings({
      enabled: true,
      members: [{ sourceName: '源A', platform: 'tx' }],
      width: 6,
    })
    const next = await saveCompositeSettings({ holdMs: 1_000 })
    expect(next).toMatchObject({
      enabled: true,
      width: 6,
      holdMs: 1_000,
      members: [{ sourceName: '源A', platform: 'tx' }],
    })
  })

  it('进程内缓存避免热路径重复查库，保存后立即更新', async () => {
    const saved = await saveCompositeSettings({ width: 6 })
    store.clear()
    expect(await getCompositeSettings()).toBe(saved)
    const disabled = await saveCompositeSettings({ enabled: false })
    expect(await getCompositeSettings()).toBe(disabled)
  })
})

/**
 * 小爱凭据与设备表读写（token-store，G0）测试。
 *
 * 存的东西按用户 2026-10-07 定的形态落在 `AppSetting` 单键 `speaker`，所以这里用**真实**的
 * `readSetting/writeSetting/maskSecret`（只把 prisma 换成内存表）—— 否则"脱敏"这件事就变成在测 mock 自己。
 *
 * 钉的四件事：
 * 1. **视图里一个字的凭据都没有**（`serviceToken`/`passToken` 原值不许出网）；
 * 2. 续期时机：剩不到 3 小时才刷，票还新时一次都不该多出网；
 * 3. **续期失败不能清凭据** —— passToken 大概率还在，清了就等于把人逼去重扫；
 *    但"未过期 + 续期失败"要照旧能用，"已过期 + 续期失败"要抛明确身份；
 * 4. 刷新设备列表时管理员手工标的 `managed` 要按 deviceID 保住。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({ setting: new Map<string, string>() }))

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    appSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
        (db.setting.has(where.key) ? { value: db.setting.get(where.key) } : null)),
      upsert: vi.fn(async ({ where, create, update }: {
        where: { key: string }; create: { value: string }; update?: { value?: string }
      }) => {
        db.setting.set(where.key, update?.value ?? create.value)
        return {}
      }),
    },
  },
}))

// 只隔掉真正会出网的两件事，错误类型与常量要用真的（instanceof 靠它们）
const exchangeMock = vi.hoisted(() => vi.fn())
const fetchDevicesMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/services/xiaomi/qr-login', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/services/xiaomi/qr-login')>()
  return { ...real, exchangeServiceToken: exchangeMock }
})
vi.mock('@/lib/services/xiaomi/mina-client', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/services/xiaomi/mina-client')>()
  return { ...real, fetchDevices: fetchDevicesMock }
})

const {
  SPEAKER_SETTING_KEY, readSpeakerConfig, writeSpeakerConfig, getSpeakerView, saveCredentials,
  clearSpeakerLogin, ensureFreshCredentials, syncDevices, setDeviceManaged, setSpeakerEnabled,
} = await import('@/lib/services/xiaomi/token-store')
const { XiaomiAuthError } = await import('@/lib/services/xiaomi/mina-client')
const { XiaomiLoginError } = await import('@/lib/services/xiaomi/qr-login')

const SERVICE_TOKEN = 'jZm5xK9Q+8sT2vB4cD6eF8gH0i==TAIL9Q=='
const PASS_TOKEN = 'uS3nG7bK0dM2pQ5rT7wY9zA1cE4gI6kL8oR0tV2xYZ4='
const USER_ID = '88234121'

function creds(expiresInMs: number) {
  return {
    serviceToken: SERVICE_TOKEN,
    passToken: PASS_TOKEN,
    userId: USER_ID,
    cUserId: 'CU_9',
    deviceId: 'AABBCCDDEEFF0011',
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    accountTail: '4121',
  }
}

const HOUR = 60 * 60 * 1000

beforeEach(() => {
  db.setting.clear()
  exchangeMock.mockReset()
  fetchDevicesMock.mockReset()
})

describe('视图：脱敏', () => {
  it('没配过时是全默认值，不是 null 也不是抛', async () => {
    const v = await getSpeakerView()
    expect(v).toMatchObject({ enabled: false, loggedIn: false, accountTail: '', tokenTail: '', devices: [] })
    expect(v.msToExpiry).toBeNull()
  })

  it('登录过：只给尾号与 ****尾巴，序列化整个视图也搜不到任何一个凭据原值', async () => {
    await saveCredentials(creds(6 * HOUR))
    const v = await getSpeakerView()
    expect(v.loggedIn).toBe(true)
    expect(v.accountTail).toBe('4121')
    expect(v.tokenTail).toBe(`****${SERVICE_TOKEN.slice(-4)}`)
    const dumped = JSON.stringify(v)
    expect(dumped).not.toContain(SERVICE_TOKEN)
    expect(dumped).not.toContain(PASS_TOKEN)
    // 库里确实是原值（不是存的时候就丢了 —— 那样续期会莫名失败）
    expect(db.setting.get(SPEAKER_SETTING_KEY)).toContain(SERVICE_TOKEN)
  })

  it('needsRefresh 只看"剩不到 3 小时"，过期了也叫 needsRefresh（下一次操作会去刷并如实报错）', async () => {
    await saveCredentials(creds(6 * HOUR))
    expect((await getSpeakerView()).needsRefresh).toBe(false)
    await saveCredentials(creds(2 * HOUR))
    expect((await getSpeakerView()).needsRefresh).toBe(true)
    await saveCredentials(creds(-HOUR))
    const late = await getSpeakerView()
    expect(late.needsRefresh).toBe(true)
    expect(late.msToExpiry! < 0).toBe(true)
  })
})

describe('ensureFreshCredentials：什么时候出网续期', () => {
  it('票还新：直接用，一次都不多打小米', async () => {
    await saveCredentials(creds(10 * HOUR))
    const c = await ensureFreshCredentials()
    expect(c.serviceToken).toBe(SERVICE_TOKEN)
    expect(exchangeMock).not.toHaveBeenCalled()
  })

  it('进了刷新窗口：用 passToken 静默换一张，并把新到期时间写回库', async () => {
    await saveCredentials(creds(2 * HOUR))
    exchangeMock.mockResolvedValue({ serviceToken: 'NEW_TOKEN', ssecurity: 'S' })
    const c = await ensureFreshCredentials()
    expect(exchangeMock).toHaveBeenCalledWith({ passToken: PASS_TOKEN, userId: USER_ID, cUserId: 'CU_9', deviceId: 'AABBCCDDEEFF0011' })
    expect(c.serviceToken).toBe('NEW_TOKEN')
    const stored = await readSpeakerConfig()
    expect(stored.credentials!.serviceToken).toBe('NEW_TOKEN')
    expect(Date.parse(stored.credentials!.expiresAt) - Date.now()).toBeGreaterThan(11 * HOUR)
  })

  it('已过期且续期失败：抛"要重新扫码"，但**凭据不清**（passToken 也许还能用，下一次操作还会再试）', async () => {
    await saveCredentials(creds(-HOUR))
    exchangeMock.mockRejectedValue(new XiaomiLoginError('换 micoapi 的票失败（code=700）'))
    await expect(ensureFreshCredentials()).rejects.toThrow(/重新扫码/)
    const stored = await readSpeakerConfig()
    expect(stored.credentials).toBeTruthy()
    expect(stored.lastError).toContain('续期失败')
  })

  it('还没过期但续期失败：照旧用现票，不许把人挡在门外', async () => {
    await saveCredentials(creds(2 * HOUR))
    exchangeMock.mockRejectedValue(new XiaomiLoginError('网络抖动'))
    const c = await ensureFreshCredentials()
    expect(c.serviceToken).toBe(SERVICE_TOKEN)
  })

  it('根本没登录：抛 401 身份，让面板把"重新扫码"摆到眼前', async () => {
    const err = await ensureFreshCredentials().catch(e => e)
    expect(err).toBeInstanceOf(XiaomiAuthError)
    expect((err as XiaomiAuthError).status).toBe(401)
  })
})

describe('syncDevices：拉列表 + 401 当场续一次', () => {
  const device = (id: string, name: string, managed = true) => ({
    deviceID: id, name, hardware: 'L05B', model: 'L05B', miotDID: `m${id}`, presence: 'online', managed,
  })

  it('成功就把设备表与时间写回库', async () => {
    await saveCredentials(creds(6 * HOUR))
    fetchDevicesMock.mockResolvedValue([device('1', '小爱音箱Play')])
    const list = await syncDevices()
    expect(list[0]).toMatchObject({ deviceID: '1', hardware: 'L05B' })
    const stored = await readSpeakerConfig()
    expect(stored.devices).toHaveLength(1)
    expect(stored.lastSyncAt).toBeTruthy()
    expect(stored.lastError).toBeNull()
  })

  it('设备侧 401：当场续票再试一次，成功就不报错误', async () => {
    await saveCredentials(creds(6 * HOUR))
    fetchDevicesMock
      .mockRejectedValueOnce(new XiaomiAuthError('小爱音箱的票已失效，需要重新登录'))
      .mockResolvedValueOnce([device('1', '小爱音箱Play')])
    exchangeMock.mockResolvedValue({ serviceToken: 'NEW_TOKEN', ssecurity: 'S' })
    const list = await syncDevices()
    expect(list).toHaveLength(1)
    expect(exchangeMock).toHaveBeenCalledTimes(1)
    expect(fetchDevicesMock).toHaveBeenCalledTimes(2)
    // 第二次用的是续来的新票
    expect(fetchDevicesMock.mock.calls[1][0].serviceToken).toBe('NEW_TOKEN')
  })

  it('续票也没救回来：原样抛，别静默吞掉', async () => {
    await saveCredentials(creds(6 * HOUR))
    fetchDevicesMock.mockRejectedValue(new XiaomiAuthError('小爱音箱的票已失效，需要重新登录'))
    exchangeMock.mockResolvedValue({ serviceToken: 'STILL_BAD', ssecurity: 'S' })
    // 第二次仍然 401
    fetchDevicesMock.mockRejectedValue(new XiaomiAuthError('小爱音箱的票已失效，需要重新登录'))
    await expect(syncDevices()).rejects.toThrow(/票已失效/)
  })

  it('刷新列表时保住管理员手工标的 managed（按 deviceID 对齐）', async () => {
    await writeSpeakerConfig({
      enabled: true,
      credentials: creds(6 * HOUR),
      devices: [device('1', '旧名字', false), device('2', '卧室', true)],
      lastSyncAt: null,
      lastError: null,
    })
    // 平台回来的都是默认 managed:true，且第 2 台改名了、第 3 台是新设备
    fetchDevicesMock.mockResolvedValue([device('1', '小爱音箱Play'), device('2', '卧室音箱'), device('3', '新买的')])
    const list = await syncDevices()
    expect(list.map(d => [d.deviceID, d.managed])).toEqual([['1', false], ['2', true], ['3', true]])
    expect(list.find(d => d.deviceID === '2')!.name).toBe('卧室音箱')
  })

  it('上游 502 不是"要重新扫码"：原样抛出去，别拿去触发续期', async () => {
    await saveCredentials(creds(6 * HOUR))
    fetchDevicesMock.mockRejectedValue(new XiaomiAuthError('读取设备列表失败（HTTP 500）', 502))
    await expect(syncDevices()).rejects.toThrow(/HTTP 500/)
    expect(exchangeMock).not.toHaveBeenCalled()
  })
})

describe('登录与退出', () => {
  it('扫码成功就顺手打开总开关、清掉旧错误', async () => {
    await writeSpeakerConfig({ enabled: false, credentials: null, devices: [], lastSyncAt: null, lastError: '上一次失败' })
    await saveCredentials(creds(6 * HOUR))
    const stored = await readSpeakerConfig()
    expect(stored.enabled).toBe(true)
    expect(stored.lastError).toBeNull()
  })

  it('换账号扫码：旧账号的设备表一起清掉（那是别人家的音箱）', async () => {
    await saveCredentials(creds(6 * HOUR))
    await writeSpeakerConfig({
      enabled: true,
      credentials: creds(6 * HOUR),
      devices: [{ deviceID: '1', name: 'A', hardware: 'L05B', model: '', miotDID: '', presence: 'online', managed: true }],
      lastSyncAt: null, lastError: null,
    })
    await saveCredentials({ ...creds(6 * HOUR), userId: '999999999', accountTail: '9999' })
    expect((await readSpeakerConfig()).devices).toEqual([])
    // 同一个账号重扫：设备表留着，管理员的纳管标记不该因为重扫而丢
    await writeSpeakerConfig({
      enabled: true,
      credentials: creds(6 * HOUR),
      devices: [{ deviceID: '1', name: 'A', hardware: 'L05B', model: '', miotDID: '', presence: 'online', managed: false }],
      lastSyncAt: null, lastError: null,
    })
    await saveCredentials(creds(11 * HOUR))
    const after = await readSpeakerConfig()
    expect(after.devices.map(d => [d.deviceID, d.managed])).toEqual([['1', false]])
  })

  it('退出登录：凭据、设备表、时间、错误一起清空', async () => {
    await saveCredentials(creds(6 * HOUR))
    await clearSpeakerLogin()
    const v = await getSpeakerView()
    expect(v).toMatchObject({ enabled: false, loggedIn: false, devices: [], lastSyncAt: null, lastError: null })
  })

  it('总开关可以单独拨', async () => {
    await saveCredentials(creds(6 * HOUR))
    await setSpeakerEnabled(false)
    expect((await getSpeakerView()).enabled).toBe(false)
    // 关掉不碰凭据：拨回来还能用，不用重扫
    expect((await readSpeakerConfig()).credentials).toBeTruthy()
    await setSpeakerEnabled(true)
    expect((await getSpeakerView()).enabled).toBe(true)
  })

  it('给一台不在列表里的设备打纳管标记：报 404，不凭空造一行', async () => {
    await saveCredentials(creds(6 * HOUR))
    const err = await setDeviceManaged('ghost', true).catch(e => e)
    expect(err).toBeInstanceOf(XiaomiLoginError)
    expect(err.status).toBe(404)
  })

  it('纳管标记能改回来，且只动那一台', async () => {
    await writeSpeakerConfig({
      enabled: true, credentials: creds(6 * HOUR),
      devices: [
        { deviceID: '1', name: 'A', hardware: 'L05B', model: '', miotDID: '', presence: 'online', managed: true },
        { deviceID: '2', name: 'B', hardware: 'LX05', model: '', miotDID: '', presence: 'online', managed: true },
      ],
      lastSyncAt: null, lastError: null,
    })
    await setDeviceManaged('1', false)
    const stored = await readSpeakerConfig()
    expect(stored.devices.map(d => [d.deviceID, d.managed])).toEqual([['1', false], ['2', true]])
  })
})

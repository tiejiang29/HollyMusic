import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rowState, create, probeSourceInterface, pickProbeSamples, verifyHead } = vi.hoisted(() => ({
  rowState: { value: { id: 'a'.repeat(24), platform: 'tx', sourcesJson: JSON.stringify(['杰翔音乐源']) } as Record<string, unknown> | null },
  create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
  probeSourceInterface: vi.fn(),
  pickProbeSamples: vi.fn(),
  verifyHead: vi.fn(),
}))

vi.mock('../db', () => ({
  prisma: {
    apiInterface: { findUnique: vi.fn(async () => rowState.value) },
    apiInterfaceProbe: { create },
  },
}))
vi.mock('../music-source-manager', () => ({ musicSourceManager: { probeSourceInterface } }))
vi.mock('./source-probe', () => ({ pickProbeSamples, verifyHead }))

const { ApiInterfaceProbeError, probeApiInterface } = await import('./api-interface-probe')

const sample = { source: 'tx', songmid: 'song-1', name: '七里香', singer: '周杰伦' } as never

beforeEach(() => {
  rowState.value = { id: 'a'.repeat(24), platform: 'tx', sourcesJson: JSON.stringify(['杰翔音乐源']) }
  vi.clearAllMocks()
  pickProbeSamples.mockResolvedValue({ tx: [sample] })
  verifyHead.mockResolvedValue({ outcome: 'ok', reason: null, container: 'flac' })
  probeSourceInterface.mockResolvedValue({
    url: 'https://cdn.example.com/a.flac',
    usedLanes: [{ interfaceId: 'a'.repeat(24), statusCode: 200, code: '0', msg: 'ok', urlExists: true }],
    latencyMs: 123,
    error: null,
  })
})

describe('单接口测试', () => {
  it('使用平台基准样本，只把目标身份交给沙箱，并验证首块落库', async () => {
    const result = await probeApiInterface({ interfaceId: 'a'.repeat(24), source: '杰翔音乐源' })
    expect(pickProbeSamples).toHaveBeenCalledWith(1)
    expect(probeSourceInterface).toHaveBeenCalledWith('杰翔音乐源', sample, '320k', 'a'.repeat(24))
    expect(verifyHead).toHaveBeenCalledWith('https://cdn.example.com/a.flac')
    expect(result).toMatchObject({ outcome: 'ok', latencyMs: 123, container: 'flac', songmid: 'song-1', urlHost: 'cdn.example.com' })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('前置请求被单测策略阻断时记 blocked，不冒充接口失效', async () => {
    probeSourceInterface.mockResolvedValue({
      url: null,
      usedLanes: [{ interfaceId: 'b'.repeat(24), statusCode: null, code: null, msg: null, urlExists: null }],
      latencyMs: 5,
      error: '单接口测试已拦截非目标请求: GET https://auth.example.com/token?key=raw-secret',
    })
    const result = await probeApiInterface({ interfaceId: 'a'.repeat(24), source: '杰翔音乐源' })
    expect(result).toMatchObject({ outcome: 'blocked', latencyMs: 5 })
    expect(result.detail).toBe('单接口测试已拦截非目标请求: GET https://auth.example.com/token')
    expect(result.detail).not.toContain('raw-secret')
    expect(verifyHead).not.toHaveBeenCalled()
  })

  it('没有观察到目标接口时记 unverified，不把硬编码地址当成功', async () => {
    probeSourceInterface.mockResolvedValue({ url: 'https://cdn.example.com/a.flac', usedLanes: [], latencyMs: 1, error: null })
    const result = await probeApiInterface({ interfaceId: 'a'.repeat(24), source: '杰翔音乐源' })
    expect(result.outcome).toBe('unverified')
    expect(verifyHead).not.toHaveBeenCalled()
  })

  it('拒绝不存在的接口与未观察到的跨源冒测', async () => {
    await expect(probeApiInterface({ interfaceId: 'a'.repeat(24), source: '别的源' })).rejects.toBeInstanceOf(ApiInterfaceProbeError)
    expect(probeSourceInterface).not.toHaveBeenCalled()
    rowState.value = null
    await expect(probeApiInterface({ interfaceId: 'a'.repeat(24), source: '杰翔音乐源' })).rejects.toThrow('接口身份不存在')
  })

  it('同一进程只允许一轮单测，第二发返回 409', async () => {
    let release: (value: unknown) => void = () => {}
    probeSourceInterface.mockReturnValue(new Promise(resolve => { release = resolve }))
    const first = probeApiInterface({ interfaceId: 'a'.repeat(24), source: '杰翔音乐源' })
    await vi.waitFor(() => expect(probeSourceInterface).toHaveBeenCalled())
    await expect(probeApiInterface({ interfaceId: 'a'.repeat(24), source: '杰翔音乐源' })).rejects.toMatchObject({ status: 409 })
    release({ url: null, usedLanes: [], latencyMs: 1, error: 'no-address' })
    await first
  })
})

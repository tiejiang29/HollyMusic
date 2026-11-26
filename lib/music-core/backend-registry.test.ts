import { beforeEach, describe, expect, it } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const registry = require('./backend-registry')

describe('backend lane registry', () => {
  beforeEach(() => registry.resetForTest())

  it('endpoint 剥掉 query，lane 只由 endpoint + keyHash 决定', () => {
    const a = registry.describeRequest('https://api.example.com/v1/song?apikey=key-A&mid=1', {})
    const b = registry.describeRequest('https://api.example.com/v1/song?mid=2&apikey=key-A', {})
    const c = registry.describeRequest('https://api.example.com/v1/song?mid=1&apikey=key-B', {})

    expect(a.endpoint).toBe('https://api.example.com/v1/song')
    expect(a.laneId).toBe(b.laneId)
    expect(a.laneId).not.toBe(c.laneId)
    expect(a.keyHash).not.toBe(c.keyHash)
  })

  it('接口身份区分方法、请求结构与 key，平台不同的同名接口不合并', () => {
    const get = registry.describeRequest('https://api.example.com/x?mid=1', { form: { id: '1' } }, 'get')
    const sameShape = registry.describeRequest('https://api.example.com/x?mid=2', { form: { id: '2' } }, 'get')
    const post = registry.describeRequest('https://api.example.com/x?mid=1', { form: { id: '1' } }, 'post')
    const otherShape = registry.describeRequest('https://api.example.com/x?mid=1', { form: { name: '1' } }, 'get')
    const otherKey = registry.describeRequest('https://api.example.com/x?mid=1&key=a', { form: { id: '1' } }, 'get')

    expect(get.requestShapeHash).toBe(sameShape.requestShapeHash)
    expect(new Set([get.interfaceId, post.interfaceId, otherShape.interfaceId, otherKey.interfaceId]).size).toBe(4)

    const tx = registry.beginTrace({ platform: 'tx' })
    const wy = registry.beginTrace({ platform: 'wy' })
    registry.recordLane(tx, get)
    registry.recordLane(wy, get)
    const txLane = registry.finishTrace(tx).lanes[0]
    const wyLane = registry.finishTrace(wy).lanes[0]
    expect(txLane.interfaceId).not.toBe(wyLane.interfaceId)
    expect(txLane.dedupeKey).toBe(wyLane.dedupeKey)
  })

  it('trace 回传业务元数据与真实网络次数，不携带响应正文', () => {
    const traceId = registry.beginTrace({ platform: 'tx', sourceName: '配置源名' })
    const request = registry.describeRequest('https://api.example.com/x?key=secret', {}, 'post')
    registry.recordLane(traceId, request)
    registry.recordLaneResponseMeta(traceId, request, registry.responseMeta(
      { statusCode: 200, headers: { 'Content-Type': 'application/json' }, bytes: 123 },
      { code: 503, msg: '系统运行错误', data: { url: 'https://cdn.example.com/a.flac' }, secret: 'never-copy' },
    ), 1)
    const lane = registry.finishTrace(traceId).lanes[0]

    expect(lane).toMatchObject({
      method: 'POST', sourceName: '配置源名', statusCode: 200, code: '503',
      msg: '系统运行错误', urlExists: true, networkCount: 1, responseCount: 1,
    })
    expect(JSON.stringify(lane)).not.toContain('never-copy')
    expect(JSON.stringify(lane)).not.toContain('cdn.example.com')
    expect(JSON.stringify(lane)).not.toContain('secret')
    const redacted = registry.responseMeta({ statusCode: 200 }, { msg: '失败 https://api.example.com/x?token=raw-token key=raw-key' })
    expect(redacted.msg).toBe('失败 https://api.example.com/x key=[redacted]')
  })

  it('query/header/body 里的凭据都参与 keyHash', () => {
    const query = registry.describeRequest('https://api.example.com/x?token=abc123', {})
    const header = registry.describeRequest('https://api.example.com/x', { headers: { Authorization: 'Bearer abc123' } })
    const body = registry.describeRequest('https://api.example.com/x', { form: { apikey: 'abc123' } })

    expect(query.keyHash).not.toBeNull()
    expect(header.keyHash).not.toBeNull()
    expect(body.keyHash).not.toBeNull()
    expect(new Set([query.keyHash, header.keyHash, body.keyHash]).size).toBe(3)
  })

  it('trace 回传只含哈希与 endpoint，不含原始 key', () => {
    const traceId = registry.beginTrace({ platform: 'tx', action: 'musicUrl', quality: 'flac', songId: 'song-1', sourceName: '测试源' })
    registry.recordLane(traceId, registry.describeRequest('https://api.example.com/x?apikey=super-secret-key', {}))
    const trace = registry.finishTrace(traceId)
    const serialized = JSON.stringify(trace)

    expect(trace.lanes).toHaveLength(1)
    expect(trace.lanes[0].platform).toBe('tx')
    expect(trace.lanes[0].quality).toBe('flac')
    expect(serialized).not.toContain('super-secret-key')
    expect(serialized).toContain('https://api.example.com/x')
  })

  it('同一个 trace 内重复 lane 只记一次，finish 后清理', () => {
    const traceId = registry.beginTrace({ platform: 'tx' })
    const lane = registry.describeRequest('https://api.example.com/x?key=one', {})
    registry.recordLane(traceId, lane)
    registry.recordLane(traceId, lane)

    expect(registry.finishTrace(traceId).lanes).toHaveLength(1)
    expect(registry.finishTrace(traceId).lanes).toHaveLength(0)
  })

  it('请求合并键保留方法与正文，不再把不同对象请求混成一把', () => {
    const a = registry.buildRequestKey('POST', 'https://api.example.com/x', { form: { id: '1' } })
    const b = registry.buildRequestKey('POST', 'https://api.example.com/x', { form: { id: '2' } })
    const c = registry.buildRequestKey('GET', 'https://api.example.com/x', { form: { id: '1' } })
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('完全相同请求在途时只启动一次，结束后可再次请求', async () => {
    let calls = 0
    let release
    const key = registry.buildRequestKey('GET', 'https://api.example.com/x?key=one', { headers: { 'X-A': '1' } })
    const starter = () => { calls++; return new Promise(resolve => { release = resolve }) }
    const a = registry.coalesceRequest(key, starter)
    const b = registry.coalesceRequest(key, starter)
    expect(calls).toBe(0)
    await Promise.resolve()
    expect(calls).toBe(1)
    release({ ok: true })
    await expect(a).resolves.toEqual({ ok: true })
    await expect(b).resolves.toEqual({ ok: true })

    await registry.coalesceRequest(key, async () => { calls++; return { ok: true } })
    expect(calls).toBe(2)
  })

  it('lane 统计只暴露哈希与 HTTP 成败，判坏会显示冷却', () => {
    const lane = {
      ...registry.describeRequest('https://api.example.com/x?key=super-secret-key', {}),
      platform: 'tx', songId: 'song-1', quality: 'flac', sourceName: '测试源',
    }
    registry.recordLaneResult(lane, true)
    registry.recordLaneResult(lane, false, 'HTTP 503')
    registry.markLaneBad(lane, '试听片段', 1000)

    const [stat] = registry.listLaneStats()
    expect(stat).toMatchObject({
      laneId: lane.laneId,
      endpoint: 'https://api.example.com/x',
      sourceName: '测试源',
      platform: 'tx',
      attempts: 2,
      httpOk: 1,
      httpBad: 1,
      payloadBad: 1,
      successRate: 0.5,
      cooling: true,
    })
    expect(stat.retryAfterMs).toBeGreaterThan(0)
    expect(JSON.stringify(stat)).not.toContain('super-secret-key')
  })

  it('lane 负缓存按平台/歌曲/音质/key 隔离，不同 key 不连坐', async () => {
    const a = registry.describeRequest('https://api.example.com/x?key=one', {})
    const b = registry.describeRequest('https://api.example.com/x?key=two', {})
    const laneA = { ...a, platform: 'tx', songId: 'song-1', quality: 'flac' }
    registry.markLaneBad(laneA, 'trial', 20)

    expect(registry.isLaneBad(laneA)).toBe(true)
    expect(registry.isLaneBad({ ...b, platform: 'tx', songId: 'song-1', quality: 'flac' })).toBe(false)
    expect(registry.isLaneBad({ ...a, platform: 'tx', songId: 'song-2', quality: 'flac' })).toBe(false)
    expect(registry.isLaneBad({ ...a, platform: 'tx', songId: 'song-1', quality: '320k' })).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(registry.isLaneBad(laneA)).toBe(false)
  })
})

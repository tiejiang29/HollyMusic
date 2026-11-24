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

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
})

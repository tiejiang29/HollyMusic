/**
 * app/api/share/route.ts 集成测试
 *
 * 回归重点：库里存在 `data` 未带 types 的历史行（重建索引 / 批量导入留下的），
 * 落地页据此选音质时对 undefined 调 .map → 整个分享页 500（NAS 实测 tx-002NmjQb4DhZr6）。
 * 修在读库边界（lib/db.ts 的 normalizeMusicInfo），路由侧也把「无 types 兜底 320k」
 * 这句原有注释兑现了。这里两头都钉住。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

let row: Record<string, unknown> | null = null

vi.mock('@/lib/db', () => ({
  resolveMusicInfoById: vi.fn(async () => row),
}))

process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'share-route-test-secret-0123456789'

const { GET } = await import('./route')

function shareUrl(uid?: string) {
  return new NextRequest(
    `http://music.test/api/share${uid ? `?uid=${encodeURIComponent(uid)}` : ''}`
  )
}

beforeEach(() => {
  row = null
})

describe('GET /api/share', () => {
  it('types 缺失的历史行 → 200 落地页，音质兜底 320k 并带上 st token', async () => {
    row = { source: 'tx', songmid: '002NmjQb4DhZr6', name: '曹操', singer: '林俊杰', interval: '04:03' }

    const res = await GET(shareUrl('tx-002NmjQb4DhZr6'))
    const html = await res.text()

    expect(res.status).toBe(200)
    // audio 标签里的 URL 走过 escapeHtml，& 变成 &amp;
    expect(html).toContain('quality=320k')
    expect(html).toContain('&amp;st=')
    expect(html).toContain('曹操')
  })

  it('types 为空数组同样 200（归一化后的常态形态）', async () => {
    row = { source: 'kw', songmid: 'k1', name: '无音质行', singer: 'x', types: [] }

    const res = await GET(shareUrl('kw-k1'))

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('quality=320k')
  })

  it('有 types 时按可用性挑：优先 320k，只有 128k 就降 128k，两者都无则取第一个', async () => {
    const cases: Array<[Array<{ type: string }>, string]> = [
      [[{ type: '128k' }, { type: '320k' }], 'quality=320k'],
      [[{ type: '128k' }], 'quality=128k'],
      [[{ type: 'flac' }], 'quality=flac'],
    ]
    for (const [types, expected] of cases) {
      row = { source: 'wy', songmid: 'w1', name: 'n', singer: 's', types }
      const html = await (await GET(shareUrl('wy-w1'))).text()
      expect(html).toContain(expected)
    }
  })

  it('uid 查不到 / 不带 uid → 仍渲染 200 的降级页，不出播放标签', async () => {
    row = null

    const notFound = await GET(shareUrl('tx-missing'))
    expect(notFound.status).toBe(200)
    expect(await notFound.text()).toContain('歌曲未找到')

    const bare = await GET(shareUrl())
    expect(bare.status).toBe(200)
    expect(await bare.text()).not.toContain('<audio id="audio"')
  })
})

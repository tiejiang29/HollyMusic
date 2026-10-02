/**
 * usePlaylistDetail 的失败与竞态测试
 *
 * 以前是 `catch {}`：任何失败都只留 detail=null，页面一律显示"歌单不存在"——
 * 网关 502、会话过期（现在 401 会当场掉登录态）都长成"这张歌单没了"的样子，
 * 把人引去重删重导。另一个是 id 快速切换（前进/后退、连点两张歌单）时
 * 先发的请求可能后回，把上一张的内容盖到当前页上。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const getPlaylist = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api/playlists', () => ({ getPlaylist }))

const { usePlaylistDetail } = await import('@/hooks/usePlaylistDetail')

interface State { detail: unknown; error: string | null; loading: boolean }
let latest: State = { detail: null, error: null, loading: false }

function Probe({ id }: { id: number | null }) {
  latest = usePlaylistDetail(id)
  return null
}

async function withRoot<T>(id: number | null, run: (rerender: (next: number | null) => Promise<void>) => Promise<T>): Promise<T> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const render = async (nextId: number | null) => { await act(async () => { root.render(createElement(Probe, { id: nextId })) }) }
  await render(id)
  try {
    return await run((next: number | null) => render(next))
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
  }
}

/** 手动控制的一个 Promise：用来把"先发后回"这种时序钉死 */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  getPlaylist.mockReset()
  latest = { detail: null, error: null, loading: false }
})

afterEach(() => { vi.restoreAllMocks() })

describe('usePlaylistDetail', () => {
  it('取不到时把原因留给调用方，而不是只留一个 null', async () => {
    getPlaylist.mockRejectedValue(new Error('歌单不存在或无权访问'))

    await withRoot(1, async () => {
      await act(async () => { await Promise.resolve() })

      expect(latest.error).toBe('歌单不存在或无权访问')
      expect(latest.detail).toBeNull()
      expect(latest.loading).toBe(false)
    })
  })

  it('成功时 error 清空、detail 到位', async () => {
    getPlaylist.mockResolvedValue({ id: 1, name: '我的歌单' })

    await withRoot(1, async () => {
      await act(async () => { await Promise.resolve() })

      expect(latest.detail).toMatchObject({ id: 1 })
      expect(latest.error).toBeNull()
    })
  })

  it('换 id 立刻清空上一张：加载中不会把旧歌单当成当前结果', async () => {
    const first = deferred()
    getPlaylist.mockReturnValue(first.promise)

    await withRoot(1, async rerender => {
      await act(async () => { await Promise.resolve() })
      expect(latest.detail).toBeNull()          // 还没回，本来就没有

      first.resolve({ id: 1, name: '第一张' })
      await act(async () => { await first.promise })
      expect(latest.detail).toMatchObject({ id: 1 })

      const second = deferred()
      getPlaylist.mockReturnValue(second.promise)
      await rerender(2)
      expect(latest.detail).toBeNull()          // 换人的瞬间必须清掉旧的
    })
  })

  it('旧请求晚到不覆盖新结果（连点两张歌单时的先后是反的）', async () => {
    const d1 = deferred()
    const d2 = deferred()
    getPlaylist.mockImplementation((id: number) => (id === 1 ? d1.promise : d2.promise))

    await withRoot(1, async rerender => {
      await rerender(2)                          // 1 还没回就切到 2

      d2.resolve({ id: 2, name: '第二张' })
      await act(async () => { await d2.promise })
      expect(latest.detail).toMatchObject({ id: 2 })

      d1.resolve({ id: 1, name: '第一张' })      // 迟到的旧结果
      await act(async () => { await d1.promise })
      expect(latest.detail).toMatchObject({ id: 2 })
      expect(latest.loading).toBe(false)
    })
  })

  it('迟到的失败也不改写当前状态', async () => {
    const d1 = deferred()
    const d2 = deferred()
    getPlaylist.mockImplementation((id: number) => (id === 1 ? d1.promise : d2.promise))

    await withRoot(1, async rerender => {
      await rerender(2)
      d2.resolve({ id: 2, name: '第二张' })
      await act(async () => { await d2.promise })

      d1.reject(new Error('网络中断'))
      await act(async () => { await d1.promise.catch(() => {}) })

      expect(latest.error).toBeNull()
      expect(latest.detail).toMatchObject({ id: 2 })
    })
  })
})

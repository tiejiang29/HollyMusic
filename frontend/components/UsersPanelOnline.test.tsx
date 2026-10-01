/**
 * 用户管理面板「状态」列的渲染与轮询测试
 *
 * 钉三件会被误读/悄悄坏掉的事：
 * 1. 离线不再只是一个灰点 —— 直接写出「多久没动静」，不必悬停 tooltip
 * 2. 面板停着不动也会每 30 秒重取一次（在线状态是会自己过期的事实）
 * 3. 轮询是静默的：不闪骨架屏；标签页不可见时根本不发请求
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const listUsers = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api/admin-users', () => ({
  listUsers,
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuthStore: (sel: (s: { username: string | null }) => unknown) => sel({ username: 'admin' }),
}))

const { UsersPanel } = await import('@/components/admin/UsersPanel')

const NOW = new Date('2026-10-01T12:00:00Z')

function user(over: Record<string, unknown>) {
  return {
    id: 1,
    username: 'tiejiang',
    isAdmin: true,
    hasPassword: true,
    mustChangePassword: false,
    lastLogin: '2026-10-01T11:50:00Z',
    lastSeen: '2026-10-01T11:53:00Z', // 7 分钟前
    lastSeenIp: null,
    lastSeenUa: null,
    isOnline: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-10-01T11:53:00Z',
    ...over,
  }
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  listUsers.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function render() {
  await act(async () => {
    root.render(createElement(UsersPanel))
  })
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('UsersPanel 在线状态', () => {
  it('在线/离线旁边直接写出多久之前活跃过', async () => {
    listUsers.mockResolvedValue({
      list: [
        user({}),
        user({ id: 2, username: 'sally', isAdmin: false, isOnline: false, lastSeen: '2026-10-01T11:49:00Z' }),
      ],
    })
    await render()

    expect(host.textContent).toContain('在线')
    expect(host.textContent).toContain('7 分钟前')
    expect(host.textContent).toContain('离线')
    expect(host.textContent).toContain('11 分钟前')
  })

  it('从未活跃过的用户不显示空字符串', async () => {
    listUsers.mockResolvedValue({ list: [user({ lastSeen: null, isOnline: false })] })
    await render()
    expect(host.textContent).toContain('无活跃记录')
  })

  it('每 30 秒静默重取一次，表格不闪骨架屏', async () => {
    listUsers.mockResolvedValueOnce({ list: [user({})] })
    await render()
    expect(host.textContent).toContain('7 分钟前')

    listUsers.mockResolvedValueOnce({ list: [user({ lastSeen: '2026-10-01T11:59:00Z' })] })
    await tick(30_000)

    expect(listUsers).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('1 分钟前')
    // 骨架屏会把整张表换掉，表头还在就说明这次是静默刷新
    expect(host.textContent).toContain('最近登录')
  })

  it('标签页不可见时不发请求', async () => {
    listUsers.mockResolvedValue({ list: [user({})] })
    await render()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })

    await tick(90_000)

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    expect(listUsers).toHaveBeenCalledTimes(1)
  })
})

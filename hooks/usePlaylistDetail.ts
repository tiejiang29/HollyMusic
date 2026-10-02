import { useCallback, useEffect, useRef, useState } from 'react'
import { getPlaylist, type PlaylistDetail } from '@/lib/api/playlists'

/**
 * 歌单详情。
 *
 * 两个以前会被误读的点：
 * 1. 失败要能分清是"没有这张歌单"还是"这次没取到"。服务端 404 的文案本来就是
 *    「歌单不存在或无权访问」，被 `catch {}` 吞掉后页面只能一律显示"歌单不存在"，
 *    而网关挂了、会话过期（现在 401 会当场掉登录态）也都长成那个样子。
 * 2. id 快速切换时只认最后一次请求：前进/后退或连点两张歌单，先发的请求可能后回，
 *    会把上一张的内容盖到当前页上。
 */
export function usePlaylistDetail(id: number | null) {
  // 把"结果"和"它是哪张歌单的结果"存在一起：换 id 时旧数据自然读不到，
  // 迟到的旧响应就算写回来也不会盖掉当前页——不需要在 effect 里手动清零
  const [state, setState] = useState<{ id: number; detail: PlaylistDetail | null; error: string | null } | null>(null)
  const [loading, setLoading] = useState(false)
  const requestRef = useRef(0)

  const reload = useCallback(async () => {
    if (id == null) return
    const ticket = ++requestRef.current
    setLoading(true)
    try {
      const d = await getPlaylist(id)
      if (ticket !== requestRef.current) return
      setState({ id, detail: d, error: null })
    } catch (e) {
      if (ticket !== requestRef.current) return
      setState({ id, detail: null, error: e instanceof Error ? e.message : '加载失败' })
    } finally {
      if (ticket === requestRef.current) setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void reload()
  }, [reload])

  const current = state && state.id === id ? state : null
  return { detail: current?.detail ?? null, error: current?.error ?? null, loading, reload }
}

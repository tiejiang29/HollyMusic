
import { useCallback } from 'react'
import { useSearchStore } from '@/lib/store/search-store'
import type { SourceType } from '@/lib/types/music'

/**
 * 搜索 hook（store 薄包装）
 *
 * 数据存放在 search-store（组件外部），组件卸载不丢数据：
 * 切换到其他页面再切回搜索页，输入框/源/结果均保留。
 * 参考实现：hooks/useRandomSongs.ts + lib/store/discover-store.ts。
 */
export function useSearch() {
  const results = useSearchStore(s => s.results)
  const localList = useSearchStore(s => s.localList)
  const albums = useSearchStore(s => s.albums)
  const platformAlbums = useSearchStore(s => s.platformAlbums)
  const mode = useSearchStore(s => s.mode)
  const loading = useSearchStore(s => s.loading)
  const error = useSearchStore(s => s.error)
  const keyword = useSearchStore(s => s.keyword)
  const lastKeyword = useSearchStore(s => s.lastKeyword)
  const source = useSearchStore(s => s.source)
  const setKeyword = useSearchStore(s => s.setKeyword)
  const setSource = useSearchStore(s => s.setSource)
  const setMode = useSearchStore(s => s.setMode)
  const runStore = useSearchStore(s => s.run)
  const runAlbumStore = useSearchStore(s => s.runAlbum)

  const run = useCallback(
    (kw: string, src: SourceType | 'all' | 'local') => runStore(kw, src),
    [runStore]
  )

  const runAlbum = useCallback(
    (kw: string) => runAlbumStore(kw),
    [runAlbumStore]
  )

  return {
    results, localList, albums, platformAlbums, mode,
    loading, error, keyword, lastKeyword, source,
    setKeyword, setSource, setMode, run, runAlbum,
  }
}

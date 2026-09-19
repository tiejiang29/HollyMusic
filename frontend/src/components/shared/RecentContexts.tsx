import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Clock, Disc3, ListMusic } from 'lucide-react'
import { getRecentContexts, type RecentContextItem } from '@/lib/api/recent'

/**
 * 最近播放的歌单/专辑（首页入口）
 * 歌单（含自建+收藏）与专辑分开 tab 展示；无记录时整块隐藏。
 */
export function RecentContexts() {
  const [tab, setTab] = useState<'playlist' | 'album'>('playlist')
  const [playlists, setPlaylists] = useState<RecentContextItem[]>([])
  const [albums, setAlbums] = useState<RecentContextItem[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    Promise.all([
      getRecentContexts('playlist', 12).catch(() => ({ list: [] })),
      getRecentContexts('album', 12).catch(() => ({ list: [] })),
    ]).then(([pl, al]) => {
      setPlaylists(pl.list || [])
      setAlbums(al.list || [])
      setLoaded(true)
    })
  }, [])

  if (!loaded || (playlists.length === 0 && albums.length === 0)) return null

  const items = tab === 'playlist' ? playlists : albums
  // 如果当前 tab 无数据，自动切到有数据的 tab
  const activeTab = items.length === 0 && (tab === 'playlist' ? albums.length : playlists.length) > 0
    ? (tab === 'playlist' ? 'album' : 'playlist')
    : tab
  const activeItems = activeTab === 'playlist' ? playlists : albums

  const to = (item: RecentContextItem) => {
    if (item.itemType === 'playlist') {
      // 站内歌单是纯数字 id；平台歌单（歌单广场）按约定带 "source-id" 前缀，跳广场歌单详情
      if (/^\d+$/.test(item.itemId)) return `/playlists/${item.itemId}`
      const idx = item.itemId.indexOf('-')
      if (idx > 0) return `/discover/playlists/${item.itemId.slice(idx + 1)}?source=${item.itemId.slice(0, idx)}`
      return `/playlists/${item.itemId}`
    }
    // 专辑：itemId 可能是 gid 或 source-albumId
    if (item.itemId.includes('-')) {
      const idx = item.itemId.indexOf('-')
      const src = item.itemId.slice(0, idx)
      const aid = item.itemId.slice(idx + 1)
      return `/album/${src}/${aid}?name=${encodeURIComponent(item.name)}`
    }
    return `/album/${item.itemId}`
  }

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-3">
        <Clock className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">最近播放</h2>
        <div className="ml-2 flex gap-1">
          {playlists.length > 0 && (
            <button
              onClick={() => setTab('playlist')}
              className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs transition ${
                activeTab === 'playlist' ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground hover:bg-accent'
              }`}
            >
              <ListMusic className="h-3 w-3" /> 歌单
            </button>
          )}
          {albums.length > 0 && (
            <button
              onClick={() => setTab('album')}
              className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs transition ${
                activeTab === 'album' ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground hover:bg-accent'
              }`}
            >
              <Disc3 className="h-3 w-3" /> 专辑
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {activeItems.slice(0, 8).map(item => (
          <Link key={`${item.itemType}-${item.itemId}`} to={to(item)} className="group flex flex-col gap-1.5">
            <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-primary/30 to-primary/10 ring-1 ring-border/50">
              {item.img ? (
                <img
                  src={item.img}
                  alt={item.name}
                  loading="lazy"
                  className="h-full w-full object-cover transition group-hover:scale-105"
                  onError={e => { e.currentTarget.style.display = 'none' }}
                />
              ) : item.itemType === 'playlist' ? (
                <ListMusic className="h-8 w-8 text-primary/50" />
              ) : (
                <Disc3 className="h-8 w-8 text-primary/50" />
              )}
            </div>
            <div className="truncate text-xs font-medium">{item.name}</div>
            {item.owner && <div className="truncate text-[10px] text-muted-foreground">{item.owner}</div>}
          </Link>
        ))}
      </div>
    </section>
  )
}

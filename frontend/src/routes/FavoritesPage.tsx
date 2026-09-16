import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  listFavorites,
  unstarAlbum,
  listFavoriteAlbums,
  type FavoriteAlbum,
  type FavoriteSong,
} from '@/lib/api/favorites'
import { useFavoritesStore } from '@/lib/store/favorites-store'
import { SongList } from '@/components/shared/SongList'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { ChainAlbumCover } from '@@/components/shared/ChainAlbumCover'
import { Disc3, Heart, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { toTrack, type Track } from '@/lib/types/player'

/** 专辑收藏卡：封面两级降级（快照直链 → 服务端解析），点卡进专辑详情，右上角取消收藏 */
function AlbumFavoriteCard({ album, onRemove }: { album: FavoriteAlbum; onRemove: (a: FavoriteAlbum) => void }) {
  const source = album.source || ''
  const proxySrc = source === 'apple'
    ? `/api/album/apple/cover?collectionId=${encodeURIComponent(album.albumId)}`
    : `/api/album/cover?source=${encodeURIComponent(source)}&albumid=${encodeURIComponent(album.albumId)}&name=${encodeURIComponent(album.name)}&singer=${encodeURIComponent(album.singer || '')}`
  const to = `/album/${source}/${encodeURIComponent(album.albumId)}?name=${encodeURIComponent(album.name)}&singer=${encodeURIComponent(album.singer || '')}`

  // 取消按钮放在 Link 外面：<a> 里嵌 <button> 是非法结构，点击语义也会互相打架
  return (
    <div className="group relative flex flex-col gap-1.5">
      <Link
        to={to}
        className="relative flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-primary/30 to-primary/10 ring-1 ring-border/50"
      >
        <Disc3 className="absolute h-8 w-8 text-primary/50" />
        <ChainAlbumCover
          img={album.img}
          proxySrc={proxySrc}
          alt={album.name}
          className="relative h-full w-full object-cover transition group-hover:scale-105"
        />
      </Link>
      <button
        onClick={() => onRemove(album)}
        aria-label={`取消收藏 ${album.name}`}
        className="absolute right-1.5 top-1.5 rounded-full bg-black/50 p-1.5 text-white opacity-0 transition hover:bg-black/70 group-hover:opacity-100 focus:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <div className="truncate text-xs font-medium">{album.name}</div>
      {album.singer && <div className="truncate text-[10px] text-muted-foreground">{album.singer}</div>}
    </div>
  )
}

export function FavoritesPage() {
  const [tab, setTab] = useState<'song' | 'album'>('song')
  const [favorites, setFavorites] = useState<FavoriteSong[]>([])
  const [albums, setAlbums] = useState<FavoriteAlbum[]>([])
  const [loading, setLoading] = useState(true)

  // 订阅 favorites version：PlayerBar / SongRow 收藏/取消成功（DB 已提交）后自增，
  // 触发本页重新拉取完整列表，使收藏列表实时变更。
  const favVersion = useFavoritesStore(s => s.version)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    // 两份列表并行拉取：切 tab 时无需再等一次请求
    Promise.all([
      listFavorites().catch(() => ({ list: [], total: 0 })),
      listFavoriteAlbums().catch(() => ({ list: [], total: 0 })),
    ])
      .then(([songs, albumList]) => {
        if (cancelled) return
        setFavorites(songs.list)
        setAlbums(albumList.list)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [favVersion])

  const tracks: Track[] = favorites
    .filter(f => f.musicInfo)
    .map(f => toTrack({ uid: f.songId, musicInfo: f.musicInfo! }))

  const removeAlbum = async (album: FavoriteAlbum) => {
    try {
      await unstarAlbum(album.albumId, album.source)
      setAlbums(prev => prev.filter(a => a !== album))
      toast.success(`已取消收藏「${album.name}」`)
    } catch (err) {
      toast.error(`取消收藏失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const tabButton = (value: 'song' | 'album', label: string, count: number) => (
    <button
      onClick={() => setTab(value)}
      className={`rounded-full px-3 py-1 text-xs transition ${
        tab === value ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground hover:bg-accent'
      }`}
    >
      {label}{count > 0 && ` (${count})`}
    </button>
  )

  const empty = tab === 'song' ? tracks.length === 0 : albums.length === 0

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="hidden text-2xl font-bold md:block">我的收藏</h1>
        <div className="flex gap-1">
          {tabButton('song', '歌曲', tracks.length)}
          {tabButton('album', '专辑', albums.length)}
        </div>
      </div>

      {loading ? (
        <LoadingSkeleton />
      ) : !empty ? (
        tab === 'song' ? (
          <SongList tracks={tracks} />
        ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {albums.map(album => (
              <AlbumFavoriteCard key={`${album.source || ''}-${album.albumId}`} album={album} onRemove={removeAlbum} />
            ))}
          </div>
        )
      ) : (
        <EmptyState
          icon={Heart}
          title={tab === 'song' ? '还没有收藏的歌曲' : '还没有收藏的专辑'}
          description={tab === 'song' ? '点击歌曲旁的心形图标收藏' : '在专辑详情页点击「收藏」'}
        />
      )}
    </div>
  )
}

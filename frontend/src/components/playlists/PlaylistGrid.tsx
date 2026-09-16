
import { Link } from 'react-router-dom'
import type { PlaylistSummary } from '@/lib/api/playlists'
import { ListMusic } from 'lucide-react'

export function PlaylistGrid({ playlists }: { playlists: PlaylistSummary[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {playlists.map(p => (
        <Link
          key={p.id}
          to={`/playlists/${p.id}`}
          className="group flex flex-col gap-2 rounded-lg p-2 hover:bg-accent/40"
        >
          <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded bg-gradient-to-br from-primary/30 to-primary/10">
            {p.collected && (
              <span className="absolute right-1.5 top-1.5 z-10 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">
                收藏
              </span>
            )}
            {p.coverArt ? (
              <img
                src={p.coverArt}
                alt={p.name}
                loading="lazy"
                className="h-full w-full object-cover transition group-hover:scale-105"
                onError={e => { e.currentTarget.style.display = 'none' }}
              />
            ) : (
              <ListMusic className="h-10 w-10 text-primary/70" />
            )}
          </div>
          <div className="truncate text-sm font-medium">{p.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {p.songCount} 首{/* 老收藏副本的 comment 存有「收藏自 xxx」，新副本 comment 继承源歌单 */}
            {p.comment ? ` · ${p.comment}` : ''}
          </div>
        </Link>
      ))}
    </div>
  )
}

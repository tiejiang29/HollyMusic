import { Link } from 'react-router-dom'
import { Disc3 } from 'lucide-react'
import { SourceBadge } from '@/components/shared/SourceBadge'
import type { AlbumSummary } from '@/lib/api/album'

/** 专辑卡片网格（PlaylistGrid 式）：封面/专辑名/歌手/源标，点击进专辑详情。 */
export function AlbumGrid({ albums }: { albums: AlbumSummary[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {albums.map(a => (
        <Link
          key={`${a.source}-${a.albumId}`}
          to={`/album/${a.source}/${a.albumId}`}
          className="group flex flex-col gap-2 rounded-lg p-2 hover:bg-accent/40"
        >
          <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded bg-gradient-to-br from-primary/30 to-primary/10">
            {a.img ? (
              <img
                src={a.img}
                alt={a.name}
                loading="lazy"
                className="h-full w-full object-cover transition group-hover:scale-105"
                onError={e => { e.currentTarget.style.display = 'none' }}
              />
            ) : (
              <Disc3 className="h-10 w-10 text-primary/70" />
            )}
            <span className="absolute right-1.5 top-1.5">
              <SourceBadge source={a.source} />
            </span>
          </div>
          <div className="truncate text-sm font-medium">{a.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {a.singer}{a.trackCount ? ` · ${a.trackCount} 首` : ''}
          </div>
        </Link>
      ))}
    </div>
  )
}

import { Link } from 'react-router-dom'
import { Disc3 } from 'lucide-react'
import type { LocalAlbumSummary } from '@/lib/api/album'

/** 本地专辑卡片网格：占位封面/专辑名/歌手/曲目数，点击进专辑详情（gid）。 */
export function AlbumGrid({ albums }: { albums: LocalAlbumSummary[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {albums.map(a => (
        <Link
          key={a.gid}
          to={`/album/${a.gid}`}
          className="group flex flex-col gap-2 rounded-lg p-2 hover:bg-accent/40"
        >
          <div className="flex aspect-square items-center justify-center overflow-hidden rounded bg-gradient-to-br from-primary/30 to-primary/10">
            <Disc3 className="h-10 w-10 text-primary/70 transition group-hover:scale-110" />
          </div>
          <div className="truncate text-sm font-medium">{a.title}</div>
          <div className="truncate text-xs text-muted-foreground">
            {a.artist}{a.trackCount ? ` · ${a.trackCount} 首` : ''}
          </div>
        </Link>
      ))}
    </div>
  )
}

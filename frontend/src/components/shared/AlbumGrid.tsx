import { Link } from 'react-router-dom'
import { AlbumCover } from '@@/components/shared/AlbumCover'
import type { LocalAlbumSummary } from '@/lib/api/album'

/** 本地专辑卡片网格：封面三级降级（CAA→服务端探测→占位），点击进专辑详情（gid）。 */
export function AlbumGrid({ albums }: { albums: LocalAlbumSummary[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {albums.map(a => (
        <Link
          key={a.gid}
          to={`/album/${a.gid}`}
          className="group flex flex-col gap-2 rounded-lg p-2 hover:bg-accent/40"
        >
          <div className="aspect-square overflow-hidden rounded">
            <AlbumCover gid={a.gid} alt={a.title} className="h-full w-full transition group-hover:scale-105" />
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

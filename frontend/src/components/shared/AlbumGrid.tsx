import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Disc3 } from 'lucide-react'
import { getAlbumCover, type LocalAlbumSummary } from '@/lib/api/album'

// 会话级封面缓存：跨搜索/跨页面复用，探测过的专辑不再重复请求
const coverCache = new Map<string, string>()

/** 本地专辑卡片网格：封面懒加载/占位唱片、专辑名/歌手/曲目数，点击进专辑详情（gid）。 */
export function AlbumGrid({ albums }: { albums: LocalAlbumSummary[] }) {
  const [covers, setCovers] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const a of albums) {
      const c = coverCache.get(a.gid)
      if (c) init[a.gid] = c
    }
    return init
  })

  useEffect(() => {
    let cancelled = false
    // 已缓存的先回填
    setCovers(prev => {
      const next = { ...prev }
      for (const a of albums) {
        const c = coverCache.get(a.gid)
        if (c) next[a.gid] = c
      }
      return next
    })
    // 缺失的并发 6 路探测（服务端取首曲目搜曲推导，探测结果有 24h 缓存）
    const missing = albums.filter(a => !coverCache.has(a.gid))
    let index = 0
    const workers = Array.from({ length: Math.min(6, missing.length) }, async () => {
      while (!cancelled && index < missing.length) {
        const album = missing[index++]
        try {
          const { img } = await getAlbumCover(album.gid)
          if (img) coverCache.set(album.gid, img)
          if (!cancelled && img) setCovers(prev => ({ ...prev, [album.gid]: img }))
        } catch {
          // 封面探测失败保持占位
        }
      }
    })
    return () => { cancelled = true }
  }, [albums])

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {albums.map(a => {
        const img = covers[a.gid]
        return (
          <Link
            key={a.gid}
            to={`/album/${a.gid}`}
            className="group flex flex-col gap-2 rounded-lg p-2 hover:bg-accent/40"
          >
            <div className="flex aspect-square items-center justify-center overflow-hidden rounded bg-gradient-to-br from-primary/30 to-primary/10">
              {img ? (
                <img
                  src={img}
                  alt={a.title}
                  loading="lazy"
                  className="h-full w-full object-cover transition group-hover:scale-105"
                  onError={e => { e.currentTarget.style.display = 'none' }}
                />
              ) : (
                <Disc3 className="h-10 w-10 text-primary/70 transition group-hover:scale-110" />
              )}
            </div>
            <div className="truncate text-sm font-medium">{a.title}</div>
            <div className="truncate text-xs text-muted-foreground">
              {a.artist}{a.trackCount ? ` · ${a.trackCount} 首` : ''}
            </div>
          </Link>
        )
      })}
    </div>
  )
}

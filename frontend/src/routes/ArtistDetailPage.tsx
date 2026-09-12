import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Disc3, Music, Play, RefreshCw, User } from 'lucide-react'
import { SongList } from '@/components/shared/SongList'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { RemoteCoverImage } from '@/components/shared/RemoteCoverImage'
import { usePlayerStore } from '@/lib/store/player-store'
import { toTrack, type Track } from '@/lib/types/player'
import { getArtistDetail, type ArtistDetailData } from '@/lib/api/artist'
import { Link } from 'react-router-dom'

/** 歌手详情页（Apple 数据源）：简介（维基，可选）+ 热门歌（可播）+ 专辑网格。 */
export function ArtistDetailPage() {
  const { artistId = '' } = useParams<{ artistId: string }>()
  const [detail, setDetail] = useState<ArtistDetailData | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const playTrack = usePlayerStore(s => s.playTrack)
  const navigate = useNavigate()
  const reqIdRef = useRef(0)
  // 头像三级降级：维基头像（服务端代理转发）→ 首专辑封面 → 占位。
  // 有简介=维基条目存在（基本都有头像）才尝试维基，否则直接从专辑封面起。
  const [avatarStage, setAvatarStage] = useState<'wiki' | 'album'>('album')
  useEffect(() => {
    setAvatarStage(detail?.artist.bio ? 'wiki' : 'album')
  }, [detail?.artist.name, detail?.artist.bio])

  const load = async () => {
    const reqId = ++reqIdRef.current
    const stale = () => reqId !== reqIdRef.current
    if (!/^\d+$/.test(artistId)) {
      setDetail(null); setError('无效的歌手'); setLoading(false); return
    }
    setLoading(true); setError(null); setUnsupported(false)
    try {
      const r = await getArtistDetail(artistId)
      if (stale()) return
      setDetail(r)
      setUnsupported(!!r.unsupported)
    } catch (err) {
      if (stale()) return
      setDetail(null); setError(err instanceof Error ? err.message : '歌手详情获取失败')
    } finally {
      if (!stale()) setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artistId])

  const tracks: Track[] = (detail?.hotSongs ?? []).map(song => toTrack({ uid: song.uid, musicInfo: song }))

  if (loading) return <div className="p-6"><LoadingSkeleton /></div>

  if (!detail || unsupported) {
    return (
      <div className="p-6">
        <EmptyState icon={User} title={error || '未找到该歌手'} description="换个关键词搜索" />
        <div className="text-center">
          <button onClick={() => navigate('/search')} className="rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground">返回搜索</button>
        </div>
      </div>
    )
  }

  const artist = detail.artist

  return (
    <div className="p-6">
      {/* 歌手头部 */}
      <div className="mb-6 flex items-end gap-4">
        {avatarStage === 'wiki' ? (
          <img
            src={`/api/artist/avatar?name=${encodeURIComponent(artist.name)}`}
            alt={artist.name}
            className="h-32 w-32 shrink-0 rounded-full object-cover shadow-lg"
            onError={() => setAvatarStage('album')}
          />
        ) : artist.img ? (
          <RemoteCoverImage src={artist.img} alt="" className="h-32 w-32 shrink-0 rounded-full object-cover shadow-lg" />
        ) : (
          <div className="flex h-32 w-32 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/50 to-primary/10 shadow-lg">
            <User className="h-12 w-12 text-primary-foreground/80" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted-foreground">歌手{artist.genre ? ` · ${artist.genre}` : ''}</p>
          <h1 className="truncate text-3xl font-bold">{artist.name}</h1>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => tracks[0] && playTrack(tracks[0], tracks)}
              disabled={tracks.length === 0}
              className="flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              <Play className="h-4 w-4 fill-current" /> 播放热门
            </button>
            <button onClick={() => void load()} className="rounded-full border border-border p-2 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="刷新">
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* 简介（维基，可选） */}
      {artist.bio && (
        <details className="mb-6 rounded-lg bg-card p-4 ring-1 ring-border" open>
          <summary className="cursor-pointer text-sm font-medium">简介</summary>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{artist.bio}</p>
        </details>
      )}

      {/* 热门歌曲 */}
      <h2 className="mb-3 text-lg font-semibold">热门歌曲 <span className="text-sm font-normal text-muted-foreground">（{tracks.length} 首，Apple 热门度）</span></h2>
      {tracks.length > 0 ? (
        <SongList tracks={tracks} />
      ) : (
        <EmptyState icon={Music} title="暂无可播热门歌曲" description="该歌手的歌曲未能匹配到可播放版本" />
      )}

      {/* 专辑 */}
      {detail.albums.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-lg font-semibold">专辑 <span className="text-sm font-normal text-muted-foreground">（{detail.albums.length} 张）</span></h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {detail.albums.map(a => (
              <Link key={a.albumId} to={`/album/apple/${a.albumId}`} className="group flex flex-col gap-2 rounded-lg p-2 hover:bg-accent/40">
                <div className="flex aspect-square items-center justify-center overflow-hidden rounded bg-gradient-to-br from-primary/30 to-primary/10">
                  <img
                    src={`/api/album/apple/cover?collectionId=${a.albumId}`}
                    alt={a.name}
                    loading="lazy"
                    className="h-full w-full object-cover transition group-hover:scale-105"
                    onError={e => { e.currentTarget.style.display = 'none' }}
                  />
                </div>
                <div className="truncate text-sm font-medium">{a.name}</div>
                <div className="truncate text-xs text-muted-foreground">{a.year ? a.year.slice(0, 4) : ''}</div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

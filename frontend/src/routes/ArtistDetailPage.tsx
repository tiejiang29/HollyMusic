import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom'
import { Clapperboard, Disc3, Music, Play, RefreshCw, User, X } from 'lucide-react'
import { SongList } from '@/components/shared/SongList'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { RemoteCoverImage } from '@/components/shared/RemoteCoverImage'
import { ChainAlbumCover } from '@@/components/shared/ChainAlbumCover'
import { usePlayerStore } from '@/lib/store/player-store'
import { toTrack, type Track } from '@/lib/types/player'
import { getArtistDetail, getKwArtistDetail, getMgArtistDetail, getTxArtistDetail, getArtistMvs, type ArtistDetailData, type ArtistMv } from '@/lib/api/artist'

/** 歌手详情页（三链）：kw/mg=全链（简介+官方头像+热门歌直可播+专辑）；
 *  apple=amp 升级（官方头像+生日+热门歌+专辑+维基简介）。
 *  任何链均可挂 MV 区（Apple amp 数据，30 秒预告）。路由 /artist/:source/:artistId。 */
export function ArtistDetailPage() {
  const routeParams = useParams<{ source?: string; artistId: string }>()
  const source = routeParams.source || 'apple'
  const { artistId = '' } = routeParams
  const [searchParams] = useSearchParams()
  // 应急钥匙：kw 链不可用时服务端按名字回落 Apple
  const nameKey = searchParams.get('name') || undefined
  const [detail, setDetail] = useState<ArtistDetailData | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mvs, setMvs] = useState<ArtistMv[]>([])
  const [playingMv, setPlayingMv] = useState<ArtistMv | null>(null)
  const playTrack = usePlayerStore(s => s.playTrack)
  const navigate = useNavigate()
  const reqIdRef = useRef(0)
  // 头像降级：img（kw/mg/amp 官方照直链）→ Apple 端点（apple 链）→ 维基 → 占位
  const [avatarStage, setAvatarStage] = useState<'primary' | 'appleEndpoint' | 'wiki' | 'album'>('album')
  useEffect(() => {
    setAvatarStage('primary')
  }, [detail?.artist.name, detail?.source])

  const load = async () => {
    const reqId = ++reqIdRef.current
    const stale = () => reqId !== reqIdRef.current
    // id 形态：apple/kw/mg 为纯数字，tx 为字母数字混合 mid（如 0025NhlN2yWrP4）
    if (!/^[0-9A-Za-z]{1,64}$/.test(artistId)) {
      setDetail(null); setError('无效的歌手'); setLoading(false); return
    }
    setLoading(true); setError(null); setUnsupported(false)
    try {
      const r = source === 'kw' ? await getKwArtistDetail(artistId, nameKey) : source === 'mg' ? await getMgArtistDetail(artistId, nameKey) : source === 'tx' ? await getTxArtistDetail(artistId, nameKey) : await getArtistDetail(artistId)
      if (stale()) return
      setDetail(r)
      setUnsupported(!!r.unsupported)
      // MV 区：tx 链自带 mvs；其余链走 Apple amp 增强（失败静默隐藏区块）
      if (r?.mvs?.length) {
        if (!stale()) setMvs(r.mvs.map(m => ({ id: m.vid, name: m.title, artist: r.artist.name, artwork: m.pic, durationSec: m.durationSec ?? 0, previewUrl: null })))
      } else if (r?.artist?.name) {
        getArtistMvs(r.artist.name).then(mv => { if (!stale()) setMvs(mv.list || []) }).catch(() => {})
      }
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
  }, [source, artistId, nameKey])

  const tracks: Track[] = (detail?.hotSongs ?? []).map(song => toTrack({ uid: song.uid, musicInfo: song }))

  // 热门歌分页：每页最多 30 首（kw 链单次 100 首，翻页浏览）
  const HOT_PAGE_SIZE = 30
  const [page, setPage] = useState(1)
  useEffect(() => { setPage(1) }, [source, artistId, nameKey])
  const totalPages = Math.max(1, Math.ceil(tracks.length / HOT_PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const visibleTracks = tracks.slice((currentPage - 1) * HOT_PAGE_SIZE, currentPage * HOT_PAGE_SIZE)

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
  // 实际生效的链（kw 请求可能降级返回 apple 数据，头像/封面策略随之切换）
  const activeSource = detail.source || source

  return (
    <div className="p-6">
      {/* 歌手头部 */}
      <div className="mb-6 flex items-end gap-4">
        {avatarStage === 'primary' ? (
          artist.img ? (
            // 官方照直链（kw starheads / mg 头像 / amp artwork）
            <img
              src={artist.img}
              alt={artist.name}
              className="h-32 w-32 shrink-0 rounded-full object-cover shadow-lg"
              onError={() => setAvatarStage(activeSource === 'apple' ? 'appleEndpoint' : 'wiki')}
            />
          ) : activeSource === 'apple' ? (
            // apple 链无 amp 头像：落 SSR 端点
            <img
              src={`/api/artist/apple/avatar?artistId=${artist.artistId}`}
              alt={artist.name}
              className="h-32 w-32 shrink-0 rounded-full object-cover shadow-lg"
              onError={() => setAvatarStage('wiki')}
            />
          ) : (
            // kw/mg 链无官方照：直接落维基档
            <img
              src={`/api/artist/avatar?name=${encodeURIComponent(artist.name)}`}
              alt={artist.name}
              className="h-32 w-32 shrink-0 rounded-full object-cover shadow-lg"
              onError={() => setAvatarStage('album')}
            />
          )
        ) : avatarStage === 'appleEndpoint' ? (
          <img
            src={`/api/artist/apple/avatar?artistId=${artist.artistId}`}
            alt={artist.name}
            className="h-32 w-32 shrink-0 rounded-full object-cover shadow-lg"
            onError={() => setAvatarStage('wiki')}
          />
        ) : avatarStage === 'wiki' ? (
          <img
            src={`/api/artist/avatar?name=${encodeURIComponent(artist.name)}`}
            alt={artist.name}
            className="h-32 w-32 shrink-0 rounded-full object-cover shadow-lg"
            onError={() => setAvatarStage('album')}
          />
        ) : artist.img ? (
          <RemoteCoverImage src={artist.img} alt="" className="h-32 w-32 shrink-0 rounded-full object-cover shadow-lg" />
        ) : (
          <div className="flex h-32 w-32 items-center justify-center rounded-full bg-gradient-to-br from-primary/50 to-primary/10 shadow-lg">
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

      {/* 档案 chips（kw 链=生日/国籍；apple 链=Wikidata 结构化档案） */}
      {artist.profile ? (
        <div className="mb-3 flex flex-wrap gap-1.5 text-xs">
          {artist.profile.birthDate && <span className="rounded-md bg-card px-2 py-1 text-muted-foreground ring-1 ring-border">出生 {artist.profile.birthDate}</span>}
          {(artist.profile.occupations || []).slice(0, 4).map(o => <span key={o} className="rounded-md bg-card px-2 py-1 text-muted-foreground ring-1 ring-border">{o}</span>)}
          {(artist.profile.genres || []).slice(0, 4).map(g => <span key={g} className="rounded-md bg-primary/10 px-2 py-1 text-primary ring-1 ring-primary/30">{g}</span>)}
          {(artist.profile.recordLabels || []).slice(0, 3).map(l => <span key={l} className="rounded-md bg-card px-2 py-1 text-muted-foreground ring-1 ring-border">{l}</span>)}
          {artist.profile.nationality && <span className="rounded-md bg-card px-2 py-1 text-muted-foreground ring-1 ring-border">{artist.profile.nationality}</span>}
        </div>
      ) : (artist.birthDate || artist.country) ? (
        <div className="mb-3 flex flex-wrap gap-1.5 text-xs">
          {artist.birthDate && <span className="rounded-md bg-card px-2 py-1 text-muted-foreground ring-1 ring-border">出生 {artist.birthDate}</span>}
          {artist.country && <span className="rounded-md bg-card px-2 py-1 text-muted-foreground ring-1 ring-border">{artist.country}</span>}
        </div>
      ) : null}

      {/* 简介（kw 链=酷我百科；apple 链=维基） */}
      {artist.bio && (
        <details className="mb-6 rounded-lg bg-card p-4 ring-1 ring-border" open>
          <summary className="cursor-pointer text-sm font-medium">简介</summary>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{artist.bio}</p>
        </details>
      )}

      {/* 热门歌曲 */}
      <h2 className="mb-3 text-lg font-semibold">热门歌曲 <span className="text-sm font-normal text-muted-foreground">（{tracks.length} 首，{activeSource === 'kw' ? '酷我' : activeSource === 'mg' ? '咪咕' : activeSource === 'tx' ? 'QQ音乐' : 'Apple'} 热门度）</span></h2>
      {tracks.length > 0 ? (
        <>
          <SongList tracks={visibleTracks} />
          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-center gap-3">
              <button
                onClick={() => { setPage(p => Math.max(1, p - 1)); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                disabled={currentPage <= 1}
                className="rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
              >
                上一页
              </button>
              <span className="text-sm text-muted-foreground">{currentPage} / {totalPages} 页</span>
              <button
                onClick={() => { setPage(p => Math.min(totalPages, p + 1)); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                disabled={currentPage >= totalPages}
                className="rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
              >
                下一页
              </button>
            </div>
          )}
        </>
      ) : (
        <EmptyState icon={Music} title="暂无可播热门歌曲" description="该歌手的歌曲未能匹配到可播放版本" />
      )}

      {/* 专辑 */}
      {detail.albums.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-lg font-semibold">专辑 <span className="text-sm font-normal text-muted-foreground">（{detail.albums.length} 张）</span></h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {detail.albums.map(a => (
              <Link
                key={`${a.source}-${a.albumId}`}
                to={`/album/${a.source}/${a.albumId}?name=${encodeURIComponent(a.name)}&singer=${encodeURIComponent(a.artist || artist.name)}`}
                className="group flex flex-col gap-2 rounded-lg p-2 hover:bg-accent/40"
              >
                <div className="flex aspect-square items-center justify-center overflow-hidden rounded bg-gradient-to-br from-primary/30 to-primary/10">
                  {a.source === 'apple' ? (
                    <img
                      src={`/api/album/apple/cover?collectionId=${a.albumId}`}
                      alt={a.name}
                      loading="lazy"
                      className="h-full w-full object-cover transition group-hover:scale-105"
                      onError={e => { e.currentTarget.style.display = 'none' }}
                    />
                  ) : (
                    <ChainAlbumCover
                      img={a.img}
                      alt={a.name}
                      proxySrc={`/api/album/cover?source=${a.source}&albumid=${encodeURIComponent(a.albumId)}&name=${encodeURIComponent(a.name)}&singer=${encodeURIComponent(a.artist || artist.name)}`}
                      className="h-full w-full object-cover transition group-hover:scale-105"
                    />
                  )}
                </div>
                <div className="truncate text-sm font-medium">{a.name}</div>
                <div className="truncate text-xs text-muted-foreground">{a.year ? a.year.slice(0, 4) : ''}</div>
              </Link>
            ))}
          </div>
        </>
      )}

      {/* MV（Apple amp 数据，跨链通用增强；30 秒预告） */}
      {mvs.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-lg font-semibold flex items-center gap-2">
            <Clapperboard className="h-5 w-5" /> MV <span className="text-sm font-normal text-muted-foreground">（{mvs.length} 支 · 30 秒预告）</span>
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {mvs.map(mv => (
              <button
                key={mv.id}
                onClick={() => mv.previewUrl && setPlayingMv(mv)}
                disabled={!mv.previewUrl}
                className="group flex flex-col gap-2 rounded-lg p-2 text-left hover:bg-accent/40"
              >
                <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded bg-gradient-to-br from-primary/30 to-primary/10">
                  {mv.artwork ? (
                    <img
                      src={mv.artwork}
                      alt={mv.name}
                      loading="lazy"
                      className="h-full w-full object-cover transition group-hover:scale-105"
                      onError={e => { e.currentTarget.style.display = 'none' }}
                    />
                  ) : null}
                  <span className="absolute inset-0 flex items-center justify-center opacity-0 transition group-hover:opacity-100">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/60">
                      <Play className="h-5 w-5 fill-current text-white" />
                    </span>
                  </span>
                  <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-xs text-white">
                    {Math.floor(mv.durationSec / 60)}:{String(mv.durationSec % 60).padStart(2, '0')}
                  </span>
                </div>
                <div className="truncate text-sm font-medium">{mv.name}</div>
              </button>
            ))}
          </div>
        </>
      )}

      {/* MV 预告播放弹窗 */}
      {playingMv && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setPlayingMv(null)}>
          <div className="w-full max-w-3xl" onClick={e => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <div className="truncate text-sm font-medium text-white">{playingMv.name} · 30 秒预告</div>
              <button onClick={() => setPlayingMv(null)} className="rounded-full p-1 text-white/80 hover:bg-white/10" aria-label="关闭">
                <X className="h-5 w-5" />
              </button>
            </div>
            <video
              src={playingMv.previewUrl ?? undefined}
              controls
              autoPlay
              className="w-full rounded-lg bg-black"
            />
          </div>
        </div>
      )}
    </div>
  )
}

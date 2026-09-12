import { useEffect, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { CheckSquare, Disc3, Download, Play, RefreshCw, X } from 'lucide-react'
import { SongList } from '@/components/shared/SongList'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { AlbumCover } from '@@/components/shared/AlbumCover'
import { usePlayerStore } from '@/lib/store/player-store'
import { toTrack, type Track } from '@/lib/types/player'
import { useDownload } from '@/hooks/useDownload'
import { QUALITY_LABEL } from '@/lib/quality-options'
import { getLocalAlbumTracks, getAppleAlbumTracks } from '@/lib/api/album'
import type { Song } from '@/lib/types/music'

/** 专辑详情页（双模式）：gid = 本地专辑库倒查；source+albumId = 平台专辑详情兜底。 */
export function AlbumDetailPage() {
  const { gid = '', source = '', albumId = '' } = useParams<{ gid: string; source: string; albumId: string }>()
  const [searchParams] = useSearchParams()
  const name = searchParams.get('name') || undefined
  const singer = searchParams.get('singer') || undefined
  const isLocal = !!gid

  const [detail, setDetail] = useState<{
    album: { name: string; singer: string; trackCount?: number; img?: string | null; source?: string; albumId?: string }
    list: Song[]
  } | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const playTrack = usePlayerStore(s => s.playTrack)
  const navigate = useNavigate()

  const load = async () => {
    if (isLocal) {
      setLoading(true); setError(null); setUnsupported(false)
      try {
        const r = await getLocalAlbumTracks(gid)
        setDetail(r.album ? { album: r.album, list: r.list } : null)
        setUnsupported(!r.album)
      } catch (err) {
        setDetail(null); setError(err instanceof Error ? err.message : '专辑详情获取失败')
      } finally { setLoading(false) }
      return
    }
    // Apple 平台专辑（搜索兜底卡片）：Apple 曲目表 → 逐首落歌
    if (source === 'apple' && albumId) {
      setLoading(true); setError(null); setUnsupported(false)
      try {
        const r = await getAppleAlbumTracks(albumId)
        setDetail({ album: r.album, list: r.list })
        setUnsupported(!!r.unsupported)
      } catch (err) {
        setDetail(null); setError(err instanceof Error ? err.message : '专辑详情获取失败')
      } finally { setLoading(false) }
      return
    }
    setDetail(null); setError('不支持的音源'); setLoading(false)
  }

  useEffect(() => {
    void load()
    // 参数变化时重新请求；load 是本组件内函数，无需作为依赖项。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gid, source, albumId, name, singer])

  const tracks: Track[] = (detail?.list ?? []).map(song => toTrack({ uid: song.uid, musicInfo: song }))

  // ---------- 批量下载（勾选模式，与歌单详情一致） ----------
  const [selecting, setSelecting] = useState(false)
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set())
  const quality = usePlayerStore(s => s.quality)
  const { downloadBatch } = useDownload()

  const toggleSelect = (track: Track) => {
    setSelectedUids(prev => {
      const next = new Set(prev)
      if (next.has(track.uid)) next.delete(track.uid)
      else next.add(track.uid)
      return next
    })
  }
  const allSelected = tracks.length > 0 && selectedUids.size === tracks.length
  const toggleSelectAll = () => {
    setSelectedUids(allSelected ? new Set() : new Set(tracks.map(t => t.uid)))
  }
  const handleBatchDownload = () => {
    if (selectedUids.size === 0) return
    if (selectedUids.size > 100) {
      alert('单次打包最多 100 首，请分批下载')
      return
    }
    if (!confirm(`打包下载选中的 ${selectedUids.size} 首（音质偏好：${QUALITY_LABEL[quality]}）？`)) return
    downloadBatch([...selectedUids], quality)
    setSelecting(false)
    setSelectedUids(new Set())
  }

  if (loading) return <div className="p-6"><LoadingSkeleton /></div>

  if (!detail || unsupported || tracks.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Disc3}
          title={unsupported ? '本地专辑库未收录该专辑' : error ? '专辑详情获取失败' : '专辑暂无可播放曲目'}
          description={error || (unsupported ? '部分曲目未能匹配到可播放版本' : '稍后重试或换个专辑')}
        />
        <div className="text-center">
          <button
            onClick={() => navigate('/search')}
            className="rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            返回搜索
          </button>
        </div>
      </div>
    )
  }

  const album = detail.album

  return (
    <div className="p-6">
      <div className="mb-6 flex items-end gap-4">
        <div className="h-32 w-32 shrink-0 overflow-hidden rounded-lg shadow-lg">
          {isLocal ? (
            <AlbumCover gid={gid} alt={album.name} className="h-full w-full" />
          ) : album.img ? (
            <img src={album.img} alt={album.name} className="h-full w-full object-cover" onError={e => { e.currentTarget.style.display = 'none' }} />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/50 to-primary/10">
              <Disc3 className="h-12 w-12 text-primary-foreground/80" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            专辑
          </p>
          <h1 className="truncate text-3xl font-bold">{album.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {album.singer} · {tracks.length} 首
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => tracks[0] && playTrack(tracks[0], tracks)}
              disabled={tracks.length === 0}
              className="flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              <Play className="h-4 w-4 fill-current" /> 播放全部
            </button>
            <button
              onClick={() => { setSelecting(v => !v); setSelectedUids(new Set()) }}
              className="flex items-center gap-1 rounded-full border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              {selecting ? <X className="h-4 w-4" /> : <Download className="h-4 w-4" />} {selecting ? '取消选择' : '批量下载'}
            </button>
            <button
              onClick={() => void load()}
              className="rounded-full border border-border p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="刷新"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {selecting && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-card px-3 py-2 ring-1 ring-border">
          <button onClick={toggleSelectAll} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <CheckSquare className={`h-4 w-4 ${allSelected ? 'text-primary' : ''}`} />
            {allSelected ? '取消全选' : '全选'}
          </button>
          <span className="text-sm text-muted-foreground">已选 {selectedUids.size} 首</span>
          <div className="flex-1" />
          <button
            onClick={handleBatchDownload}
            disabled={selectedUids.size === 0}
            className="flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Download className="h-4 w-4" /> 下载选中
          </button>
        </div>
      )}

      <SongList
        tracks={tracks}
        selectionMode={selecting}
        selectedUids={selectedUids}
        onToggleSelect={(t) => toggleSelect(t)}
      />
    </div>
  )
}

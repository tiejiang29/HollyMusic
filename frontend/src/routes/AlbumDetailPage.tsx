import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { CheckSquare, Disc3, Download, Play, RefreshCw, X } from 'lucide-react'
import { SongList } from '@/components/shared/SongList'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { RemoteCoverImage } from '@/components/shared/RemoteCoverImage'
import { SourceBadge } from '@/components/shared/SourceBadge'
import { usePlayerStore } from '@/lib/store/player-store'
import { toTrack, type Track } from '@/lib/types/player'
import { useDownload } from '@/hooks/useDownload'
import { QUALITY_LABEL } from '@/lib/quality-options'
import { getAlbumTracks, type AlbumSource } from '@/lib/api/album'

const ALBUM_SOURCE_SET: AlbumSource[] = ['wy', 'kw', 'mg']

export function AlbumDetailPage() {
  const { source = '', albumId = '' } = useParams<{ source: string; albumId: string }>()
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getAlbumTracks>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const playTrack = usePlayerStore(s => s.playTrack)
  const navigate = useNavigate()

  const validSource = ALBUM_SOURCE_SET.includes(source as AlbumSource)

  const load = async () => {
    if (!validSource || !albumId) {
      setDetail(null)
      setError('不支持的音源')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await getAlbumTracks(source as AlbumSource, albumId)
      setDetail(result)
    } catch (err) {
      setDetail(null)
      setError(err instanceof Error ? err.message : '专辑详情获取失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // source / albumId 变化时重新请求；load 是本组件内函数，无需作为依赖项。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, albumId])

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

  if (!detail || detail.unsupported || detail.list.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Disc3}
          title={detail?.unsupported ? '该音源暂不支持专辑详情' : error ? '专辑详情获取失败' : '专辑不存在或暂无曲目'}
          description={error || (detail?.unsupported ? '咪咕专辑卡片可直接搜索，详情待上游接口恢复' : '稍后重试或换个音源搜索')}
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
        {album?.img ? (
          <RemoteCoverImage src={album.img} alt="" className="h-32 w-32 shrink-0 rounded-lg object-cover shadow-lg" />
        ) : (
          <div className="flex h-32 w-32 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/50 to-primary/10 shadow-lg">
            <Disc3 className="h-12 w-12 text-primary-foreground/80" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            专辑 {album && <SourceBadge source={album.source} />}
          </p>
          <h1 className="truncate text-3xl font-bold">{album?.name || '未知专辑'}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {album?.singer}
            {album?.publishTime ? ` · ${album.publishTime.slice(0, 4)}` : ''}
            {` · ${tracks.length} 首`}
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

import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { CheckSquare, Disc3, Download, Play, RefreshCw, X } from 'lucide-react'
import { SongList } from '@/components/shared/SongList'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { AlbumCover } from '@@/components/shared/AlbumCover'
import { usePlayerStore } from '@/lib/store/player-store'
import { toTrack, type Track } from '@/lib/types/player'
import { useDownload } from '@/hooks/useDownload'
import { QUALITY_LABEL } from '@/lib/quality-options'
import { getLocalAlbumTracks } from '@/lib/api/album'

export function AlbumDetailPage() {
  const { gid = '' } = useParams<{ gid: string }>()
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getLocalAlbumTracks>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const playTrack = usePlayerStore(s => s.playTrack)
  const navigate = useNavigate()

  const load = async () => {
    if (!gid) {
      setDetail(null)
      setError('缺少专辑标识')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await getLocalAlbumTracks(gid)
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
    // gid 变化时重新请求；load 是本组件内函数，无需作为依赖项。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gid])

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
          title={detail?.unsupported ? '本地专辑库未收录该专辑' : error ? '专辑详情获取失败' : '专辑暂无可播放曲目'}
          description={error || (detail?.unsupported ? '换个关键词搜索，或浏览推荐/随机专辑' : '部分曲目未能匹配到可播放版本')}
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
  const partial = album.trackCount > tracks.length

  return (
    <div className="p-6">
      <div className="mb-6 flex items-end gap-4">
        <div className="h-32 w-32 shrink-0 overflow-hidden rounded-lg shadow-lg">
          <AlbumCover gid={gid} alt={album?.name} className="h-full w-full" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted-foreground">专辑</p>
          <h1 className="truncate text-3xl font-bold">{album.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {album.singer} · {partial ? `可播 ${tracks.length}/${album.trackCount} 首` : `${tracks.length} 首`}
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

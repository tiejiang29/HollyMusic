import { useParams, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { usePlaylistDetail } from '@/hooks/usePlaylistDetail'
import { SongList } from '@/components/shared/SongList'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { Play, Trash2, Music, Share2, Sparkles, Download, CheckSquare, X } from 'lucide-react'
import { usePlayerStore } from '@/lib/store/player-store'
import { shareContent, buildPlaylistShareUrl } from '@/lib/share'
import { toTrack, type Track } from '@/lib/types/player'
import { deletePlaylist } from '@/lib/api/playlists'
import { SourceSwitchDialog } from '@@/components/playlists/SourceSwitchDialog'
import { useDownload } from '@/hooks/useDownload'
import { QUALITY_LABEL } from '@/lib/quality-options'

export function PlaylistDetailPage() {
  const { id: idStr } = useParams<{ id: string }>()
  const id = parseInt(idStr ?? '0', 10)
  const { detail, loading, reload } = usePlaylistDetail(id)
  const playTrack = usePlayerStore(s => s.playTrack)
  const navigate = useNavigate()

  // 保留每条 track 对应的 entry position（换源接口按 position 替换）
  const positions: number[] = []
  const tracks: Track[] = (detail?.entries ?? [])
    .filter(e => {
      if (!e.musicInfo) return false
      positions.push(e.position)
      return true
    })
    .map(e => toTrack({ uid: e.songId, musicInfo: e.musicInfo! }))

  const [switchTarget, setSwitchTarget] = useState<{ track: Track; position: number } | null>(null)

  // ---------- 批量下载（勾选模式） ----------
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
    if (!confirm(`打包下载选中的 ${selectedUids.size} 首（音质偏好：${QUALITY_LABEL[quality]}）？`)) return
    downloadBatch([...selectedUids], quality)
    setSelecting(false)
    setSelectedUids(new Set())
  }

  const handleToggleSource = (track: Track, index: number) => {
    setSwitchTarget({ track, position: positions[index] ?? 0 })
  }

  const handleDelete = async () => {
    if (!confirm('删除该歌单？')) return
    try {
      await deletePlaylist(id)
      navigate('/playlists')
    } catch (e) {
      alert(e instanceof Error ? e.message : '删除失败')
    }
  }

  return (
    <div className="p-6">
      {loading ? (
        <LoadingSkeleton />
      ) : !detail ? (
        <EmptyState icon={Music} title="歌单不存在" />
      ) : (
        <>
          <div className="mb-6 flex items-end gap-4">
            <div className="flex h-32 w-32 shrink-0 items-center justify-center rounded bg-gradient-to-br from-primary/30 to-primary/10">
              <Music className="h-12 w-12 text-primary/70" />
            </div>
            <div className="flex-1">
              <h1 className="text-3xl font-bold">{detail.name}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {detail.songCount} 首 · {detail.username}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => tracks.length > 0 && playTrack(tracks[0], tracks)}
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
                  onClick={() => navigate(`/playlists/${id}/ai-add`)}
                  className="flex items-center gap-1 rounded-full bg-primary/15 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/25"
                >
                  <Sparkles className="h-4 w-4" /> AI 加歌
                </button>
                <button
                  onClick={handleDelete}
                  className="flex items-center gap-1 rounded-full border border-border px-3 py-2 text-sm text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" /> 删除歌单
                </button>
                <button
                  onClick={() =>
                    shareContent({
                      title: detail.name,
                      text: `歌单：${detail.name}`,
                      url: buildPlaylistShareUrl(id),
                    })
                  }
                  className="flex items-center gap-1 rounded-full border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
                >
                  <Share2 className="h-4 w-4" /> 分享歌单
                </button>
              </div>
            </div>
          </div>
          {tracks.length > 0 ? (
            <>
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
                onToggleSource={handleToggleSource}
                selectionMode={selecting}
                selectedUids={selectedUids}
                onToggleSelect={(t) => toggleSelect(t)}
              />
            </>
          ) : (
            <EmptyState icon={Music} title="歌单为空" description="去搜索并添加歌曲" />
          )}

          {switchTarget && (
            <SourceSwitchDialog
              playlistId={id}
              track={switchTarget.track}
              position={switchTarget.position}
              onClose={() => setSwitchTarget(null)}
              onReplaced={() => void reload()}
            />
          )}
        </>
      )}
    </div>
  )
}

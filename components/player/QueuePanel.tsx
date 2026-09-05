
import { useEffect, useState } from 'react'
import { usePlayerStore } from '@/lib/store/player-store'
import { CoverImage } from '@/components/shared/CoverImage'
import { X, Trash2, Download, Check, CheckSquare } from 'lucide-react'
import { useDownload } from '@/hooks/useDownload'
import { QUALITY_LABEL } from '@/lib/quality-options'
import type { Track } from '@/lib/types/player'

/** 勾选框：外层命中区 + 内层 20px 视觉方框（与 SongRow 选择模式同款） */
function QueueCheckbox({ selected, label, onToggle }: { selected: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={label}
      onClick={onToggle}
      className="-m-2 shrink-0 rounded p-2 transition hover:bg-accent/50 pointer-coarse:-m-1 pointer-coarse:p-1.5"
    >
      <span
        className={`flex h-5 w-5 items-center justify-center rounded border transition ${
          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50'
        }`}
      >
        {selected && <Check className="h-3.5 w-3.5" />}
      </span>
    </button>
  )
}

export function QueuePanel() {
  const isOpen = usePlayerStore(s => s.isQueueOpen)
  const setQueueOpen = usePlayerStore(s => s.setQueueOpen)
  const queue = usePlayerStore(s => s.queue)
  const playNextQueue = usePlayerStore(s => s.playNextQueue)
  const isCurrentTempPlay = usePlayerStore(s => s.isCurrentTempPlay)
  const currentTrack = usePlayerStore(s => s.currentTrack)
  const currentIndex = usePlayerStore(s => s.currentIndex)
  const playTrack = usePlayerStore(s => s.playTrack)
  const removeFromQueue = usePlayerStore(s => s.removeFromQueue)
  const clearQueue = usePlayerStore(s => s.clearQueue)
  const playFromPlayNext = usePlayerStore(s => s.playFromPlayNext)
  const removeFromPlayNext = usePlayerStore(s => s.removeFromPlayNext)
  const clearPlayNext = usePlayerStore(s => s.clearPlayNext)
  const quality = usePlayerStore(s => s.quality)
  const { downloadBatch } = useDownload()

  // ---------- 多选下载 ----------
  const [selecting, setSelecting] = useState(false)
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set())

  // 可选歌曲全集：插播中的当前曲 + 下一首播放 + 主队列
  const selectableTracks: Track[] = [
    ...(isCurrentTempPlay && currentTrack ? [currentTrack] : []),
    ...playNextQueue,
    ...queue,
  ]

  const toggleSelect = (track: Track) => {
    setSelectedUids(prev => {
      const next = new Set(prev)
      if (next.has(track.uid)) next.delete(track.uid)
      else next.add(track.uid)
      return next
    })
  }
  const allSelected = selectableTracks.length > 0 && selectedUids.size === selectableTracks.length
  const toggleSelectAll = () => {
    setSelectedUids(allSelected ? new Set() : new Set(selectableTracks.map(t => t.uid)))
  }
  const exitSelecting = () => {
    setSelecting(false)
    setSelectedUids(new Set())
  }
  const handleBatchDownload = () => {
    if (selectedUids.size === 0) return
    if (!confirm(`打包下载选中的 ${selectedUids.size} 首（音质偏好：${QUALITY_LABEL[quality]}）？`)) return
    downloadBatch([...selectedUids], quality)
    exitSelecting()
  }

  const downloadQueue = () => {
    const uids = [...new Set([...playNextQueue, ...queue].map(t => t.uid))]
    if (uids.length === 0) return
    if (!confirm(`打包下载队列 ${uids.length} 首（音质偏好：${QUALITY_LABEL[quality]}）？`)) return
    downloadBatch(uids, quality)
  }

  // WAI-ARIA 对话框模式：Esc 关闭（输入框聚焦时除外，避免打断输入）；
  // 选择模式中 Esc 先退选择，再关面板
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const t = e.target
      if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (selecting) exitSelecting()
      else setQueueOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // 面板关闭时清空选择状态
  useEffect(() => {
    if (!isOpen && selecting) exitSelecting()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onClick={() => setQueueOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="播放队列"
    >
      <div
        className="safe-area-top flex h-full w-full max-w-md flex-col bg-card"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border p-4">
          <h2 className="shrink-0 font-semibold">播放队列（{queue.length + playNextQueue.length}）</h2>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={() => (selecting ? exitSelecting() : setSelecting(true))}
              disabled={selectableTracks.length === 0}
              className={`touch-target flex items-center justify-center rounded-full transition disabled:opacity-40 ${
                selecting ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
              aria-label={selecting ? '取消多选' : '多选下载'}
              title={selecting ? '取消多选' : '多选下载'}
            >
              <CheckSquare className="h-4 w-4" />
            </button>
            <button
              onClick={downloadQueue}
              disabled={queue.length + playNextQueue.length === 0}
              className="touch-target flex items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
              aria-label="下载队列"
              title="打包下载整个队列"
            >
              <Download className="h-4 w-4" />
            </button>
            <button
              onClick={clearQueue}
              className="touch-target flex items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="清空"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button
              onClick={() => setQueueOpen(false)}
              className="touch-target flex items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="关闭"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {/* 正在播放的插播曲（主队列游标冻结，该曲播完回到下方队列高亮处继续） */}
          {isCurrentTempPlay && currentTrack && (
            <div className="mb-2 border-b border-border pb-2">
              <div className="px-2 pb-1 text-xs text-muted-foreground">正在播放 · 插播</div>
              <div className={`flex items-center gap-3 rounded-md bg-accent p-2 ${selecting ? '' : ''}`}>
                {selecting && (
                  <QueueCheckbox
                    selected={selectedUids.has(currentTrack.uid)}
                    label={`选择 ${currentTrack.name}`}
                    onToggle={() => toggleSelect(currentTrack)}
                  />
                )}
                <button
                  onClick={() => selecting && toggleSelect(currentTrack)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <CoverImage uid={currentTrack.uid} className="h-10 w-10" />
                  <div className="min-w-0">
                    <div className="truncate text-sm text-primary">{currentTrack.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{currentTrack.artist}</div>
                  </div>
                </button>
              </div>
            </div>
          )}
          {/* 手动插播区（"下一首播放"/"加入队列"），优先于主队列播放，播完即出队 */}
          {playNextQueue.length > 0 && (
            <div className="mb-2 border-b border-border pb-2">
              <div className="flex items-center justify-between px-2 pb-1">
                <span className="text-xs font-medium text-muted-foreground">
                  下一首播放（{playNextQueue.length}）
                </span>
                <button
                  onClick={clearPlayNext}
                  className="touch-target flex items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="清空下一首播放"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {playNextQueue.map((t, i) => (
                <div key={`${t.uid}-next-${i}`} className="group flex items-center gap-3 rounded-md p-2 hover:bg-accent/50">
                  {selecting && (
                    <QueueCheckbox
                      selected={selectedUids.has(t.uid)}
                      label={`选择 ${t.name}`}
                      onToggle={() => toggleSelect(t)}
                    />
                  )}
                  <button
                    onClick={() => (selecting ? toggleSelect(t) : playFromPlayNext(i))}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <CoverImage uid={t.uid} className="h-10 w-10" />
                    <div className="min-w-0">
                      <div className="truncate text-sm">{t.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{t.artist}</div>
                    </div>
                  </button>
                  {!selecting && (
                    <button
                      onClick={() => removeFromPlayNext(i)}
                      className="touch-target flex items-center justify-center rounded-full text-muted-foreground opacity-70 hover:text-foreground focus-visible:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100"
                      aria-label="移除"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {queue.length === 0 && playNextQueue.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">队列为空</div>
          ) : (
            queue.map((t, i) => (
              <div
                key={`${t.uid}-${i}`}
                className={`group flex items-center gap-3 rounded-md p-2 ${
                  i === currentIndex ? 'bg-accent' : 'hover:bg-accent/50'
                }`}
              >
                {selecting && (
                  <QueueCheckbox
                    selected={selectedUids.has(t.uid)}
                    label={`选择 ${t.name}`}
                    onToggle={() => toggleSelect(t)}
                  />
                )}
                <button
                  onClick={() => (selecting ? toggleSelect(t) : playTrack(t, queue))}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <CoverImage uid={t.uid} cacheKey={t.musicInfo.img} className="h-10 w-10" />
                  <div className="min-w-0">
                    <div className={`truncate text-sm ${i === currentIndex ? 'text-primary' : ''}`}>
                      {t.name}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{t.artist}</div>
                  </div>
                </button>
                {!selecting && (
                  <button
                    onClick={() => removeFromQueue(i)}
                    className="touch-target flex items-center justify-center rounded-full text-muted-foreground opacity-70 hover:text-foreground focus-visible:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100"
                    aria-label="移除"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        {/* 选择模式底部工具条 */}
        {selecting && (
          <div className="safe-area-bottom flex items-center gap-2 border-t border-border px-4 py-3">
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
      </div>
    </div>
  )
}

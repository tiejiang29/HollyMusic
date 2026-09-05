
import { useEffect, useState } from 'react'
import { X, ArrowLeftRight, Loader2, CheckCircle2 } from 'lucide-react'
import { SourceBadge } from '@/components/shared/SourceBadge'
import { apiGet, apiPost } from '@/lib/api/client'
import { toast } from '@/lib/toast'
import type { Track } from '@/lib/types/player'

interface AlternativeItem {
  source: string
  intervalMatched: boolean
  musicInfo: {
    source: string
    songmid: string
    name: string
    singer: string
    interval?: string
    albumName?: string
    img?: string
    uid: string
  }
}

/**
 * 手动换源弹窗：在其它平台找同款歌，选中后原位替换歌单条目
 */
export function SourceSwitchDialog({
  playlistId,
  track,
  position,
  onClose,
  onReplaced,
}: {
  playlistId: number
  track: Track
  position: number
  onClose: () => void
  onReplaced: () => void
}) {
  const [list, setList] = useState<AlternativeItem[]>([])
  const [loading, setLoading] = useState(true)
  const [replacing, setReplacing] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams({
      name: track.name,
      singer: track.artist ?? '',
      interval: track.musicInfo?.interval ?? '',
      source: track.source,
    })
    apiGet<{ list: AlternativeItem[] }>(`music/alternatives?${params}`)
      .then(r => setList(r.list ?? []))
      .catch(err => {
        toast.error(`获取候选失败：${err instanceof Error ? err.message : String(err)}`)
        onClose()
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.uid])

  const replace = async (item: AlternativeItem) => {
    const key = `${item.source}-${item.musicInfo.songmid}`
    setReplacing(key)
    try {
      await apiPost(`playlists/${playlistId}/replace-entry`, {
        position,
        musicInfo: { source: item.source, songmid: item.musicInfo.songmid },
      })
      toast.info(`已换源：${track.source} → ${item.source}`)
      onReplaced()
      onClose()
    } catch (err) {
      toast.error(`换源失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setReplacing(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-xl bg-card shadow-lg" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex min-w-0 items-center gap-2">
            <ArrowLeftRight className="h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">换源</p>
              <p className="truncate text-xs text-muted-foreground">
                {track.name} · {track.artist}（当前 <SourceBadge source={track.source} />）
              </p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-full p-1 text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 正在其他平台搜索同款…
            </div>
          ) : list.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              未在其他平台找到同名歌曲
            </p>
          ) : (
            list.map(item => {
              const key = `${item.source}-${item.musicInfo.songmid}`
              return (
                <button
                  key={key}
                  disabled={replacing !== null}
                  onClick={() => void replace(item)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-accent/50 disabled:opacity-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{item.musicInfo.name}</span>
                      <SourceBadge source={item.source} />
                      {item.intervalMatched && (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" aria-label="时长精确匹配" />
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {item.musicInfo.singer}
                      {item.musicInfo.interval ? ` · ${item.musicInfo.interval}` : ''}
                    </p>
                  </div>
                  {replacing === key ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                  ) : (
                    <span className="shrink-0 text-xs text-muted-foreground">替换</span>
                  )}
                </button>
              )
            })
          )}
        </div>
        <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          带 ✓ 的时长精确匹配；替换后原位置不变，歌曲改为所选平台版本
        </p>
      </div>
    </div>
  )
}

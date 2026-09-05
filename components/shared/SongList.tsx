
import { SongRow } from './SongRow'
import type { Track } from '@/lib/types/player'

interface SongListProps {
  tracks: Track[]
  /** 手动换源回调（透传给 SongRow，行内显示换源按钮） */
  onToggleSource?: (track: Track, index: number) => void
  /** 榜单模式：序号 1-3 强调显示（透传给 SongRow） */
  rankMode?: boolean
  /** 勾选模式（透传给 SongRow；配合 selectedUids/onToggleSelect，行点击变为勾选） */
  selectionMode?: boolean
  selectedUids?: Set<string>
  onToggleSelect?: (track: Track, index: number) => void
}

export function SongList({
  tracks,
  onToggleSource,
  rankMode,
  selectionMode,
  selectedUids,
  onToggleSelect,
}: SongListProps) {
  if (tracks.length === 0) return null
  return (
    <div className="flex flex-col">
      {tracks.map((t, i) => (
        <SongRow
          key={`${t.uid}-${i}`}
          track={t}
          queue={tracks}
          index={i}
          onToggleSource={onToggleSource}
          rankMode={rankMode}
          selectionMode={selectionMode}
          selected={selectionMode ? selectedUids?.has(t.uid) ?? false : undefined}
          onToggleSelect={onToggleSelect}
        />
      ))}
    </div>
  )
}


import { SongRow } from './SongRow'
import type { Track } from '@/lib/types/player'

interface SongListProps {
  tracks: Track[]
  /** 手动换源回调（透传给 SongRow，行内显示换源按钮） */
  onToggleSource?: (track: Track, index: number) => void
}

export function SongList({ tracks, onToggleSource }: SongListProps) {
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
        />
      ))}
    </div>
  )
}

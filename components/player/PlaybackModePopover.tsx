/**
 * 播放模式下拉（渲染于 PlayerControls）。
 *
 * 点击不再循环切换，而是弹出全部模式列表，单击直接选择。
 * 浮层实现与 QualityPopover 一致：手撸 fixed + 测量触发器锚点向上展开，
 * outside-click + ESC 关闭。
 */
import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Repeat, Repeat1, Shuffle, Check } from 'lucide-react'
import { usePlayerStore } from '@/lib/store/player-store'
import type { PlaybackMode } from '@/lib/types/player'

const MODE_ITEMS: Array<{ value: PlaybackMode; label: string; Icon: typeof Repeat }> = [
  { value: 'sequence', label: '顺序播放', Icon: Repeat },
  { value: 'loop', label: '单曲循环', Icon: Repeat1 },
  { value: 'random', label: '随机播放', Icon: Shuffle },
]

export function PlaybackModePopover() {
  const playbackMode = usePlayerStore(s => s.playbackMode)
  const setPlaybackMode = usePlayerStore(s => s.setPlaybackMode)

  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null)

  const current = MODE_ITEMS.find(m => m.value === playbackMode) ?? MODE_ITEMS[0]
  const ModeIcon = current.Icon

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setPos(null)
      return
    }
    const r = triggerRef.current.getBoundingClientRect()
    setPos({ right: window.innerWidth - r.right, bottom: window.innerHeight - r.top + 8 })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative">
      <PlayerButtonTrigger
        ref={triggerRef}
        icon={ModeIcon}
        label={current.label}
        active={playbackMode !== 'sequence'}
        open={open}
        onToggle={() => setOpen(v => !v)}
      />

      {open && pos && (
        <div
          ref={panelRef}
          role="listbox"
          aria-label="播放模式"
          className="fixed z-50 w-40 rounded-md border border-border bg-card p-1 text-sm shadow-lg"
          style={{ right: pos.right, bottom: pos.bottom }}
        >
          {MODE_ITEMS.map(({ value, label, Icon }) => {
            const selected = value === playbackMode
            return (
              <button
                key={value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setPlaybackMode(value)
                  setOpen(false)
                }}
                className={`flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition-colors hover:bg-accent ${
                  selected ? 'font-semibold text-primary' : 'text-foreground/80'
                }`}
              >
                <Icon className={`h-4 w-4 shrink-0 ${selected ? '' : 'opacity-60'}`} />
                <span className="flex-1">{label}</span>
                {selected && <Check className="h-4 w-4 shrink-0" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 触发按钮：视觉与 PlayerButton 对齐（h-10 圆形图标钮） */
const PlayerButtonTrigger = forwardRef<
  HTMLButtonElement,
  { icon: typeof Repeat; label: string; active: boolean; open: boolean; onToggle: () => void }
>(function PlayerButtonTrigger({ icon: Icon, label, active, open, onToggle }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-haspopup="listbox"
      aria-expanded={open}
      title={label}
      className={`flex h-10 w-10 items-center justify-center rounded-full transition hover:bg-accent ${
        active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      <Icon className="h-[18px] w-[18px]" />
    </button>
  )
})

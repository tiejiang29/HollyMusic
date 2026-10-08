/**
 * 「投到小爱」入口（G1 → G2 投放态）。
 *
 * 只在**服务端说就绪**时才出现（网关开着 + 有在线纳管音箱 + 配了局域网地址），
 * 没就绪就整个不显示 —— 比摆一个点了只会报错的按钮好。
 * 但一旦**已经在投**，入口必须始终可见：不然用户没有退出的地方（播放栏那条也会显示
 * 「投放到 XXX」，两处点任意一处都能退出）。
 *
 * 本地不出声是 store 那边保证的（投放态下 `loadStreamUrl` 直接返回），
 * 这个组件只管"进/出投放"和把服务端报回来的会话状态显示出来。
 */

import { useCallback, useEffect, useState } from 'react'
import { usePlayerStore } from '@/lib/store/player-store'
import { getSpeakerAvailability, type SpeakerAvailability } from '@/lib/api/speaker'
import { toast } from '@/lib/toast'
import { PlayerButton } from './PlayerButton'
import { Speaker, Loader2 } from 'lucide-react'

/**
 * `variant`：桌面播放栏用 `button`（图标按钮），手机「更多」菜单里用 `row`（一行一项，
 * 与"加入歌单/下载当前歌曲"同一形态）。两套共用同一份就绪判断与投放逻辑。
 */
export function CastToSpeaker({ variant = 'button', showLabel = false }: {
  variant?: 'button' | 'row'
  showLabel?: boolean
}) {
  const hasTrack = usePlayerStore(s => s.currentTrack !== null)
  const cast = usePlayerStore(s => s.cast)
  const startCast = usePlayerStore(s => s.startCast)
  const exitCast = usePlayerStore(s => s.exitCast)
  const [avail, setAvail] = useState<SpeakerAvailability | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    getSpeakerAvailability().then(setAvail).catch(() => setAvail(null))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (!cast && (!hasTrack || !avail?.ready)) return null

  const online = avail?.devices.find(d => d.online)
  const label = cast ? `投放到 ${cast.deviceName}` : (online ? `投到小爱（${online.name}）` : '投到小爱')

  const handleClick = async () => {
    setBusy(true)
    try {
      if (cast) {
        await exitCast(true)
        toast.success('已退出投放，本地继续播')
      } else {
        await startCast()
        toast.success(online ? `已投到 ${online.name}` : '已投到音箱')
      }
    } catch (err) {
      // 配置类失败（没填地址 / 都离线 / 多台没指定）说人话，并顺手重新问一次就绪状态：
      // 管理员刚在面板上改过地址的话，这里会立刻跟着亮起来
      toast.error(err instanceof Error ? err.message : '投送到音箱失败', 6000)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  if (variant === 'row') {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => void handleClick()}
        className={`flex w-full items-center justify-between rounded-md px-2 py-2.5 text-[11px] hover:bg-accent disabled:opacity-50 ${
          cast ? 'text-primary' : ''
        }`}
      >
        <span className="flex items-center gap-2">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Speaker className="h-4 w-4" />}
          {busy ? '处理中…' : cast ? '退出投放' : '投到小爱'}
        </span>
        <span className="text-[11px] text-muted-foreground">{cast?.deviceName ?? online?.name ?? ''}</span>
      </button>
    )
  }

  if (busy) {
    return (
      <span
        title={label}
        className="inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-primary"
      >
        <Loader2 className="h-5 w-5 animate-spin" />
        {showLabel && <span className="text-xs font-medium">处理中</span>}
      </span>
    )
  }

  return (
    <PlayerButton
      icon={Speaker}
      label={cast ? `${label}（点击退出）` : label}
      onClick={() => void handleClick()}
      showLabel={showLabel}
      active={!!cast}
    />
  )
}

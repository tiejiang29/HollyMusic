/**
 * 「投到小爱」按钮（G1）。
 *
 * 只在**服务端说就绪**时才出现（网关开着 + 有在线纳管音箱 + 配了局域网地址），
 * 没就绪就整个不显示 —— 比摆一个点了只会报错的按钮好。
 *
 * 投完不只看"云端有没有受理"：服务端会等 2 秒回读一次音箱状态，
 * 所以这里的提示能区分"在放了"和"推过去了但没声"（后者是这类设备最坑的失败形态）。
 */

import { useCallback, useEffect, useState } from 'react'
import { usePlayerStore } from '@/lib/store/player-store'
import { getSpeakerAvailability, castToSpeaker, type SpeakerAvailability } from '@/lib/api/speaker'
import { toast } from '@/lib/toast'
import { PlayerButton } from './PlayerButton'
import { Speaker, Loader2 } from 'lucide-react'

/**
 * `variant`：桌面播放栏用 `button`（图标按钮），手机「更多」菜单里用 `row`（一行一项，
 * 与"加入歌单/下载当前歌曲"同一形态）。两套共用上面那份就绪判断与投送逻辑。
 */
export function CastToSpeaker({ variant = 'button', showLabel = false }: { variant?: 'button' | 'row'; showLabel?: boolean }) {
  const uid = usePlayerStore(s => s.currentTrack?.uid ?? '')
  const [avail, setAvail] = useState<SpeakerAvailability | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    getSpeakerAvailability().then(setAvail).catch(() => setAvail(null))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (!uid || !avail?.ready) return null

  const target = avail.devices.find(d => d.online)
  const label = target ? `投到小爱（${target.name}）` : '投到小爱'

  const handleClick = async () => {
    setBusy(true)
    try {
      const result = await castToSpeaker(uid)
      if (result.playing) {
        toast.success(`已投到 ${result.deviceName}`)
      } else {
        toast.warning(result.reason ?? '推过去了但音箱没在放', 6000)
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
        onClick={handleClick}
        className="flex w-full items-center justify-between rounded-md px-2 py-2.5 text-[11px] hover:bg-accent disabled:opacity-50"
      >
        <span className="flex items-center gap-2">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Speaker className="h-4 w-4" />}
          {busy ? '投递中…' : '投到小爱'}
        </span>
        <span className="text-[11px] text-muted-foreground">{target?.name ?? ''}</span>
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
        {showLabel && <span className="text-xs font-medium">投递中</span>}
      </span>
    )
  }

  return <PlayerButton icon={Speaker} label={label} onClick={handleClick} showLabel={showLabel} />
}

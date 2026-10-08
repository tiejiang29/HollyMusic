/**
 * 投放态的"跟班"：轮询服务端会话把状态喂回 store，两次轮询之间用本地时钟把进度走顺。
 *
 * 为什么本地还要推算：设备上报的 `position` 是它自己那个时刻的值（真机实测与墙钟 1:1 走动），
 * 只按 5 秒一跳的话进度条会卡顿、歌词会整段跳。推算只影响画面，
 * **下一次轮询一律以设备报回来的真值为准**（漂移就此消化掉，不累积）。
 *
 * 读不到时不清投放态：那多半是网络抖一下，把会话清了会变成"音箱还在唱、界面已经退出"，
 * 那种不一致比进度条停一格难查得多。
 */

import { useEffect } from 'react'
import { usePlayerStore } from '@/lib/store/player-store'
import { readCastStatus } from '@/lib/api/speaker'

/** 会话状态轮询间隔：服务端自己有 5 秒物理缓存，问得更勤也不会多打小米 */
const POLL_MS = 5000
/** 本地推算的步长（与播放栏原生的 250ms 进度节流同档） */
const CLOCK_MS = 250

export function useSpeakerCast() {
  const casting = usePlayerStore(s => s.cast !== null)

  useEffect(() => {
    if (!casting) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      try {
        const { casting: view } = await readCastStatus()
        if (!stopped) usePlayerStore.getState().applyCastSnapshot(view)
      } catch {
        // 保持原状态，等下一拍
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS)
    }
    void poll()

    const clock = setInterval(() => usePlayerStore.getState().tickCastClock(CLOCK_MS / 1000), CLOCK_MS)

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      clearInterval(clock)
    }
  }, [casting])
}

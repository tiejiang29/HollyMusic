/**
 * 投放态下 store 的分流行为测试。
 *
 * 这里钉的是"本地不出声"和"操作打给音箱"这两组保证：
 * 1. **投放态里 `loadStreamUrl` 直接返回** —— 所有"换曲/切音质就 load"的路径因此自动静音，
 *    不需要逐个调用方加判断（漏掉任何一个就是两边同时出声）；
 * 2. `togglePlay / seek / next / previous / playTrack` 落到 `/api/speaker`，
 *    而且 **seek 不许去动本地那个 `seekTarget/seekNonce`**（那是引擎的跳位指令，投放态里没有可跳的对象）；
 * 3. 界面进度以服务端会话报回来的为准，本地只做乐观跟上；
 * 4. 队列变了要交出去（服务端等当前这首放完生效），睡眠定时器停的也是音箱。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const api = vi.hoisted(() => ({
  startCast: vi.fn(),
  stopCast: vi.fn(async () => ({ ok: true, casting: null })),
  skipCast: vi.fn(),
  seekCast: vi.fn(),
  controlSpeaker: vi.fn(async () => ({ ok: true, deviceName: 'X', casting: undefined })),
  setSpeakerPlaybackVolume: vi.fn(async () => ({ ok: true, deviceName: 'X', volume: 0 })),
  updateCastRest: vi.fn(),
  readCastStatus: vi.fn(async () => ({ casting: null })),
  reportPlay: vi.fn(async () => undefined),
}))

vi.mock('@/lib/api/speaker', () => ({
  startCast: api.startCast,
  stopCast: api.stopCast,
  skipCast: api.skipCast,
  seekCast: api.seekCast,
  controlSpeaker: api.controlSpeaker,
  setSpeakerPlaybackVolume: api.setSpeakerPlaybackVolume,
  updateCastRest: api.updateCastRest,
  readCastStatus: api.readCastStatus,
}))
vi.mock('@/lib/api/history', () => ({ reportPlay: api.reportPlay }))
vi.mock('@/lib/api/music', () => ({ buildAudioUrl: (uid: string) => `/api/audio?uid=${uid}`, getTrackByUid: vi.fn() }))

const { usePlayerStore } = await import('@/lib/store/player-store')
const { toTrack } = await import('@/lib/types/player')
import type { Track } from '@/lib/types/player'
import type { CastView } from '@/lib/api/speaker'

const mk = (uid: string, dur = 200): Track => toTrack({
  uid,
  musicInfo: {
    source: 'tx', songmid: uid, name: uid, singer: '歌手', albumName: '', interval: String(dur), types: [],
  } as never,
})

const view = (over: Partial<CastView> = {}): CastView => ({
  deviceID: 'D1', deviceName: '小爱音箱Play', hardware: 'L05B', uid: 'tx-a',
  posSec: 3, durSec: 200, playing: true, status: 1, volume: 40,
  windowSize: 10, pendingTracks: 5, lastError: null, ...over,
})

/** 每个用例从干净的播放状态起步（store 是模块级单例，不清会互相污染） */
function resetState(tracks: Track[], currentIdx = 0) {
  usePlayerStore.setState({
    queue: tracks,
    playNextQueue: [],
    isCurrentTempPlay: false,
    currentIndex: currentIdx,
    currentTrack: tracks[currentIdx] ?? null,
    streamUrl: '/api/audio?uid=old',
    isPlaying: true,
    currentTime: 10,
    duration: 200,
    volume: 0.8,
    isMuted: false,
    playbackMode: 'sequence',
    cast: null,
    pendingResumeSec: null,
    urlFetchError: null,
    effectiveQuality: '320k',
    bufferProgress: null,
    errorRetryCount: 0,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  for (const f of Object.values(api)) typeof f === 'function' && f.mockClear?.()
  api.startCast.mockResolvedValue(view())
  api.skipCast.mockResolvedValue(view({ uid: 'tx-b' }))
  api.seekCast.mockResolvedValue(view({ posSec: 90 }))
  api.updateCastRest.mockResolvedValue(view())
  api.controlSpeaker.mockResolvedValue({ ok: true, deviceName: 'X', casting: undefined })
  api.setSpeakerPlaybackVolume.mockResolvedValue({ ok: true, deviceName: 'X', volume: 0 })
  api.stopCast.mockResolvedValue({ ok: true, casting: null })
  resetState([mk('tx-a'), mk('tx-b'), mk('tx-c')])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('本地静音', () => {
  it('投放态下 loadStreamUrl 直接返回：不碰 streamUrl（换曲/切音质都因此不出声）', async () => {
    usePlayerStore.setState({ cast: view() })
    await usePlayerStore.getState().loadStreamUrl(mk('tx-z'))
    expect(usePlayerStore.getState().streamUrl).toBe('/api/audio?uid=old')
    expect(usePlayerStore.getState().effectiveQuality).toBe('320k')
  })

  it('起投先把本地收声：streamUrl 清空、isPlaying 先假，再拿会话状态覆盖', async () => {
    api.startCast.mockImplementation(async () => {
      const mid = usePlayerStore.getState()
      expect(mid.streamUrl).toBeNull()
      expect(mid.isPlaying).toBe(false)
      return view({ playing: true })
    })
    await usePlayerStore.getState().startCast()
    const s = usePlayerStore.getState()
    expect(s.cast?.deviceName).toBe('小爱音箱Play')
    expect(s.isPlaying).toBe(true)
    expect(s.currentTime).toBe(3)
    expect(s.duration).toBe(200)
  })

  it('交给服务端的是按播放模式算好的顺序：当前曲 + 之后的（队尾就不再有）', async () => {
    usePlayerStore.setState({ currentIndex: 1, currentTrack: mk('tx-b') })
    await usePlayerStore.getState().startCast()
    const input = api.startCast.mock.calls[0][0]
    expect(input.current.uid).toBe('tx-b')
    expect(input.rest.map((t: { uid: string }) => t.uid)).toEqual(['tx-c'])
    expect(input.loopOne).toBe(false)
  })

  it('起投失败要抛出去（按钮要能报错），并且不许留下半个会话', async () => {
    api.startCast.mockRejectedValue(new Error('有 2 台在线且都纳管，请指定要投哪一台'))
    await expect(usePlayerStore.getState().startCast()).rejects.toThrow(/指定/)
    const s = usePlayerStore.getState()
    expect(s.cast).toBeNull()
    expect(s.urlFetchError).toMatch(/指定/)
  })
})

describe('操作打给音箱', () => {
  it('投放态的播放/暂停走 controlSpeaker，不本地翻转', () => {
    usePlayerStore.setState({ cast: view({ playing: true }) })
    usePlayerStore.getState().togglePlay()
    expect(api.controlSpeaker).toHaveBeenCalledWith('pause', 'D1')
    usePlayerStore.setState({ cast: view({ playing: false }) })
    usePlayerStore.getState().togglePlay()
    expect(api.controlSpeaker).toHaveBeenLastCalledWith('resume', 'D1')
  })

  it('命令回来的会话状态即刻生效（不等下一次轮询）', async () => {
    usePlayerStore.setState({ cast: view({ playing: true }) })
    api.controlSpeaker.mockResolvedValue({ ok: true, deviceName: 'X', casting: view({ playing: false, posSec: 42 }) })
    usePlayerStore.getState().togglePlay()
    await vi.advanceTimersByTimeAsync(0)   // 把命令回来的 promise 链冲干净
    const s = usePlayerStore.getState()
    expect(s.isPlaying).toBe(false)
    expect(s.currentTime).toBe(42)
  })

  it('投放态的 seek 走服务端重推，且不去动本地引擎的 seekTarget/seekNonce', () => {
    usePlayerStore.setState({ cast: view() })
    const before = usePlayerStore.getState().seekNonce
    usePlayerStore.getState().seek(90)
    expect(api.seekCast).toHaveBeenCalledWith(90, 'D1')
    const s = usePlayerStore.getState()
    expect(s.seekNonce).toBe(before)
    expect(s.seekTarget).toBeNull()
    expect(s.currentTime).toBe(90)   // 乐观跟上，服务端会纠偏
  })

  it('下一首/上一首走服务端 skip，本地游标由回读决定', async () => {
    usePlayerStore.setState({ cast: view() })
    await usePlayerStore.getState().castMove(1)
    expect(api.skipCast).toHaveBeenCalledWith(1, 'D1')
    await usePlayerStore.getState().castMove(-1)
    expect(api.skipCast).toHaveBeenLastCalledWith(-1, 'D1')
    expect(usePlayerStore.getState().currentTrack?.uid).toBe('tx-b')
  })

  it('下一首不再走本地 next()（那会去 load 本地音频）', () => {
    usePlayerStore.setState({ cast: view() })
    usePlayerStore.getState().next()
    expect(api.skipCast).toHaveBeenCalled()
    expect(usePlayerStore.getState().streamUrl).toBe('/api/audio?uid=old')
  })

  it('单曲循环下点下一首 = 换一首继续循环：走重投而不是 skip', async () => {
    usePlayerStore.setState({ cast: view(), playbackMode: 'loop', currentIndex: 0, currentTrack: mk('tx-a') })
    await usePlayerStore.getState().castMove(1)
    expect(api.skipCast).not.toHaveBeenCalled()
    expect(api.startCast).toHaveBeenCalled()
    const input = api.startCast.mock.calls[0][0]
    expect(input.current.uid).toBe('tx-b')
    expect(input.loopOne).toBe(true)
  })

  it('播完不再由本地判定（续播归服务端看门狗）', () => {
    usePlayerStore.setState({ cast: view() })
    usePlayerStore.getState().handleTrackEnd()
    expect(api.skipCast).not.toHaveBeenCalled()
    expect(usePlayerStore.getState().streamUrl).toBe('/api/audio?uid=old')
  })

  it('投放中点了别的歌 = 换投这一首', async () => {
    usePlayerStore.setState({ cast: view() })
    await usePlayerStore.getState().playTrack(mk('tx-c'), [mk('tx-a'), mk('tx-b'), mk('tx-c')])
    expect(api.startCast).toHaveBeenCalled()
    expect(usePlayerStore.getState().currentTrack?.uid).toBe('tx-c')
    // 换投会把本地那份的 src 摘掉（引擎不再拉字节），但绝不能顺手 load 新歌
    expect(usePlayerStore.getState().streamUrl).toBeNull()
  })
})

describe('队列变更与游标回写', () => {
  it('插播/加入队列要交出去（服务端等当前这首放完生效）', () => {
    usePlayerStore.setState({ cast: view() })
    usePlayerStore.getState().addNext(mk('tx-x'))
    expect(api.updateCastRest).toHaveBeenCalled()
    const rest = api.updateCastRest.mock.calls[0][0] as Array<{ uid: string }>
    expect(rest[0].uid).toBe('tx-x')
    usePlayerStore.getState().removeFromPlayNext(0)
    expect(api.updateCastRest).toHaveBeenCalledTimes(2)
  })

  it('没在投的时候不白跑一次同步', () => {
    usePlayerStore.getState().addNext(mk('tx-x'))
    expect(api.updateCastRest).not.toHaveBeenCalled()
  })

  it('设备自己播到下一首时，界面游标跟过去（含插播消费）', () => {
    usePlayerStore.setState({
      cast: view(), playNextQueue: [mk('tx-x'), mk('tx-y')], currentIndex: 0, currentTrack: mk('tx-a'),
    })
    usePlayerStore.getState().applyCastView(view({ uid: 'tx-y' }))
    const s = usePlayerStore.getState()
    expect(s.currentTrack?.uid).toBe('tx-y')
    expect(s.playNextQueue).toEqual([])
  })

  it('服务端说没会话了就退出投放态（不许界面装作还在投）', () => {
    usePlayerStore.setState({ cast: view(), isPlaying: true })
    usePlayerStore.getState().applyCastSnapshot(null)
    expect(usePlayerStore.getState().cast).toBeNull()
    expect(usePlayerStore.getState().isPlaying).toBe(false)
  })

  it('清队列时退出投放且不续播本地', async () => {
    usePlayerStore.setState({ cast: view({ posSec: 55 }) })
    usePlayerStore.getState().clearQueue()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.stopCast).toHaveBeenCalled()
    expect(usePlayerStore.getState().pendingResumeSec).toBeNull()
    expect(usePlayerStore.getState().cast).toBeNull()
  })
})

describe('音量与退出投放', () => {
  it('拖动音量：250ms 内的连续变化只发有限几次，最后那一档一定发出去', async () => {
    usePlayerStore.setState({ cast: view({ volume: 40 }) })
    const st = usePlayerStore.getState()
    st.setCastVolume(41)
    st.setCastVolume(60)
    st.setCastVolume(80)
    expect(api.setSpeakerPlaybackVolume).toHaveBeenCalledTimes(1)   // 首个立即发
    expect(api.setSpeakerPlaybackVolume).toHaveBeenLastCalledWith(41, 'D1')
    expect(usePlayerStore.getState().cast?.volume).toBe(80)         // 界面已经是 80
    await vi.advanceTimersByTimeAsync(300)
    expect(api.setSpeakerPlaybackVolume).toHaveBeenCalledTimes(2)   // 补发落点
    expect(api.setSpeakerPlaybackVolume).toHaveBeenLastCalledWith(80, 'D1')
  })

  it('超过 0-100 的脏值不发：空串不改音量，也不把 NaN 送给小米', () => {
    usePlayerStore.setState({ cast: view({ volume: 40 }) })
    usePlayerStore.getState().setCastVolume('')
    expect(api.setSpeakerPlaybackVolume).not.toHaveBeenCalled()
    usePlayerStore.getState().setCastVolume(240)
    expect(usePlayerStore.getState().cast?.volume).toBe(100)
  })

  it('退出投放：停音箱、清会话，并带着"从音箱停下的那一秒接着放"重新加载本地', async () => {
    usePlayerStore.setState({ cast: view({ posSec: 55 }) })
    await usePlayerStore.getState().exitCast(true)
    expect(api.stopCast).toHaveBeenCalledWith('D1')
    const s = usePlayerStore.getState()
    expect(s.cast).toBeNull()
    expect(s.pendingResumeSec).toBe(55)
    expect(s.streamUrl).toBe('/api/audio?uid=tx-a')   // 本地引擎重新接管
  })

  it('退出时 stop 失败也要让用户出得来（别把人关在投放态里）', async () => {
    usePlayerStore.setState({ cast: view() })
    api.stopCast.mockRejectedValue(new Error('小爱的票已失效'))
    await expect(usePlayerStore.getState().exitCast(true)).resolves.toBeUndefined()
    expect(usePlayerStore.getState().cast).toBeNull()
  })

  it('不续播本地那种退出：不重新加载音频', async () => {
    usePlayerStore.setState({ cast: view() })
    await usePlayerStore.getState().exitCast(false)
    expect(usePlayerStore.getState().streamUrl).toBe('/api/audio?uid=old')
    expect(usePlayerStore.getState().pendingResumeSec).toBeNull()
  })
})

describe('进度平滑', () => {
  it('两次轮询之间只在"投放 + 在播"时往前推，并且不越过总长', () => {
    usePlayerStore.setState({ cast: view({ playing: true }), currentTime: 199.9, duration: 200 })
    usePlayerStore.getState().tickCastClock(0.25)
    expect(usePlayerStore.getState().currentTime).toBe(200)
    usePlayerStore.setState({ cast: view({ playing: false }) })
    const t = usePlayerStore.getState().currentTime
    usePlayerStore.getState().tickCastClock(5)
    expect(usePlayerStore.getState().currentTime).toBe(t)
  })
})

describe('睡眠定时器', () => {
  it('到点停的是音箱（走 togglePlay 这条分流，不是只翻本地的 isPlaying）', async () => {
    usePlayerStore.setState({ cast: view({ playing: true }), isPlaying: true })
    usePlayerStore.getState().cycleSleepTimer()   // 第一档 15 分钟
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    expect(api.controlSpeaker).toHaveBeenCalledWith('pause', 'D1')
  })
})

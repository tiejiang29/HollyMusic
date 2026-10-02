/**
 * 听音识曲弹窗的取消路径测试
 *
 * 钉两件事：
 * 1. 关掉弹窗要**立刻**释放麦克风轨道——以前没有取消出口，即使界面已经关了，
 *    轨道还一直占到 8 秒录满（系统录音指示灯亮着不灭），而且那次识别请求照发。
 * 2. 「正在聆听… Ns」这段 UI 真的会出现——以前 runRecognize 在采集之前就把
 *    phase 改成 recognizing，录制态与倒计时根本渲染不出来。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const playTrack = vi.hoisted(() => vi.fn())
vi.mock('@/lib/store/player-store', () => ({
  usePlayerStore: (sel: (s: { playTrack: typeof playTrack }) => unknown) => sel({ playTrack }),
}))

const { RecognizeDialog } = await import('@@/components/shared/RecognizeDialog')

/** 录出来的假音频：48kHz / 9 秒，够指纹算法用（<4 秒会被弹窗判太短） */
function fakeAudioBuffer() {
  return {
    duration: 9,
    sampleRate: 48000,
    length: 48000 * 9,
    getChannelData: () => new Float32Array(2048).fill(0.1),
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  mimeType = 'audio/webm'
  private recording = false
  constructor(public stream: MediaStream) { FakeMediaRecorder.instances.push(this) }
  start() { this.recording = true }
  stop() {
    if (!this.recording) return
    this.recording = false
    this.ondataavailable?.({ data: new Blob([new ArrayBuffer(32)]) })
    this.onstop?.()
  }
}

interface Harness {
  track: { stop: ReturnType<typeof vi.fn> }
  container: HTMLDivElement
  closes: ReturnType<typeof vi.fn>
  fetchMock: ReturnType<typeof vi.fn>
  clickMic: () => void
  clickClose: () => void
  text: () => string
}

async function mountDialog(): Promise<Harness> {
  const track = { stop: vi.fn(), kind: 'audio', label: '' }
  const stream = { getTracks: () => [track] }
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('AudioContext', class {
    decodeAudioData = vi.fn(async () => fakeAudioBuffer())
    close = vi.fn(async () => {})
  })
  const fetchMock = vi.fn(async (url: string) => new Response(
    JSON.stringify({ success: true, data: { list: [{ name: '稻香', singer: '周杰伦', song: null }] } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fetchMock)
  // jsdom 的 Blob.arrayBuffer 走真实异步任务，会把"录满 8 秒"之后的整条链卡在假定时器里；
  // 这里被测的是采集/取消/请求的编排，不是 Blob，所以换成即时完成的假实现
  vi.stubGlobal('Blob', class {
    constructor(public parts: unknown[], public opts?: { type?: string }) {}
    arrayBuffer = async () => new ArrayBuffer(64)
  })

  const closes = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | null = container && createRoot(container)
  await act(async () => { root!.render(createElement(RecognizeDialog, { open: true, onClose: closes })) })

  const byLabel = (label: string) =>
    [...container.querySelectorAll('button')].find(b => b.textContent?.includes(label) || b.getAttribute('aria-label') === label)
  const click = (el: HTMLElement | undefined) => {
    if (!el) throw new Error('找不到按钮')
    act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  }

  return {
    track, container, closes, fetchMock,
    clickMic: () => click(byLabel('麦克风识曲')),
    clickClose: () => click(byLabel('关闭')),
    text: () => container.textContent ?? '',
  }
}

const flush = async () => { await act(async () => { await Promise.resolve() }) }

beforeEach(() => {
  FakeMediaRecorder.instances = []
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('识曲弹窗的取消', () => {
  it('录制中途关弹窗：麦克风立刻释放，识别请求不发', async () => {
    const h = await mountDialog()

    h.clickMic()
    await flush()
    expect(FakeMediaRecorder.instances.length).toBe(1)

    h.clickClose()
    await flush()

    expect(h.track.stop).toHaveBeenCalledTimes(1)
    expect(h.fetchMock).not.toHaveBeenCalled()
    expect(h.closes).toHaveBeenCalledTimes(1)
  })

  it('录制阶段显示「正在聆听」并真的在倒数（不是直接跳到"正在识别"）', async () => {
    const h = await mountDialog()

    h.clickMic()
    await flush()
    expect(h.text()).toContain('正在聆听')
    expect(h.text()).not.toContain('正在识别')

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(h.text()).toContain('正在聆听… 7s')
  })

  it('不关弹窗时全流程照旧：录满 8 秒→发 /api/recognize→出候选', async () => {
    const h = await mountDialog()

    h.clickMic()
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    await flush()

    expect(h.fetchMock).toHaveBeenCalledTimes(1)
    expect(String(h.fetchMock.mock.calls[0][0])).toContain('/api/recognize')
    expect(h.text()).toContain('稻香')
    expect(h.text()).not.toContain('正在识别')
    // 正常结束也要放掉轨道
    expect(h.track.stop).toHaveBeenCalledTimes(1)
  })

  it('结果回来之前关掉：不写候选、也不报"识曲失败"', async () => {
    const h = await mountDialog()
    // 把 /api/recognize 挂住，这样才能停在"请求已发出、结果还没回"的那一刻
    // （act 会把微任务冲干净，用普通 stub 的话请求在关弹窗之前就已经完成了）
    let resolveFetch: (res: Response) => void = () => {}
    h.fetchMock.mockImplementationOnce(() => new Promise<Response>(res => { resolveFetch = res }))

    h.clickMic()
    await flush()
    await act(async () => { vi.advanceTimersByTime(8000) })
    h.clickClose()

    await act(async () => {
      resolveFetch(new Response(
        JSON.stringify({ success: true, data: { list: [{ name: '稻香', singer: '周杰伦', song: null }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ))
      await Promise.resolve()
    })

    expect(h.fetchMock).toHaveBeenCalledTimes(1)
    expect(h.text()).not.toContain('识曲失败')
    expect(h.text()).not.toContain('稻香')
  })

  it('拿不到麦克风时给的是那句人话（不是 NotAllowedError 原文）', async () => {
    const h = await mountDialog()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => { throw new DOMException('Permission denied', 'NotAllowedError') }) },
    })

    h.clickMic()
    await flush()

    expect(h.text()).toContain('麦克风不可用（需要 HTTPS 或 localhost）')
    expect(h.text()).not.toContain('NotAllowedError')
  })
})

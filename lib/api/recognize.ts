/**
 * 听音识曲 API（前端封装）
 * POST /api/recognize  body = Int16LE PCM（48kHz 单声道，4~12 秒）
 */

import { apiGet } from './client'
import type { Song } from '@/lib/types/music'

export interface RecognizeCandidate {
  name: string
  singer: string
  album?: string
  song: Song | null
}

/** PCM（Int16 ArrayBuffer）→ 候选列表（带登录 cookie 的二进制 POST） */
export async function recognizeByPcm(pcm: ArrayBuffer): Promise<RecognizeCandidate[]> {
  const resp = await fetch('/api/recognize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: pcm,
    credentials: 'include',
  })
  const j = await resp.json()
  if (!j.success) throw new Error(j.error?.message || '识曲失败')
  return j.data?.list || []
}

/** 音频采样：AudioBuffer → 48kHz 单声道 Int16（指纹器要求 48k） */
export function audioBufferTo48kMonoInt16(buffer: AudioBuffer): ArrayBuffer {
  const targetRate = 48000
  const ch = buffer.getChannelData(0)
  const ratio = buffer.sampleRate / targetRate
  const outLen = Math.floor(buffer.length / ratio)
  const pcm = new ArrayBuffer(outLen * 2)
  const view = new DataView(pcm)
  for (let i = 0; i < outLen; i++) {
    const v = Math.max(-1, Math.min(1, ch[Math.floor(i * ratio)] || 0))
    view.setInt16(i * 2, Math.round(v * 32767), true)
  }
  return pcm
}

/** 录音被取消（关弹窗）时抛这个，调用方据此静默收尾，不该弹"识曲失败" */
const cancelled = () => new DOMException('录音已取消', 'AbortError')

/**
 * 麦克风采集 N 秒 → AudioBuffer（需要 HTTPS 或 localhost）
 *
 * `signal` 是给"用户把弹窗关了"留的出口：没有它的话，即使界面已经关掉，轨道也要
 * 一直占到 8 秒录满为止（系统那个录音指示灯亮着不灭），而且那次识别请求照样会发出去。
 */
export async function recordFromMic(seconds: number, signal?: AbortSignal): Promise<AudioBuffer> {
  if (signal?.aborted) throw cancelled()
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false } })
  } catch (e) {
    // getUserMedia 原生报 NotAllowedError 之类，用户看不懂"为什么不行"。
    // 原因并到文案里（不用 Error 的 cause 选参数：SPA 的 tsconfig lib 还没到 ES2022）；
    // DOMException 不是 Error 的实例，但一样有 message，优先取它，免得把 "XxxError:" 前缀也露出来
    const reason = e instanceof Error ? e.message : (e as { message?: string })?.message || String(e)
    throw new Error(`麦克风不可用（需要 HTTPS 或 localhost）：${reason}`)
  }
  const mediaRecorder = new MediaRecorder(stream)
  const chunks: Blob[] = []
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
  const stopped = new Promise<void>(resolve => { mediaRecorder.onstop = () => resolve() })
  mediaRecorder.start()
  try {
    await new Promise<void>((resolve, reject) => {
      // onAbort 里引用 id 是安全的：它只会在 id 赋值之后被回调
      const onAbort = () => { clearTimeout(id); reject(cancelled()) }
      const id = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, seconds * 1000)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    mediaRecorder.stop()
    await stopped
  } finally {
    // 中止、正常结束、之后解码出错都走这里：轨道一定要被放掉
    stream.getTracks().forEach(t => t.stop())
  }
  const blob = new Blob(chunks, { type: mediaRecorder.mimeType })
  const arrayBuffer = await blob.arrayBuffer()
  const audioCtx = new AudioContext()
  const decoded = await audioCtx.decodeAudioData(arrayBuffer)
  await audioCtx.close()
  return decoded
}

/** 文件解码（mp3/m4a/wav/webm 等，浏览器原生解码） */
export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer()
  const audioCtx = new AudioContext()
  const decoded = await audioCtx.decodeAudioData(arrayBuffer)
  await audioCtx.close()
  return decoded
}

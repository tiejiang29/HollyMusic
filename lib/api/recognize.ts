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

/** 麦克风采集 N 秒 → AudioBuffer（需要 HTTPS 或 localhost） */
export async function recordFromMic(seconds: number): Promise<AudioBuffer> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false } })
  const mediaRecorder = new MediaRecorder(stream)
  const chunks: Blob[] = []
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
  const stopped = new Promise<void>(resolve => { mediaRecorder.onstop = () => resolve() })
  mediaRecorder.start()
  await new Promise(r => setTimeout(r, seconds * 1000))
  mediaRecorder.stop()
  await stopped
  stream.getTracks().forEach(t => t.stop())
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

import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Music, Upload, X, Loader2, Radio } from 'lucide-react'
import { toTrack } from '@/lib/types/player'
import { usePlayerStore } from '@/lib/store/player-store'
import {
  recognizeByPcm, audioBufferTo48kMonoInt16, recordFromMic, decodeAudioFile,
  type RecognizeCandidate,
} from '@/lib/api/recognize'

/**
 * 听音识曲弹窗：麦克风录制 8 秒 / 上传音频文件
 * → 48kHz 单声道 PCM → /api/recognize → 候选列表（点击播放）
 * 麦克风需要 HTTPS 或 localhost；文件识曲无此限制。
 */
export function RecognizeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'recognizing' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<RecognizeCandidate[]>([])
  const [countdown, setCountdown] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const playTrack = usePlayerStore(s => s.playTrack)

  const reset = useCallback(() => {
    setPhase('idle'); setError(null); setCandidates([]); setCountdown(0)
  }, [])

  useEffect(() => { if (open) reset() }, [open, reset])

  // 麦克风倒计时
  useEffect(() => {
    if (phase !== 'recording') return
    const timer = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000)
    return () => clearInterval(timer)
  }, [phase])

  const runRecognize = useCallback(async (getBuffer: () => Promise<AudioBuffer>) => {
    setPhase('recognizing'); setError(null)
    try {
      const buffer = await getBuffer()
      // 太短的音频直接报错（指纹至少需要 4 秒）
      if (buffer.duration < 4) throw new Error('音频太短（至少需要 4 秒）')
      const pcm = audioBufferTo48kMonoInt16(buffer)
      const list = await recognizeByPcm(pcm)
      setCandidates(list)
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : '识曲失败')
      setPhase('error')
    }
  }, [])

  const startMic = useCallback(async () => {
    setCountdown(8)
    setPhase('recording'); setError(null)
    try {
      await runRecognize(() => recordFromMic(8))
    } catch (e) {
      setError(e instanceof Error ? e.message : '麦克风不可用（需要 HTTPS 或 localhost）')
      setPhase('error')
    }
  }, [runRecognize])

  const handleFile = useCallback(async (file: File) => {
    await runRecognize(() => decodeAudioFile(file))
  }, [runRecognize])

  if (!open) return null

  const play = (c: RecognizeCandidate) => {
    if (!c.song) return
    const tracks = candidates.filter(x => x.song).map(x => toTrack({ uid: x.song!.uid, musicInfo: x.song! }))
    playTrack(toTrack({ uid: c.song.uid, musicInfo: c.song }), tracks)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-card p-5 ring-1 ring-border" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold"><Music className="h-4 w-4" /> 听音识曲</h2>
          <button onClick={onClose} className="rounded-full p-1 text-muted-foreground hover:bg-accent" aria-label="关闭"><X className="h-4 w-4" /></button>
        </div>

        {phase === 'idle' && (
          <div className="space-y-3">
            <button
              onClick={() => void startMic()}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              <Mic className="h-5 w-5" /> 麦克风识曲（录制 8 秒）
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <Upload className="h-4 w-4" /> 上传音频文件（mp3/m4a/wav）
            </button>
            <input
              ref={fileInputRef} type="file" accept="audio/*,.mp3,.m4a,.wav,.webm,.ogg" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = '' }}
            />
            <p className="text-center text-xs text-muted-foreground">识曲由网易 shazam 引擎驱动，结果自动匹配 TX 可播源</p>
          </div>
        )}

        {phase === 'recording' && (
          <div className="flex flex-col items-center gap-4 py-6">
            <div className="relative flex h-20 w-20 items-center justify-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-primary/30" />
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary">
                <Mic className="h-7 w-7 text-primary-foreground" />
              </span>
            </div>
            <p className="text-sm text-muted-foreground">正在聆听… {countdown}s</p>
          </div>
        )}

        {phase === 'recognizing' && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">正在识别…</p>
          </div>
        )}

        {phase === 'error' && (
          <div className="space-y-3 py-4 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <button onClick={reset} className="rounded-full border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-accent">重试</button>
          </div>
        )}

        {phase === 'done' && (
          <div className="space-y-2">
            {candidates.length === 0 ? (
              <div className="py-6 text-center">
                <Radio className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">没有识别到匹配的歌曲</p>
                <p className="mt-1 text-xs text-muted-foreground/70">试试录副歌部分，或换更清晰的音源</p>
              </div>
            ) : candidates.map((c, i) => (
              <button
                key={i}
                onClick={() => play(c)}
                disabled={!c.song}
                className="flex w-full items-center gap-3 rounded-lg p-3 text-left transition hover:bg-accent disabled:opacity-50"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{c.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {c.singer}{c.album ? ` · ${c.album}` : ''} {!c.song && ' · 无可播源'}
                  </span>
                </span>
                {c.song && <Music className="h-4 w-4 shrink-0 text-primary" />}
              </button>
            ))}
            <button onClick={reset} className="mt-1 w-full rounded-full border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-accent">再识一次</button>
          </div>
        )}
      </div>
    </div>
  )
}

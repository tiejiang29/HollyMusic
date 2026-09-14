/**
 * 听音识曲服务（网易 shazam_v2 指纹方案，全部免鉴权实测）
 *
 * 链路：前端采集 48kHz 单声道 PCM（Int16LE，麦克风或文件解码+重采样）
 *   → 本服务 lib/recognize 指纹器（网易官方 Chrome 扩展提取的 wasm 实现）
 *   → POST interface.music.163.com/api/music/audio/match（form-urlencoded）
 *   → 候选（歌名/歌手/专辑，取前 3）
 *   → 每个候选走 TX 搜歌附可播 uid
 *
 * 注意：
 * - 指纹器要求 48kHz（44.1k 直接报错），前端负责重采样
 * - 识别取段建议从音频 30%~50% 处取 6 秒（前奏/空白段命中率低）
 * - 返回的候选可能是翻唱（网易库排序偏好），前端展示多候选由用户选择
 */

import { logger } from '@/lib/logger'
import { searchOneSource } from '@/lib/services/song-search-service'
import type { Song } from '@/lib/types/music'

export interface RecognizeCandidate {
  name: string
  singer: string
  album?: string
  /** 匹配到的可播歌曲（TX 搜索附 uid；搜索失败为 null） */
  song: Song | null
}

import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

/** 指纹子进程：lib/recognize/worker.js（绕开 Next 打包对 __dirname/wasm 路径的破坏） */
async function encodeViaWorker(pcmInt16: Buffer, sampleRate: number, fromSec: number, lenSec: number): Promise<string | null> {
  const workerPath = path.join(process.cwd(), 'lib', 'recognize', 'worker.js')
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', d => { stdout += d })
    child.on('error', err => { logger.warn('[recognize] worker 启动失败:', err.message); resolve(null) })
    child.on('close', () => {
      // wasm 噪声与结果混在 stdout，取最后一个可解析 JSON 行
      const lines = stdout.split('\n').filter(l => l.trim().startsWith('{'))
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const j = JSON.parse(lines[i])
          if (j.ok && j.encoded) return resolve(String(j.encoded))
          if (j.ok === false) { logger.warn('[recognize] 指纹失败:', j.error); return resolve(null) }
        } catch { /* 下一行 */ }
      }
      resolve(null)
    })
    // PCM 写临时文件（Windows 管道传大 payload 会截断），worker 读后自删
    const pcmFile = path.join(os.tmpdir(), 'holly-rec-' + crypto.randomUUID() + '.pcm')
    fs.writeFileSync(pcmFile, pcmInt16)
    child.stdin.write(JSON.stringify({ pcmFile, sampleRate, fromSec, lenSec }))
    child.stdin.end()
  })
}

interface MatchResult {
  song?: { name?: string; artists?: Array<{ name?: string }>; album?: { name?: string } }
}

/** 指纹 → 网易识曲接口 → 候选列表 */
async function matchFingerprint(rawdata: string, durationSec: number): Promise<MatchResult[]> {
  const form = new URLSearchParams({
    sessionId: crypto.randomUUID(),
    algorithmCode: 'shazam_v2',
    duration: String(durationSec),
    rawdata,
    times: '2',
    decrypt: '1',
  })
  const resp = await fetch('https://interface.music.163.com/api/music/audio/match', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      origin: 'chrome-extension://pgphbbekcgpfaekhcbjamjjkegcclhhd',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(10_000),
  })
  if (!resp.ok) throw new Error(`match HTTP ${resp.status}`)
  const j = await resp.json() as { code?: number; data?: { result?: MatchResult[] } }
  if (j.code !== 200) throw new Error(`match code=${j.code}`)
  return j.data?.result || []
}

/** 歌名清洗：去 DJ版/翻唱/AI/饭制/装饰括号等标记，恢复原始歌名用于搜原曲 */
function cleanSongName(name: string): string {
  let n = name
  for (let i = 0; i < 3; i++) {
    // 剥尾部版本括号：(DJ版) (Live) 【AI...】(翻自...) 等
    n = n.replace(/\s*[(【\[](?:DJ|Live|Remix|翻唱|AI|饭制|feat\.|Cover|cover|翻自)[^)】\]]*[)】\]]\s*$/i, '')
    // 剥尾部裸标记
    n = n.replace(/\s*(DJ\s*版|Remix\s*版|翻唱版|饭制版|Live\s*版|AI\s*版)\s*$/i, '')
    // 剥头部装饰【...】
    n = n.replace(/^\s*【[^】]*】\s*/, '')
  }
  // 去前缀 emoji/装饰符
  n = n.replace(/^[\p{So}\p{Sk}\s·]+/u, '').trim()
  return n || name
}

/** 候选歌名+歌手 → TX 搜歌挑可播（歌名/歌手双重校验） */
async function findPlayable(name: string, singer: string): Promise<Song | null> {
  const cleanName = cleanSongName(name)
  try {
    const keyword = `${cleanName} ${singer}`.trim()
    const result = await searchOneSource('tx', keyword, 1, 10)
    const norm = (v: string | null | undefined) => (v || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    const nameN = norm(cleanName)
    const singerN = norm(singer)
    const hit = (result.list || []).find(s => {
      const sn = norm(s.name)
      if (!sn.includes(nameN) && !nameN.includes(sn)) return false
      if (!singerN) return true
      return norm(s.singer).includes(singerN) || singerN.includes(norm(s.singer))
    }) ?? (result.list || [])[0]
    return hit ?? null
  } catch (error) {
    logger.debug('[recognize] 候选搜歌失败:', error instanceof Error ? error.message : error)
    return null
  }
}

/**
 * 识曲主入口：PCM（Int16LE 48kHz 单声道，建议 6~12 秒）→ 前 3 候选（附可播 song）。
 * 从 PCM 的中部取段（避开前奏/空白）。
 */
export async function recognizeFromPcm(pcmInt16: Buffer, sampleRate = 48000, channels = 1): Promise<RecognizeCandidate[]> {
  // 预处理：声道归一（交错立体声→平均单声道）+ 重采样到 48k（指纹器硬性要求 48kHz）
  if (channels === 2 && pcmInt16.length >= 4) {
    const frames = Math.floor(pcmInt16.length / 4)
    const mono = Buffer.alloc(frames * 2)
    for (let i = 0; i < frames; i++) {
      mono.writeInt16LE(Math.round((pcmInt16.readInt16LE(i * 4) + pcmInt16.readInt16LE(i * 4 + 2)) / 2), i * 2)
    }
    pcmInt16 = mono
  }
  if (sampleRate !== 48000 && sampleRate > 0 && pcmInt16.length >= 2) {
    const srcFrames = Math.floor(pcmInt16.length / 2)
    const dstFrames = Math.floor(srcFrames * 48000 / sampleRate)
    const resampled = Buffer.alloc(dstFrames * 2)
    for (let i = 0; i < dstFrames; i++) {
      const src = Math.min(srcFrames - 1, Math.floor(i * sampleRate / 48000))
      resampled.writeInt16LE(pcmInt16.readInt16LE(src * 2), i * 2)
    }
    pcmInt16 = resampled
    sampleRate = 48000
  }
  const totalSec = pcmInt16.length / 2 / sampleRate
  if (totalSec < 4) throw new Error('音频太短（至少 4 秒）')
  // 静音检测：RMS 过低说明录到的是静音/无效音频
  let sumSq = 0
  const pcmFrames = Math.floor(pcmInt16.length / 2)
  for (let i = 0; i < pcmFrames; i++) { const v = pcmInt16.readInt16LE(i * 2); sumSq += v * v }
  const rms = Math.sqrt(sumSq / pcmFrames)
  if (rms < 100) throw new Error('采集到的音频接近静音（请检查麦克风设备或外放音量）')
  const lenSec = Math.min(6, Math.floor(totalSec))
  const fromSec = Math.max(0, Math.floor(totalSec * 0.3))

  const rawdata = await encodeViaWorker(pcmInt16, sampleRate, fromSec, lenSec)
  if (!rawdata) throw new Error('未能提取音频特征（音频内容可能无法识别，试试录副歌段）')
  const results = await matchFingerprint(rawdata, lenSec)
  if (results.length === 0) return []

  const top = results.slice(0, 3)
  const candidates = top.map(x => ({
    name: cleanSongName(x.song?.name || ''),
    singer: (x.song?.artists || []).map(a => a.name).filter(Boolean).join('/') || '',
    ...(x.song?.album?.name ? { album: x.song.album.name } : {}),
  })).filter(c => c.name)

  const withSongs = await Promise.all(candidates.map(async c => ({
    ...c,
    song: await findPlayable(c.name, c.singer),
  })))
  return withSongs
}

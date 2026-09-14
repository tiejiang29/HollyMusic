/**
 * 听音识曲服务（双引擎：酷我 8k PCM 主引擎 + 网易 shazam_v2 兜底，全部免鉴权实测）
 *
 * 主引擎：酷我 discern/inner/info
 *   PCM 8kHz s16le → base64 trait → POST wapi.kuwo.cn（免登录，明文 JSON）
 *   → 直接返回 kw-{rid} 可播歌曲（与 kw 链完美对接）
 *   归一化系数无关紧要（实测 3 种幅度全部命中）
 *
 * 兜底引擎：网易 shazam_v2
 *   PCM 48kHz → sandbox.bundle.cjs 指纹（wasm，spawn 子进程）
 *   → POST interface.music.163.com/api/music/audio/match（form-urlencoded）
 *   → 候选走 TX 搜歌附可播 uid
 *
 * 前端统一采集 48kHz 单声道 Int16LE PCM，本服务负责降采样到 8k 给酷我主引擎。
 */

import { logger } from '@/lib/logger'
import { searchOneSource } from '@/lib/services/song-search-service'
import type { Song } from '@/lib/types/music'

export interface RecognizeCandidate {
  name: string
  singer: string
  album?: string
  /** 匹配到的可播歌曲（搜索附 uid；搜索失败为 null） */
  song: Song | null
}

// ---------------------------------------------------------------------------
// 公共：音频预处理
// ---------------------------------------------------------------------------

/** 声道归一（交错立体声→平均单声道） */
function deinterleave(pcm: Buffer): Buffer {
  if (pcm.length < 4) return pcm
  const frames = Math.floor(pcm.length / 4)
  const mono = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) {
    mono.writeInt16LE(Math.round((pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) / 2), i * 2)
  }
  return mono
}

/** 线性重采样 */
function resample(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate || fromRate <= 0) return pcm
  const srcFrames = Math.floor(pcm.length / 2)
  const dstFrames = Math.floor(srcFrames * toRate / fromRate)
  const out = Buffer.alloc(dstFrames * 2)
  for (let i = 0; i < dstFrames; i++) {
    const src = Math.min(srcFrames - 1, Math.floor(i * fromRate / toRate))
    out.writeInt16LE(pcm.readInt16LE(src * 2), i * 2)
  }
  return out
}

/** 静音检测（RMS < 100 判为静音） */
function isSilence(pcm: Buffer): boolean {
  let sumSq = 0
  const frames = Math.floor(pcm.length / 2)
  if (frames === 0) return true
  for (let i = 0; i < frames; i++) { const v = pcm.readInt16LE(i * 2); sumSq += v * v }
  return Math.sqrt(sumSq / frames) < 100
}

// ---------------------------------------------------------------------------
// 主引擎：酷我识曲（8kHz PCM 免登录）
// ---------------------------------------------------------------------------

interface KwMusicResult {
  name?: string; artist?: string; album?: string
  rid?: string; mid?: string; duration?: string
}

/** PCM（任意采样率）→ 降采样 8k → base64 trait → 酷我识曲 → kw-{rid} 可播歌曲 */
async function recognizeByKuwo(pcm48k: Buffer): Promise<Song | null> {
  // 降采样到 8kHz
  const pcm8k = resample(pcm48k, 48000, 8000)
  const durationSec = Math.floor(pcm8k.length / 2 / 8000)
  if (durationSec < 3) return null

  // 取中段 3 秒（酷我接口按 recordDuration 分段识别）
  const fromByte = Math.floor(durationSec * 0.3) * 8000 * 2
  const segBytes = 3 * 8000 * 2
  const segment = pcm8k.slice(fromByte, fromByte + segBytes)

  const trait = segment.toString('base64')
  const body = JSON.stringify({ format: 'pcm', libFlag: '1', os: '2', trait, type: '0' })

  const url = `http://wapi.kuwo.cn/openapi/v1/music/discern/inner/info?appUid=0&coverSong=0&loginUid=0&recordDuration=3`
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows; U; Windows NT 5.1; en-US) AppleWebKit/534.10 (KHTML, like Gecko)',
      Referer: 'https://kuwo.cn/',
    },
    body,
    signal: AbortSignal.timeout(10_000),
  })
  if (!resp.ok) throw new Error(`kuwo discern HTTP ${resp.status}`)
  const j = await resp.json() as { code?: number; data?: { musics?: KwMusicResult[] } }
  const music = j?.data?.musics?.[0]
  if (!music?.name || !music.rid) return null

  logger.info(`[recognize] 酷我命中: ${music.name} - ${music.artist} (rid=${music.rid})`)
  // rid 就是 kw 链的 songmid → kw-{rid} 直接可播
  const result = await searchOneSource('kw', `${music.name} ${music.artist}`, 1, 5)
  const norm = (v: string | null | undefined) => (v || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const nameN = norm(music.name)
  const hit = (result.list || []).find(s => {
    const sn = norm(s.name)
    return sn.includes(nameN) || nameN.includes(sn)
  }) ?? (result.list || [])[0]
  return hit ?? null
}

// ---------------------------------------------------------------------------
// 兜底引擎：网易 shazam_v2（48kHz PCM + wasm 指纹子进程）
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import crypto from 'node:crypto'

async function encodeViaWorker(pcmInt16: Buffer, sampleRate: number, fromSec: number, lenSec: number): Promise<string | null> {
  const workerPath = path.join(process.cwd(), 'lib', 'recognize', 'worker.js')
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', d => { stdout += d })
    child.on('error', err => { logger.warn('[recognize] worker 启动失败:', err.message); resolve(null) })
    child.on('close', () => {
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
    const pcmFile = path.join(os.tmpdir(), 'holly-rec-' + crypto.randomUUID() + '.pcm')
    fs.writeFileSync(pcmFile, pcmInt16)
    child.stdin.write(JSON.stringify({ pcmFile, sampleRate, fromSec, lenSec }))
    child.stdin.end()
  })
}

interface MatchResult {
  song?: { name?: string; artists?: Array<{ name?: string }>; album?: { name?: string } }
}

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

// ---------------------------------------------------------------------------
// 公共：歌名清洗 + 可播搜索
// ---------------------------------------------------------------------------

function cleanSongName(name: string): string {
  let n = name
  for (let i = 0; i < 3; i++) {
    n = n.replace(/\s*[(【\[](?:DJ|Live|Remix|翻唱|AI|饭制|feat\.|Cover|cover|翻自)[^)】\]]*[)】\]]\s*$/i, '')
    n = n.replace(/\s*(DJ\s*版|Remix\s*版|翻唱版|饭制版|Live\s*版|AI\s*版)\s*$/i, '')
    n = n.replace(/^\s*【[^】]*】\s*/, '')
  }
  n = n.replace(/^[\p{So}\p{Sk}\s·]+/u, '').trim()
  return n || name
}

async function findPlayableOnTx(name: string): Promise<Song | null> {
  const cleanName = cleanSongName(name)
  try {
    const result = await searchOneSource('tx', cleanName, 1, 10)
    const norm = (v: string | null | undefined) => (v || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    const nameN = norm(cleanName)
    const hit = (result.list || []).find(s => {
      const sn = norm(s.name)
      return sn.includes(nameN) || nameN.includes(sn)
    }) ?? (result.list || [])[0]
    return hit ?? null
  } catch (error) {
    logger.debug('[recognize] 候选搜歌失败:', error instanceof Error ? error.message : error)
    return null
  }
}

// ---------------------------------------------------------------------------
// 识曲主入口：双引擎（酷我主 → 网易兜底）
// ---------------------------------------------------------------------------

export async function recognizeFromPcm(pcmInt16: Buffer, sampleRate = 48000, channels = 1): Promise<RecognizeCandidate[]> {
  // 预处理：声道归一 + 重采样到 48k 统一口径
  if (channels === 2 && pcmInt16.length >= 4) pcmInt16 = deinterleave(pcmInt16)
  if (sampleRate !== 48000 && sampleRate > 0 && pcmInt16.length >= 2) {
    pcmInt16 = resample(pcmInt16, sampleRate, 48000)
    sampleRate = 48000
  }
  const totalSec = pcmInt16.length / 2 / 48000
  if (totalSec < 4) throw new Error('音频太短（至少 4 秒）')
  if (isSilence(pcmInt16)) throw new Error('采集到的音频接近静音（请检查麦克风设备或外放音量）')

  // 主引擎：酷我（8k PCM 直接识别）
  try {
    const song = await recognizeByKuwo(pcmInt16)
    if (song) {
      logger.info(`[recognize] 酷我主引擎命中: ${song.name} - ${song.singer}`)
      return [{ name: song.name, singer: song.singer, ...(song.albumName ? { album: song.albumName } : {}), song }]
    }
    logger.info('[recognize] 酷我主引擎未命中，落网易兜底')
  } catch (error) {
    logger.warn('[recognize] 酷我主引擎失败，落网易兜底:', error instanceof Error ? error.message : error)
  }

  // 兜底引擎：网易 shazam_v2
  const lenSec = Math.min(6, Math.floor(totalSec))
  const fromSec = Math.max(0, Math.floor(totalSec * 0.3))
  const rawdata = await encodeViaWorker(pcmInt16, 48000, fromSec, lenSec)
  if (!rawdata) throw new Error('未能提取音频特征（音频内容可能无法识别，试试录副歌段）')
  const results = await matchFingerprint(rawdata, lenSec)
  if (results.length === 0) return []

  const top = results.slice(0, 3)
  const candidates = top.map(x => ({
    name: cleanSongName(x.song?.name || ''),
    singer: (x.song?.artists || []).map(a => a.name).filter(Boolean).join('/') || '',
    ...(x.song?.album?.name ? { album: x.song.album.name } : {}),
  })).filter(c => c.name)

  const withSongs = await Promise.all(candidates.map(async c => {
    const song = await findPlayableOnTx(c.name)
    if (song) {
      return { ...c, name: song.name, singer: song.singer, ...(song.albumName ? { album: song.albumName } : {}), song }
    }
    return { ...c, song: null }
  }))
  const seen = new Set<string>()
  return withSongs.filter(c => {
    if (!c.song) return true
    if (seen.has(c.song.uid)) return false
    seen.add(c.song.uid)
    return true
  })
}

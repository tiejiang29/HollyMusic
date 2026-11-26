import { randomUUID } from 'crypto'
import { prisma } from '../db'
import { musicSourceManager } from '../music-source-manager'
import { pickProbeSamples, verifyHead } from './source-probe'
import type { MusicInfo, QualityType } from '../types/music'

const QUALITIES: QualityType[] = ['128k', '320k', 'flac', 'flac24bit']

export class ApiInterfaceProbeError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message)
    this.name = 'ApiInterfaceProbeError'
  }
}

let running: Promise<unknown> | null = null

function sourcesOf(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function safeDetail(value: string): string {
  return value
    .replace(/https?:\/\/[^\s]+/gi, raw => {
      try {
        const url = new URL(raw)
        return `${url.origin}${url.pathname}`
      } catch {
        return '[url]'
      }
    })
    .replace(/(\b(?:api.?key|app.?key|access.?token|auth.?token|client.?secret|credential|authorization|vkey|token|secret|key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 240)
}

function urlHost(url: string): string | null {
  try { return new URL(url).host } catch { return null }
}

async function executeProbe(input: { interfaceId: string; source: string; quality: QualityType; musicInfo?: MusicInfo }) {
  const row = await prisma.apiInterface.findUnique({ where: { id: input.interfaceId } })
  if (!row) throw new ApiInterfaceProbeError('接口身份不存在', 404)
  if (!sourcesOf(row.sourcesJson).includes(input.source)) {
    throw new ApiInterfaceProbeError('该接口没有从这个音源观察到，不能跨源冒测')
  }
  let musicInfo = input.musicInfo
  if (musicInfo && musicInfo.source !== row.platform) {
    throw new ApiInterfaceProbeError('样本平台与接口平台不一致')
  }
  if (!musicInfo) {
    const samples = await pickProbeSamples(1)
    musicInfo = samples[row.platform]?.[0]
  }
  if (!musicInfo) throw new ApiInterfaceProbeError('此平台没有可用基准样本，请先播放或入库一首歌')

  let outcome = 'error'
  let detail: string | null = null
  let latencyMs: number | null = null
  let statusCode: number | null = null
  let code: string | null = null
  let msg: string | null = null
  let urlExists: boolean | null = null
  let host: string | null = null
  let container: string | null = null

  try {
    const result = await musicSourceManager.probeSourceInterface(input.source, musicInfo, input.quality, row.id)
    latencyMs = result.latencyMs
    const lane = result.usedLanes.find(item => item.interfaceId === row.id)
    statusCode = lane?.statusCode ?? null
    code = lane?.code ?? null
    msg = lane?.msg ?? null
    urlExists = lane?.urlExists ?? null
    if (result.error) {
      outcome = result.error.includes('超时') ? 'timeout' : result.error.includes('单接口测试已拦截') ? 'blocked' : 'error'
      detail = safeDetail(result.error)
    } else if (!lane) {
      outcome = 'unverified'
      detail = '脚本返回了结果，但没有观察到目标接口请求'
    } else if (!result.url) {
      outcome = 'no-address'
      detail = msg || '接口没有给出播放地址'
    } else {
      host = urlHost(result.url)
      const head = await verifyHead(result.url)
      outcome = head.outcome
      container = head.container
      detail = head.reason || msg
    }
  } catch (error) {
    detail = safeDetail(error instanceof Error ? error.message : String(error))
  }

  return prisma.apiInterfaceProbe.create({
    data: {
      id: randomUUID(),
      interfaceId: row.id,
      source: input.source,
      platform: row.platform,
      quality: input.quality,
      songmid: String(musicInfo.songmid),
      outcome,
      latencyMs,
      statusCode,
      code,
      msg,
      urlExists,
      urlHost: host,
      container,
      detail,
    },
  })
}

export async function probeApiInterface(input: {
  interfaceId: string
  source: string
  quality?: QualityType
  musicInfo?: MusicInfo
}) {
  if (running) throw new ApiInterfaceProbeError('已有一轮单接口测试在运行，请等它结束', 409)
  const quality = input.quality || '320k'
  if (!QUALITIES.includes(quality)) throw new ApiInterfaceProbeError('音质不合法')
  const task = executeProbe({ ...input, quality })
  running = task
  try {
    return await task
  } finally {
    if (running === task) running = null
  }
}

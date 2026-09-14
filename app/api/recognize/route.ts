/**
 * 听音识曲 API
 * POST /api/recognize  body = 二进制 PCM（Int16LE，48kHz，单声道，4~12 秒）
 *
 * 前端负责采集/解码/重采样（麦克风 getUserMedia 或文件 decodeAudioData），
 * 本端只做指纹（lib/recognize 网易 wasm）+ 匹配 + TX 搜歌附可播 uid。
 * 返回 { list: [{name, singer, album?, song: Song|null}] }（前 3 候选）。
 * 需登录。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { recognizeFromPcm } from '@/lib/services/recognize-service'

export const maxDuration = 30

export async function POST(request: NextRequest) {
  try {
    await requireUser(request)
    const pcm = Buffer.from(await request.arrayBuffer())
    const sampleRate = parseInt(request.nextUrl.searchParams.get('sampleRate') || '48000') || 48000
    const channels = parseInt(request.nextUrl.searchParams.get('channels') || '1') || 1
    if (pcm.length < sampleRate * channels * 2 * 4) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '音频太短（至少 4 秒）', 400)
    }
    const t = Date.now()
    const list = await recognizeFromPcm(pcm, sampleRate, channels)
    logger.info(`识曲: ${list.length} 个候选 ${Date.now() - t}ms ${list[0] ? '| 首选: ' + list[0].name + ' - ' + list[0].singer : ''}`)
    return createSuccessResponse({ list })
  } catch (error) {
    if (error instanceof AuthError) return createErrorResponse('UNAUTHORIZED', error.message, 401)
    logger.error('识曲失败:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, error instanceof Error ? error.message : '识曲失败', 500)
  }
}

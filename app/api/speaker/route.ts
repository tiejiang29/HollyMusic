/**
 * 投歌到小爱音箱（G1，登录用户可用）。
 *
 * 前端**不直连小米**：播放页/搜索结果上的「投到小爱」只调这里，小米的协议、凭据、
 * 令牌签发全在服务端。这个接口一个凭据字段都不回 —— 它连 `speaker` 的视图都不读，
 * 只告诉前端"有几台能投、网关开没开"。
 *
 * GET  /api/speaker   → 可投的音箱（纳管的、在线的）与就绪状态
 * POST /api/speaker   → { action:'play'|'pause'|'resume'|'stop'|'volume'|'status', ... }
 *
 * 错误口径与 `/api/admin/speaker` 一致：**小米侧的 401 一律降级成 502**，
 * 否则 `lib/api/client` 会把"小爱的票过期"当成"本站会话失效"，直接把用户踢下线。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { logger } from '@/lib/logger'
import { XiaomiAuthError } from '@/lib/services/xiaomi/mina-client'
import { XiaomiLoginError } from '@/lib/services/xiaomi/qr-login'
import { readSpeakerConfig } from '@/lib/services/xiaomi/token-store'
import { SpeakerError, controlSpeaker, playOnSpeaker, readSpeakerStatus, setSpeakerVolume } from '@/lib/services/xiaomi/speaker-play'

function guard(err: unknown) {
  if (err instanceof AuthError) return createErrorResponse('UNAUTHORIZED', err.message, 401)
  if (err instanceof XiaomiAuthError) {
    return err.status === 401
      ? createErrorResponse('XIAOMI_UNAUTHORIZED', err.message, 502)
      : createErrorResponse('XIAOMI_UPSTREAM_ERROR', err.message, err.status)
  }
  if (err instanceof SpeakerError) return createErrorResponse('SPEAKER_NOT_READY', err.message, err.status)
  if (err instanceof XiaomiLoginError) return createErrorResponse('INVALID_PARAMS', err.message, err.status)
  return null
}

const dev = (d: { deviceID: string; name: string; hardware: string; presence: string; managed: boolean }) => ({
  deviceID: d.deviceID, name: d.name, hardware: d.hardware, online: d.presence === 'online', managed: d.managed,
})

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const config = await readSpeakerConfig()
    const devices = config.devices.filter(d => d.managed)
    return createSuccessResponse({
      enabled: config.enabled,
      // 没配局域网地址时前端就该把按钮置灰并说明为什么，而不是等投歌时报一个看不懂的错
      ready: config.enabled && devices.some(d => d.presence === 'online') && !!config.serverHost,
      serverHostReady: !!config.serverHost,
      playQuality: config.playQuality,
      devices: devices.map(dev),
    })
  } catch (err) {
    const g = guard(err)
    if (g) return g
    logger.error('[api/speaker GET] error:', err)
    return createErrorResponse('INTERNAL_ERROR', '读取音箱状态失败', 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireUser(request)
    const body = await request.json().catch(() => ({}))
    const action = typeof body?.action === 'string' ? body.action : ''
    const deviceID = typeof body?.deviceID === 'string' && body.deviceID ? body.deviceID : undefined

    if (action === 'play') {
      const uid = typeof body?.uid === 'string' ? body.uid : ''
      if (!uid) return createErrorResponse('INVALID_PARAMS', '缺少 uid', 400)
      const result = await playOnSpeaker({ uid, deviceID })
      // 推成功但没在放，是 G1 最要紧的那类失败（亮灯不出声）：给 200 但把原因带回，前端要能显示
      return createSuccessResponse(result)
    }
    if (action === 'pause' || action === 'resume' || action === 'stop') {
      // 我们对外叫 resume，小米那条报文里的 action 是 play
      const device = await controlSpeaker(action === 'resume' ? 'play' : action, deviceID)
      return createSuccessResponse({ ok: true, deviceName: device.name })
    }
    if (action === 'volume') {
      const volume = Number(body?.volume)
      const device = await setSpeakerVolume(volume, deviceID)
      return createSuccessResponse({ ok: true, deviceName: device.name, volume })
    }
    if (action === 'status') {
      const { device, status } = await readSpeakerStatus(deviceID)
      return createSuccessResponse({ deviceName: device.name, ...status })
    }
    return createErrorResponse('INVALID_PARAMS', `未知操作：${action || '(空)'}`, 400)
  } catch (err) {
    const g = guard(err)
    if (g) return g
    logger.error('[api/speaker POST] error:', err)
    return createErrorResponse('INTERNAL_ERROR', '音箱操作失败', 500)
  }
}

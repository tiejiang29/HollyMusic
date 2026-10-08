/**
 * 投歌到小爱音箱（G1，登录用户可用）。
 *
 * 前端**不直连小米**：播放页/搜索结果上的「投到小爱」只调这里，小米的协议、凭据、
 * 令牌签发全在服务端。这个接口一个凭据字段都不回 —— 它连 `speaker` 的视图都不读，
 * 只告诉前端"有几台能投、网关开没开"。
 *
 * GET  /api/speaker   → 可投的音箱（纳管的、在线的）、就绪状态，以及**当前有没有投放会话**
 * POST /api/speaker   → 投放：cast / castRest / castSkip / seek / castStatus / castStop
 *                     → 遥控：pause / resume / stop / volume
 *                     → 单推（面板与排障用）：play / status
 *
 * 投放态的设计是"连播交给设备、尾巴交给我们"：一次推一窗（10 首），服务端看门狗在
 * 窗里最后一项快放完时补下一窗或收口。所以 `cast` 收的是**播放顺序**（当前曲 + 之后依次），
 * 顺序由前端按播放模式算好（随机也先冻结成一份列表）—— 反正亚分钟判据放不进浏览器标签页。
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
import {
  seekCast, skipCast, startCast, stopCast, castView, updateCastRest, refreshCast,
  type CastTrack,
} from '@/lib/services/xiaomi/cast-session'

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

/** 前端传来的播放顺序：只认 {uid, durSec}，脏条目直接丢（丢了也比按猜的播好） */
function readTrack(raw: unknown): CastTrack | null {
  const uid = (raw as { uid?: unknown })?.uid
  if (typeof uid !== 'string' || !uid) return null
  const dur = Number((raw as { durSec?: unknown })?.durSec)
  return { uid, durSec: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : 0 }
}

function readTracks(raw: unknown): CastTrack[] {
  if (!Array.isArray(raw)) return []
  return raw.map(readTrack).filter((t): t is CastTrack => t !== null)
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
      // 刷新页面后要能认出"还在投着"：会话在服务端，不靠前端记
      casting: await castView(),
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
    if (action === 'cast') {
      const current = readTrack(body?.current)
      if (!current) return createErrorResponse('INVALID_PARAMS', '要投哪首歌？带 current:{uid,durSec}', 400)
      const rest = readTracks(body?.rest)
      const seekSec = Number(body?.seekSec) || 0
      return createSuccessResponse(await startCast({ current, rest, deviceID, seekSec, loopOne: body?.loopOne === true }))
    }
    if (action === 'castRest') {
      // 投放期间改队列：不当场重推（重推会把正在播的这首从头放），等当前这首放完生效
      return createSuccessResponse(updateCastRest(readTracks(body?.rest), deviceID))
    }
    if (action === 'castSkip') {
      const delta = Number(body?.delta)
      return createSuccessResponse(await skipCast(delta >= 0 ? 1 : -1, deviceID))
    }
    if (action === 'seek') {
      return createSuccessResponse(await seekCast(Number(body?.sec), deviceID))
    }
    if (action === 'castStatus') {
      // 只读服务端会话，不打小米：客户端问得再勤也不会放大到小米那侧
      return createSuccessResponse({ casting: await castView(deviceID) })
    }
    if (action === 'castStop') {
      await stopCast(deviceID)
      return createSuccessResponse({ ok: true, casting: null })
    }
    if (action === 'pause' || action === 'resume' || action === 'stop') {
      // 我们对外叫 resume，小米那条报文里的 action 是 play
      const device = await controlSpeaker(action === 'resume' ? 'play' : action, deviceID)
      if (action === 'stop') {
        // 停了就等于退出投放：会话留着只会让进度条继续假装在走
        await stopCast(deviceID)
        return createSuccessResponse({ ok: true, deviceName: device.name, casting: null })
      }
      // 暂停/继续之后刷一次会话状态，进度不许按墙钟跑到声音前面
      const casting = await refreshCast(deviceID).catch(() => null)
      return createSuccessResponse({ ok: true, deviceName: device.name, casting })
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

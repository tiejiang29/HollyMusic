/**
 * 小爱音箱网关 API（仅管理员，G0：登录 + 设备列表）
 *
 * GET  /api/admin/speaker   状态视图（**只回 token 尾四位与到期时间，原值永不出网**）+ 设备表
 * POST /api/admin/speaker
 *   { action:'qrStart' }                          出一张平台渲染的二维码（base64 PNG）+ 会话口令
 *   { action:'qrPoll', sessionId, loginToken }    问一次"扫了没"；waiting 时前端 3 秒后再来
 *   { action:'devices' }                          重新拉一次设备列表
 *   { action:'setManaged', deviceID, managed }    这台纳不纳管
 *   { action:'setEnabled', enabled }              网关总开关
 *   { action:'logout' }                           清掉凭据与设备表
 *
 * 鉴权闸门与错误口径一律照 `app/api/admin/source-discovery/route.ts`，别自创一套。
 * 长轮询不在这里等满 30 秒：`qrPoll` 内部只等 8 秒就返回 waiting（把 Next 的请求槽挂住会
 * 拖垮同时进行的音频请求），过期与否由会话时间戳判，不靠前端计数。
 */
import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse } from '@/lib/api-response'
import { requireAdmin, AuthError, ForbiddenError } from '@/lib/services/user-context'
import { logger } from '@/lib/logger'
import { XiaomiLoginError, abandonQrLogin, pollQrLogin, startQrLogin } from '@/lib/services/xiaomi/qr-login'
import { XiaomiAuthError } from '@/lib/services/xiaomi/mina-client'
import {
  clearSpeakerLogin, getSpeakerView, readSpeakerConfig, saveCredentials,
  setDeviceManaged, setSpeakerEnabled, setSpeakerMusicApiDisabled,
  setSpeakerPlayQuality, setSpeakerServerHost, syncDevices,
} from '@/lib/services/xiaomi/token-store'
import { SpeakerError, controlSpeaker, playOnSpeaker, readSpeakerStatus, setSpeakerVolume } from '@/lib/services/xiaomi/speaker-play'
import { setSpeakerConversation, setSpeakerTakeover } from '@/lib/services/xiaomi/token-store'
import { parseControlRules } from '@/lib/services/xiaomi/voice-control'
import { getTakeoverLog, handleAskNow } from '@/lib/services/xiaomi/voice-takeover'
import { ensureConversationMonitor, getConversationFeed } from '@/lib/services/xiaomi/conversation-monitor'

function guard(err: unknown) {
  if (err instanceof AuthError) return createErrorResponse('UNAUTHORIZED', err.message, 401)
  if (err instanceof ForbiddenError) return createErrorResponse('FORBIDDEN', err.message, 403)
  // 票失效与参数错误要分开：前者面板要给"重新扫码"，后者只是一句报错。
  // **小米那边的 401 绝不能原样当成 HTTP 401 发出去**：`lib/api/client` 一见到 401 就作废
  // 管理员在本站的会话（hooks/useAuth 注册的处置），等于"小爱的票过期 → 把你从后台踢下线"。
  // 所以这里统一降级成 502（上游拒绝），靠 error.code 区分是"要重扫"还是"上游抽了"。
  if (err instanceof XiaomiAuthError) {
    return err.status === 401
      ? createErrorResponse('XIAOMI_UNAUTHORIZED', err.message, 502)
      : createErrorResponse('XIAOMI_UPSTREAM_ERROR', err.message, err.status)
  }
  if (err instanceof XiaomiLoginError) return createErrorResponse('INVALID_PARAMS', err.message, err.status)
  // G1 的"还没配局域网地址 / 都离线 / 多台在线没指定"这类可操作提示，都归到这个码
  if (err instanceof SpeakerError) return createErrorResponse('SPEAKER_NOT_READY', err.message, err.status)
  return null
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request)
    return createSuccessResponse(await getSpeakerView())
  } catch (err) {
    const g = guard(err)
    if (g) return g
    logger.error('[api/admin/speaker GET] error:', err)
    return createErrorResponse('INTERNAL_ERROR', '读取小爱网关状态失败', 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request)
    const body = await request.json().catch(() => ({}))
    const action = typeof body?.action === 'string' ? body.action : ''

    if (action === 'qrStart') return createSuccessResponse(await startQrLogin())

    if (action === 'qrPoll') {
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      const loginToken = typeof body?.loginToken === 'string' ? body.loginToken : ''
      if (!sessionId || !loginToken) return createErrorResponse('INVALID_PARAMS', '缺少 sessionId / loginToken', 400)
      const result = await pollQrLogin(sessionId, loginToken)
      // 只有成功那条才回凭据（且只回视图字段），失败/等待都不落凭据
      if (result.state === 'signedIn') {
        await saveCredentials(result.credentials)
        return createSuccessResponse({ state: result.state, view: await getSpeakerView() })
      }
      return createSuccessResponse(result)
    }

    if (action === 'devices') {
      const devices = await syncDevices()
      return createSuccessResponse({ devices, view: await getSpeakerView() })
    }

    if (action === 'setManaged') {
      const deviceID = typeof body?.deviceID === 'string' ? body.deviceID : ''
      if (!deviceID) return createErrorResponse('INVALID_PARAMS', '缺少 deviceID', 400)
      await setDeviceManaged(deviceID, body?.managed === true)
      return createSuccessResponse(await getSpeakerView())
    }

    if (action === 'setEnabled') {
      await setSpeakerEnabled(body?.enabled === true)
      return createSuccessResponse(await getSpeakerView())
    }

    // ---- G1：推歌相关的配置与急救控制（都在面板上，不落配置文件） ----
    if (action === 'setHost') {
      await setSpeakerServerHost(typeof body?.serverHost === 'string' ? body.serverHost : '')
      return createSuccessResponse(await getSpeakerView())
    }

    if (action === 'setQuality') {
      await setSpeakerPlayQuality(body?.quality === '128k' ? '128k' : '320k')
      return createSuccessResponse(await getSpeakerView())
    }

    if (action === 'convSet') {
      // 面板项：轮询开关 / 间隔 / 失败话术片段。开关关掉要立刻停定时器，不能等下一拍
      const view = await setSpeakerConversation({
        enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
        pollSec: body?.pollSec,
        failedAnswerHints: Array.isArray(body?.failedAnswerHints) ? body.failedAnswerHints : undefined,
      })
      // 关与开都走同一条：ensure 会读刚落库的那份开关，关着就顺手停定时器并回 enabled:false
      // （早先这里是手写两条分支，关掉时状态里的 enabled 还留着 true，面板读着别扭）
      const state = await ensureConversationMonitor()
      return createSuccessResponse({ view, state })
    }
    if (action === 'convList') {
      // 面板每几秒问一次：顺带保证"开关开着就一定有人在轮询"（定时器是内存态，进程重启会丢）
      await ensureConversationMonitor()
      return createSuccessResponse(getConversationFeed())
    }
    if (action === 'askSet') {
      const view = await setSpeakerTakeover({
        enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
        withoutEvidence: typeof body?.withoutEvidence === 'boolean' ? body.withoutEvidence : undefined,
        cutoff: body?.cutoff,
        sources: Array.isArray(body?.sources) ? body.sources : undefined,
        controlRules: body?.controlRulesText !== undefined
          ? parseControlRules(String(body.controlRulesText)) : undefined,
        volumeStep: body?.volumeStep,
        triggers: Array.isArray(body?.triggers) ? body.triggers : undefined,
      })
      return createSuccessResponse({ view })
    }
    if (action === 'askLog') {
      return createSuccessResponse({ rows: getTakeoverLog() })
    }
    if (action === 'askSimulate') {
      // **喂一条合成口令走同一条链路**（不是真话，日志里标 synthetic）。
      // 为什么要它：今天实测到对话接口回的是 0 条记录，也就是说"真实一条口令"我们
      // 还没拿到过 —— 没有这个入口，第①②层的判据就只能停在单元测试里。
      const query = typeof body?.query === 'string' ? body.query : ''
      if (!query.trim()) return createErrorResponse('INVALID_PARAMS', '要说一句什么口令？', 400)
      const config = await readSpeakerConfig()
      const device = config.devices.find(d => d.managed && d.presence === 'online') ?? config.devices[0]
      if (!device) return createErrorResponse('SPEAKER_NOT_READY', '账号下没有设备，合成不出来', 409)
      const row = {
        deviceID: device.deviceID, deviceName: device.name,
        timestampMs: Date.now(), receivedAt: Date.now(),
        query, answer: typeof body?.answer === 'string' ? body.answer : '',
        looksFailed: false, fromBaseline: false,
      }
      // 执行与否**照面板那套判据走**（含 takeoverEnabled），模拟不是后门：关着就只判不动
      return createSuccessResponse(await handleAskNow(row, { synthetic: true, config }))
    }
    if (action === 'setMusicApiDisabled') {
      const models = Array.isArray(body?.models) ? body.models.map((m: unknown) => String(m)) : []
      await setSpeakerMusicApiDisabled(models)
      return createSuccessResponse(await getSpeakerView())
    }

    // 投歌本身走 /api/speaker（登录用户就能投，不必是管理员）；面板这里只留"看与急救"
    if (action === 'status') {
      const deviceID = typeof body?.deviceID === 'string' && body.deviceID ? body.deviceID : undefined
      return createSuccessResponse(await readSpeakerStatus(deviceID))
    }

    if (action === 'control') {
      const op = body?.op === 'pause' || body?.op === 'stop' || body?.op === 'play' ? body.op : null
      if (!op) return createErrorResponse('INVALID_PARAMS', 'op 只能是 pause / stop / play', 400)
      const deviceID = typeof body?.deviceID === 'string' && body.deviceID ? body.deviceID : undefined
      const device = await controlSpeaker(op, deviceID)
      return createSuccessResponse({ ok: true, deviceName: device.name })
    }

    if (action === 'volume') {
      const deviceID = typeof body?.deviceID === 'string' && body.deviceID ? body.deviceID : undefined
      const device = await setSpeakerVolume(Number(body?.volume), deviceID)
      return createSuccessResponse({ ok: true, deviceName: device.name })
    }

    if (action === 'play') {
      // 面板上的「试推」：拿一个 uid 直接投一次，用来验地址通不通（真实入口在播放页）
      const uid = typeof body?.uid === 'string' ? body.uid : ''
      if (!uid) return createErrorResponse('INVALID_PARAMS', '缺少 uid', 400)
      const deviceID = typeof body?.deviceID === 'string' && body.deviceID ? body.deviceID : undefined
      return createSuccessResponse(await playOnSpeaker({ uid, deviceID }))
    }

    if (action === 'logout') {
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (sessionId) abandonQrLogin(sessionId)
      await clearSpeakerLogin()
      return createSuccessResponse(await getSpeakerView())
    }

    return createErrorResponse('INVALID_PARAMS', `未知操作：${action || '(空)'}`, 400)
  } catch (err) {
    const g = guard(err)
    if (g) return g
    logger.error('[api/admin/speaker POST] error:', err)
    return createErrorResponse('INTERNAL_ERROR', '小爱网关操作失败', 500)
  }
}

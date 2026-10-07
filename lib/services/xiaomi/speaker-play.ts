/**
 * 投歌到小爱音箱（G1 编排）。
 *
 * 三件事按参考实现踩过的坑排：
 * 1. **云端 `code==0` 只代表"受理"，不代表音箱在放**。所以推完 2 秒回读一次播放状态，
 *    把"亮灯不出声"这种静默失败暴露出来（`songloft-plugin-miot` 就是为这个加了异步回读）。
 * 2. **给音箱的地址必须是它够得着的局域网地址**。管理员从公网/回环看的 host 音箱多半拉不到，
 *    所以这里只认面板上配的 `speakerServerHost`，没配就明确报错，不拼一个"看着能播"的 URL。
 * 3. **推出去的 URL 带着能放歌的令牌，会经过小米云端**。所以令牌短时效、返回值与日志里
 *    都不带回完整 URL（只报长度），也绝不出现在 GET 视图里。
 *
 * 音质这一期只走 MP3（音箱听不懂 FLAC），FLAC 要等 G1.5 转码；出口那边也只认 MP3。
 */
import { logger } from '@/lib/logger'
import { resolveMusicInfoById } from '@/lib/db'
import { createShareAudioToken } from '@/lib/services/auth'
import {
  ensureFreshCredentials, readSpeakerConfig,
  type SpeakerDevice, type SpeakerPlayQuality,
} from '@/lib/services/xiaomi/token-store'
import {
  getPlayStatus, playUrl, playerOperation, setVolume,
  PLAY_STATUS_PLAYING, type PlayStatus,
} from '@/lib/services/xiaomi/mina-client'
import type { XiaomiCredentials } from '@/lib/services/xiaomi/qr-login'

/** 推完到回读的间隔：设备状态上报有延迟，太早读一定还是 0 */
const STATUS_VERIFY_DELAY_MS = 2000
/** 推给音箱那条 URL 里令牌的时效：够放完一张专辑，又不至于长期有效（它会经过小米云端） */
const SPEAKER_STREAM_TTL_SEC = 2 * 60 * 60

export class SpeakerError extends Error {
  readonly status: number
  constructor(message: string, status = 409) {
    super(message)
    this.name = 'SpeakerError'
    this.status = status
  }
}

export interface SpeakerTarget {
  device: SpeakerDevice
  url: string
  quality: SpeakerPlayQuality
}

export interface PlayOutcome {
  /** 设备端认了这条指令，且回读到的状态是在播放 */
  playing: boolean
  /** 云端/设备端有没有受理这条推歌（与"是否在放"是两件事） */
  pushed: boolean
  deviceName: string
  hardware: string
  /** 回读结果；null = 这台不报状态或回读失败 */
  status: PlayStatus | null
  /** 没在放时的人话原因 */
  reason: string | null
}

const LOOPBACK = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)/i

/**
 * 把面板上填的主机名拼成音箱能拉的绝对地址。
 * 允许写 `172.16.1.7:3099`、`172.16.1.7`、`http://…`、`https://…`；回环直接拒绝。
 */
export function buildStreamBase(serverHost: string): string {
  const raw = serverHost.trim()
  if (!raw) throw new SpeakerError('先在面板上填「音箱可达的服务地址」，我没法替音箱猜它该从哪拉流', 409)
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new SpeakerError(`服务地址没法解析：${raw}`, 400)
  }
  if (LOOPBACK.test(parsed.hostname)) {
    throw new SpeakerError(`「${parsed.hostname}」是回环地址，音箱打不开它 —— 要填这台服务在局域网里的 IP（或音箱够得着的域名）`, 409)
  }
  return `${parsed.protocol}//${parsed.host}`
}

/** 选目标音箱：显式指定 > 唯一"纳管且在线"的那台 */
export function pickDevice(devices: SpeakerDevice[], deviceID?: string): SpeakerDevice {
  if (deviceID) {
    const exact = devices.find(d => d.deviceID === deviceID)
    if (!exact) throw new SpeakerError('这台音箱不在设备列表里，先刷新设备列表', 404)
    if (exact.presence !== 'online') throw new SpeakerError(`「${exact.name}」现在离线，推过去也不会有声音`, 409)
    return exact
  }
  const online = devices.filter(d => d.managed && d.presence === 'online')
  if (online.length === 0) {
    throw new SpeakerError(
      devices.filter(d => d.managed).length > 0
        ? '纳管的音箱都离线'
        : '还没有纳管的音箱（在设备表里勾一台）',
      409,
    )
  }
  if (online.length > 1) {
    // 不猜：多台在线时随便挑一台会把歌唱到别的房间
    throw new SpeakerError(`有 ${online.length} 台在线且都纳管，请指定要投哪一台`, 409)
  }
  return online[0]
}

/** 现签一条给音箱的流地址：`st` 在第一个参数位（部分固件会把 URL 里的 & 换成空格） */
export function buildStreamUrl(base: string, uid: string, quality: SpeakerPlayQuality): string {
  const token = createShareAudioToken(uid, quality, SPEAKER_STREAM_TTL_SEC)
  return `${base}/api/speaker/stream?st=${token}&uid=${encodeURIComponent(uid)}&quality=${quality}`
}

/** 只用于日志：保留结构与长度，抹掉令牌 */
export function redactStreamUrl(url: string): string {
  return url.replace(/([?&]st=)[^&\s]+/g, '$1<令牌>')
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** 投一首歌到音箱，并回读一次状态确认它真的在放 */
export async function playOnSpeaker(opts: { uid: string; deviceID?: string }): Promise<PlayOutcome> {
  const config = await readSpeakerConfig()
  if (!config.enabled) throw new SpeakerError('小爱网关总开关是关的（面板上打开它）', 409)
  const device = pickDevice(config.devices, opts.deviceID)
  const base = buildStreamBase(config.serverHost)
  const quality = config.playQuality
  const creds = await ensureFreshCredentials()

  const musicInfo = await resolveMusicInfoById(opts.uid)
  if (!musicInfo) throw new SpeakerError(`库里找不到这首歌的地址：${opts.uid}`, 404)

  const url = buildStreamUrl(base, opts.uid, quality)
  logger.info('[xiaomi] 推歌到音箱', {
    歌曲: musicInfo.name, 音箱: device.name, 型号: device.hardware, 音质: quality,
    地址: redactStreamUrl(url).slice(0, 160),
  })

  const pushed = await playUrl(creds, device.deviceID, url, device.hardware, {
    musicApiDisabled: config.musicApiDisabledModels,
  })
  if (!pushed) {
    return {
      playing: false, pushed: false, deviceName: device.name, hardware: device.hardware,
      status: null, reason: '设备端没认这条推歌指令（云端受理了但音箱拒绝执行）',
    }
  }

  await sleep(STATUS_VERIFY_DELAY_MS)
  let status: PlayStatus | null = null
  try {
    status = await getPlayStatus(creds, device.deviceID)
  } catch (err) {
    logger.warn('[xiaomi] 推歌后回读状态失败:', err instanceof Error ? err.message.slice(0, 120) : String(err))
  }
  const playing = !!status && status.status === PLAY_STATUS_PLAYING
  return {
    playing,
    pushed: true,
    deviceName: device.name,
    hardware: device.hardware,
    status,
    reason: playing ? null : status
      ? `音箱回了状态码 ${status.status}（不是"在播"），可能是它没能拉到这条流地址`
      : '推成功了，但回读不到播放状态（这台不报状态，或云端还没更新）',
  }
}

/** 播放控制（暂停 / 继续 / 停止） */
export async function controlSpeaker(action: 'play' | 'pause' | 'stop', deviceID?: string): Promise<SpeakerDevice> {
  const config = await readSpeakerConfig()
  const device = pickDevice(config.devices, deviceID)
  const creds = await ensureFreshCredentials()
  const ok = await playerOperation(creds, device.deviceID, action)
  if (!ok) throw new SpeakerError(`音箱没认「${action}」这条指令`, 502)
  return device
}

export async function setSpeakerVolume(volume: number, deviceID?: string): Promise<SpeakerDevice> {
  if (!Number.isFinite(volume)) throw new SpeakerError('音量得是个数字', 400)
  const config = await readSpeakerConfig()
  const device = pickDevice(config.devices, deviceID)
  const creds = await ensureFreshCredentials()
  const ok = await setVolume(creds, device.deviceID, volume)
  if (!ok) throw new SpeakerError('音箱没认音量指令', 502)
  return device
}

/** 读一次当前播放状态（面板上"这台在放什么"用） */
export async function readSpeakerStatus(deviceID?: string): Promise<{ device: SpeakerDevice; status: PlayStatus }> {
  const config = await readSpeakerConfig()
  const device = pickDevice(config.devices, deviceID)
  const creds: XiaomiCredentials = await ensureFreshCredentials()
  return { device, status: await getPlayStatus(creds, device.deviceID) }
}

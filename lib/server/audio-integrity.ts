/**
 * 音频完整性校验（试听片段判定）。
 *
 * 背景：部分音源对无版权/非 VIP 歌曲返回试听片段（如 30s/60s），这些片段
 * 能正常播放，一旦落库会长期占用缓存且换源后无法自愈（缓存 key 不含
 * 音源脚本标识，命中后 0 次上游调用）。
 *
 * 策略：解析音频文件真实时长（music-metadata），与歌曲元数据 interval
 * （期望时长）对比；相差太远判定为试听——仅影响「是否落库」，不中断
 * 交付，用户可正常试听；后台换可用源后重新拉取到完整版才入库。
 */

import { parseFile } from 'music-metadata'
import { logger } from '@/lib/logger'

/** 期望时长低于该值（秒）不校验：短曲与元数据缺失场景直接放行 */
export const MIN_CHECK_INTERVAL_SEC = 120

/** 实际时长低于期望的该比例视为可疑 */
export const TRIAL_DURATION_RATIO = 0.8

/** 时长绝对差低于该值（秒）不判定：容忍平台元数据误差 */
export const TRIAL_ABS_DIFF_SEC = 30

export interface TrialCheckResult {
  /** true 表示判定为试听片段（应跳过落库 / 删除缓存） */
  trial: boolean
  /** 解析出的实际时长（秒）；null 表示未解析或未校验 */
  actualSec: number | null
}

/** 实际时长 vs 期望时长，是否明显不完整（试听片段） */
export function isIncompleteTrial(actualDurationSec: number, intervalSec: number): boolean {
  if (!Number.isFinite(intervalSec) || intervalSec < MIN_CHECK_INTERVAL_SEC) return false
  if (!Number.isFinite(actualDurationSec) || actualDurationSec <= 0) return false
  return (
    actualDurationSec < intervalSec * TRIAL_DURATION_RATIO &&
    intervalSec - actualDurationSec > TRIAL_ABS_DIFF_SEC
  )
}

/** 解析本地音频文件的真实时长（秒）；解析失败返回 null（宁放过不误杀） */
export async function parseDurationFromFile(filePath: string): Promise<number | null> {
  try {
    const meta = await parseFile(filePath)
    const duration = meta.format.duration
    if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
      return duration
    }
    return null
  } catch (e) {
    logger.debug(
      `[AudioIntegrity] 时长解析失败 ${filePath}:`,
      e instanceof Error ? e.message : e
    )
    return null
  }
}

/**
 * 校验音频文件是否为试听片段。
 * intervalSec 无效或过短（<120s）→ 不校验，返回 trial=false。
 */
export async function checkTrialAudio(
  filePath: string,
  intervalSec: number
): Promise<TrialCheckResult> {
  if (!Number.isFinite(intervalSec) || intervalSec < MIN_CHECK_INTERVAL_SEC) {
    return { trial: false, actualSec: null }
  }
  const actualSec = await parseDurationFromFile(filePath)
  if (actualSec === null) return { trial: false, actualSec: null }
  return { trial: isIncompleteTrial(actualSec, intervalSec), actualSec }
}

// --------------------------------------------------------------------------
// Content-Length 早判（2026-11-23 新增）
// --------------------------------------------------------------------------

/**
 * 上面那套要等整段下载完才认得出试听，而认出来只跳过落库、照样交付——用户先听
 * 60 秒再没声，也不会触发换源/换平台。生产实测 `api.vkeys.cn` 对 QQ 的 flac 请求
 * 有 84% 回的就是这种片段（7 首中招、声明 29~46MB、实际约 0.9MB）。
 *
 * 这里改成**拿到 Content-Length 就判**：坏载荷连第一个字节都不下，直接按假地址
 * 排除该源重试，同平台用尽后 `getMusicUrlWithProvider` 现有的跨平台换源自动接手。
 */

/**
 * 声明大小字符串（"4.03M"/"1.2G"/"512K"）→ 字节。
 * 平台按 MiB 计：生产实测声明 `31.48M` 的实际文件是 33010086B = 31.48MiB。
 * 认不出返回 null（不参与判定，宁放过不误杀）。
 */
export function parseDeclaredSizeBytes(size: string | null | undefined): number | null {
  if (!size) return null
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMG]?)\s*$/i.exec(size)
  if (!m) return null
  const num = Number(m[1])
  if (!Number.isFinite(num) || num <= 0) return null
  const unit = m[2].toUpperCase()
  const mult = unit === 'G' ? 1024 ** 3 : unit === 'M' ? 1024 ** 2 : unit === 'K' ? 1024 : 1
  const bytes = num * mult
  return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : null
}

/** 这首歌各声明档位里的最小字节数；一个都认不出 → null（表示没有声明可比） */
export function minDeclaredBytes(
  sizes: (string | null | undefined)[] | null | undefined
): number | null {
  if (!Array.isArray(sizes)) return null
  const parsed = sizes.map(parseDeclaredSizeBytes).filter((n): n is number => n !== null)
  return parsed.length > 0 ? Math.min(...parsed) : null
}

/**
 * 声明最小档的该比例以下才算"连最低档位都不够一首完整曲子"。
 *
 * 阈值由生产实测锚点定出来。**每个比值都用同一首歌自己的声明算**（分母是该歌
 * 声明里最小的 128k 档）：
 * - 坏：《天龙八部之宿敌》vkeys 60 秒片段 960887B ÷ 声明 4.03M = **0.227**
 * - 好（离阈值最近的一条）：《小孩儿》stellarwave 整曲 m4a 2559929B ÷ 声明 3.89M = **0.628**
 * - 好：《小孩儿》maflya 整曲 mp3 3032067B ÷ 同一个分母 = **0.743**
 * - 好：《亮点之暖》杰翔整曲 m4a 2154901B ÷ 声明 2.70M = **0.761**
 * - 好：拿到真无损那 8 次，CL 对自己那一档的比值精确 **1.00**
 *
 * 0.35 落在 0.227 与 0.628 之间：判死侧有 35% 余量，放过侧最近的一条还差 44%。
 * 0.5 也不会误杀今天这批样本，但离 0.628 只剩 21%，遇到码率更低的合法 AAC 就会出事。
 */
export const TRIAL_SIZE_RATIO = 0.35

/**
 * Content-Length 是否短到不可能是完整曲子。
 * 无声明（minBytes=null）、时长过短不校验（同 120s 口径）、CL 无效 → 一律放过。
 */
export function isUndersizedByContentLength(
  sizeBytes: number,
  minBytes: number | null,
  intervalSec: number
): boolean {
  if (minBytes === null) return false
  if (!Number.isFinite(intervalSec) || intervalSec < MIN_CHECK_INTERVAL_SEC) return false
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return false
  return sizeBytes < minBytes * TRIAL_SIZE_RATIO
}

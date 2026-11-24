/**
 * 播放音质选择的规范常量与工具（针对 lib/types/music.ts 的 QualityType）。
 *
 * 与 quality-utils.ts 的 QualityLevel（含 192k/unknown，供 QualityBadge 能力标签）
 * 刻意分离：本模块只关心播放器「用户偏好 + 实际播放」的音质决策。
 */
import type { QualityInfo, QualityType } from '@/lib/types/music'

/** 合法音质，按从高到低排序（index 0 = 最高） */
export const QUALITY_ORDER: QualityType[] = ['flac24bit', 'flac', '320k', '128k']

/** 合法音质集合（用于校验 localStorage 持久化值） */
export const VALID_QUALITIES: QualityType[] = ['128k', '320k', 'flac', 'flac24bit']

/** 音质按钮 / 标签的简短文案 */
export const QUALITY_LABEL: Record<QualityType, string> = {
  '320k': '320K',
  '128k': '128K',
  flac: 'FLAC',
  flac24bit: 'Hi-Res',
}

/** 音质的完整描述（下拉菜单副标题） */
export const QUALITY_TITLE: Record<QualityType, string> = {
  '320k': '320K 高品质',
  '128k': '128K 标准',
  flac: 'FLAC 无损',
  flac24bit: 'Hi-Res 无损',
}

/**
 * 从歌曲 types 提取支持的音质，按从高到低返回。
 * types 为空 / 异常时返回 []（调用方自行回退）。
 */
export function getAvailableQualities(types?: QualityInfo[]): QualityType[] {
  if (!types || types.length === 0) return []
  const present = new Set<QualityType>()
  for (const t of types) {
    if (t && (t.type as QualityType) && QUALITY_ORDER.includes(t.type)) {
      present.add(t.type)
    }
  }
  return QUALITY_ORDER.filter(q => present.has(q)) // QUALITY_ORDER 已是高→低
}

/**
 * 给定用户偏好与歌曲支持列表，返回应实际播放的音质。
 *  - 偏好∈支持 → 偏好
 *  - 否则取支持中 ≤ 偏好 的最高档（就近降级）
 *  - 若支持的都高于偏好 → 取支持的最低档（保证能播，避免服务端因 _types 缺失抛错）
 *  - 支持列表为空（数据异常）→ 返回 preference，交由服务端降级 / 报错
 */
export function resolveQuality(preference: QualityType, types?: QualityInfo[]): QualityType {
  const available = getAvailableQualities(types)
  if (available.length === 0) return preference
  if (available.includes(preference)) return preference
  const prefIdx = QUALITY_ORDER.indexOf(preference) // preference 合法时必 >= 0
  const lowerOrEqual = available.filter(q => QUALITY_ORDER.indexOf(q) >= prefIdx)
  if (lowerOrEqual.length > 0) return lowerOrEqual[0] // 最高且 ≤ 偏好
  return available[available.length - 1] // 全部高于偏好 → 最低档
}

/** 取某音质在 types 中的文件大小（无则 undefined），供 UI 展示 */
export function getSizeOf(types: QualityInfo[] | undefined, q: QualityType): string | undefined {
  return types?.find(t => t.type === q)?.size
}

/** 有损档按码率分界：实测 320k 档落在 300~399kbps，128k 档落在 100~199kbps，中间是空的 */
const LOSSY_320K_MIN_KBPS = 280

/**
 * 按**实际交付的字节**归档，供入库记账用（请求哪档 ≠ 拿到哪档）。
 *
 * 依据是 2026-11-19 对生产库 514 行 `quality='flac'` 的逐文件魔数普查：只有 447 行
 * 字节真是 `fLaC`，其余 67 行里 64 行是 `ID3`（mp3）、1 行 `OggS`（《晚秋》那份
 * 80kbps Ogg Vorbis，元数据期望 21.38M 而实收 2.0M）、1 行连已知容器都匹配不上。
 * 标错档不只是显示难看：去重那步是「库内已有同档或更高就放弃入库」，一份冒充 flac 的
 * mp3 会**永久挡住**后来真正的 flac，而库优先于在线源且没有自愈路径。
 *
 * 判据只用字节，不用元数据声明的 size：kg 那批的 `typesJson` 里只声明了 128k 一档、
 * size 还是空串，拿它当尺子量不出东西来。
 *
 * 返回 null = 下不了结论（时长或字节缺失），调用方保持旧行为。
 */
export function qualityFromBytes(input: {
  container: string | null
  sizeBytes: number
  durationSec: number
}): QualityType | null {
  if (!(input.durationSec > 0) || !(input.sizeBytes > 0)) return null
  if (input.container === 'flac') return 'flac'
  const kbps = (input.sizeBytes * 8) / 1000 / input.durationSec
  return kbps >= LOSSY_320K_MIN_KBPS ? '320k' : '128k'
}

/** 实际档位是否满足请求；FLAC 魔数无法区分 16/24bit，Hi-Res 请求按 FLAC 放行。 */
export function meetsRequestedQuality(actual: QualityType | null, requested: QualityType): boolean {
  if (!actual) return false
  if (requested === 'flac24bit' && actual === 'flac') return true
  return QUALITY_ORDER.indexOf(actual) <= QUALITY_ORDER.indexOf(requested)
}

/**
 * 返回比给定音质低一档的音质（用于解码失败时降级重试）。
 * 已是最低档（128k）时返回 null。QUALITY_ORDER 已是高→低，故降级 = index + 1。
 *
 * 刻意不看 types：降级的目的是「换一种浏览器能解的格式」（如 FLAC→MP3），
 * 即便歌曲不支持该档，服务端 getMusicUrl 也会继续降级到可播的 MP3，故无需在此过滤。
 */
export function nextLowerQuality(q: QualityType): QualityType | null {
  const idx = QUALITY_ORDER.indexOf(q)
  if (idx < 0 || idx >= QUALITY_ORDER.length - 1) return null
  return QUALITY_ORDER[idx + 1]
}

import { logger } from '@/lib/logger'
import type { MusicInfo } from '@/lib/types/music'
import { inflate } from 'zlib'
import { promisify } from 'util'
import { decodeKrcPayload, decodeQrcPayload, decodeXmlEntities, decryptQrcField, parseKrc, parseMrc, screenWordLyric, toEnhancedLrc, toPlainLrc, type WordLyric } from './word-lyric'

export type NativeLyricResult = {
  lyric: string
  tlyric: string | null
  /**
   * 逐字（增强 LRC）。给出时 `lyric` 必然出自**同一次解析**（toPlainLrc），
   * 不能拿另一条通道的行级文本配它 —— 实测两者差 10ms 级，混用会让高亮抖。
   */
  wordLyric?: string | null
}

type KuwoLyricLine = {
  time?: unknown
  lineLyric?: unknown
}

type KugouLyricCandidate = {
  id?: unknown
  accesskey?: unknown
  song?: unknown
  singer?: unknown
}

const REQUEST_TIMEOUT = 5_000
const inflateAsync = promisify(inflate)

function formatLrcTimestamp(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds))
  const minutes = Math.floor(total / 60_000)
  const seconds = Math.floor((total % 60_000) / 1_000)
  const fraction = total % 1_000
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(3, '0')}`
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response | null> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    return response.ok ? response : null
  } finally {
    clearTimeout(timeoutId)
  }
}

function decodeBase64(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  try {
    return Buffer.from(value, 'base64').toString('utf8').trim()
  } catch {
    return ''
  }
}

function parseIntervalSeconds(interval: string): number {
  const parts = interval.split(':').map(Number)
  if (parts.some(Number.isNaN)) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return Number(interval) || 0
}

function comparable(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

function titleMatches(candidate: string, expected: string): boolean {
  const candidateValue = comparable(candidate)
  const expectedValue = comparable(expected)
  return Boolean(candidateValue && expectedValue && (candidateValue.includes(expectedValue) || expectedValue.includes(candidateValue)))
}

function artistMatches(candidate: string, expected: string): boolean {
  const candidateValue = comparable(candidate)
  const expectedValue = comparable(expected)
  if (!candidateValue || !expectedValue) return true
  return candidateValue.includes(expectedValue) || expectedValue.includes(candidateValue)
}

/** 将酷我移动端的 `{ data: { lrclist } }` 响应转换为标准 LRC。 */
export function parseKuwoLyricsPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const data = (payload as { data?: unknown }).data
  if (!data || typeof data !== 'object') return null
  const lyricList = (data as { lrclist?: unknown }).lrclist
  if (!Array.isArray(lyricList)) return null

  const lines = lyricList
    .filter((line): line is KuwoLyricLine => Boolean(line) && typeof line === 'object')
    .map(line => {
      const content = typeof line.lineLyric === 'string' ? line.lineLyric.trim() : ''
      const seconds = typeof line.time === 'number' ? line.time : Number(line.time)
      if (!content || !Number.isFinite(seconds)) return null
      return `[${formatLrcTimestamp(seconds * 1_000)}]${content}`
    })
    .filter((line): line is string => line !== null)

  return lines.length > 0 ? lines.join('\n') : null
}

function parseMiguMrc(text: string): string | null {
  const lines = text.replace(/\r/g, '').split('\n').flatMap(raw => {
    const match = raw.match(/^\s*\[(\d+),\d+\](.*)$/)
    if (!match) return []
    const lyric = match[2].replace(/\(\d+,\d+\)/g, '').trim()
    return lyric ? [`[${formatLrcTimestamp(Number(match[1]))}]${lyric}`] : []
  })
  return lines.length > 0 ? lines.join('\n') : null
}

/** 咪咕 MRC 的 XXTEA 解密；实现与 lxserver 保持相同的歌曲源协议。 */
function decryptMiguMrc(data: string): string {
  if (data.length < 32) return data

  // tsconfig 仍以 ES2017 为目标，故不用 BigInt 字面量；Node 运行时支持 BigInt。
  const bigint = BigInt
  const zero = bigint(0)
  const one = bigint(1)
  const three = bigint(3)
  const six = bigint(6)
  const fiftyTwo = bigint(52)
  const two = bigint(2)
  const four = bigint(4)
  const five = bigint(5)
  const eight = bigint(8)
  const sixtyFour = bigint(64)
  const byteMask = bigint(255)
  const delta = bigint('2654435769')
  const key = [
    bigint('27303562373562475'), bigint('18014862372307051'), bigint('22799692160172081'),
    bigint('34058940340699235'), bigint('30962724186095721'), bigint('27303523720101991'),
    bigint('27303523720101998'), bigint('31244139033526382'), bigint('28992395054481524'),
  ]
  const max = bigint('9223372036854775807')
  const min = bigint('-9223372036854775808')
  const toLong = (value: bigint): bigint => {
    if (value > max) return toLong(value - (one << sixtyFour))
    if (value < min) return toLong(value + (one << sixtyFour))
    return value
  }
  const values: bigint[] = []
  for (let index = 0; index + 16 <= data.length; index += 16) values.push(toLong(BigInt(`0x${data.slice(index, index + 16)}`)))
  if (!values.length) return data

  let current = values[0]
  let sum = toLong((six + fiftyTwo / bigint(values.length)) * delta)
  while (sum !== zero) {
    const keyIndex = toLong((sum >> two) & three)
    for (let index = values.length - 1; index > 0; index--) {
      const previous = values[index - 1]
      current = toLong(values[index] - (toLong(toLong(current ^ sum) + toLong(previous ^ key[Number((bigint(index) & three) ^ keyIndex)])) ^ toLong(toLong(toLong(previous >> five) ^ toLong(current << two)) + toLong(toLong(current >> three) ^ toLong(previous << four)))))
      values[index] = current
    }
    const last = values[values.length - 1]
    current = toLong(values[0] - (toLong(toLong(key[Number(keyIndex)] ^ last) + toLong(current ^ sum)) ^ toLong(toLong(last >> five ^ current << two) + toLong(current >> three ^ last << four))))
    values[0] = current
    sum = toLong(sum - delta)
  }

  return values.map(value => {
    const buffer = Buffer.alloc(8)
    let remaining = value
    for (let index = 0; index < 8; index++) {
      buffer[index] = Number(remaining & byteMask)
      remaining >>= eight
    }
    return buffer.toString('utf16le')
  }).join('')
}

async function fetchKuwoLyric(songmid: string): Promise<NativeLyricResult | null> {
  const response = await fetchWithTimeout(
    `https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(songmid)}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } },
  )
  if (!response) return null
  const lyric = parseKuwoLyricsPayload(await response.json())
  if (lyric) return { lyric, tlyric: null }

  // 旧移动端接口对部分歌曲会返回“音乐查询失败”。与 lxserver 保持一致，
  // 此时使用歌曲 ID 请求加密歌词接口，仍是渠道内精确查询，不会退化为标题匹配。
  return fetchKuwoEncryptedLyric(songmid)
}

function buildKuwoEncryptedLyricParam(songmid: string): string {
  const plain = `user=12345,web,web,web&requester=localhost&req=1&rid=MUSIC_${songmid}&lrcx=1`
  const source = Buffer.from(plain)
  const key = Buffer.from('yeelion')
  const encoded = Buffer.alloc(source.length)
  for (let index = 0; index < source.length; index++) {
    encoded[index] = source[index] ^ key[index % key.length]
  }
  return encoded.toString('base64')
}

async function decodeKuwoEncryptedLyric(raw: Buffer): Promise<string | null> {
  const headerEnd = raw.indexOf(Buffer.from('\r\n\r\n'))
  if (!raw.subarray(0, 10).toString('utf8').toLowerCase().startsWith('tp=content') || headerEnd < 0) {
    return null
  }

  try {
    const inflated = await inflateAsync(raw.subarray(headerEnd + 4))
    const encrypted = Buffer.from(inflated.toString('utf8'), 'base64')
    const key = Buffer.from('yeelion')
    for (let index = 0; index < encrypted.length; index++) {
      encrypted[index] ^= key[index % key.length]
    }

    // 渠道数据使用 GB18030；Node 的 TextDecoder 原生支持该编码，无需引入额外依赖。
    const decoded = new TextDecoder('gb18030').decode(encrypted).trim()
    if (!decoded) return null

    // 将逐字歌词的 <start,duration> 标记还原成普通 LRC，保证通用客户端都能显示。
    const lyric = decoded.replace(/<-?\d+,-?\d+(?:,-?\d+)?>/g, '').trim()
    return /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(lyric) ? lyric : null
  } catch (error) {
    logger.debug('[lyrics] Kuwo encrypted lyric decode failed', error)
    return null
  }
}

async function fetchKuwoEncryptedLyric(songmid: string): Promise<NativeLyricResult | null> {
  const param = buildKuwoEncryptedLyricParam(songmid)
  const response = await fetchWithTimeout(`http://newlyric.kuwo.cn/newlyric.lrc?${param}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  if (!response) return null

  const lyric = await decodeKuwoEncryptedLyric(Buffer.from(await response.arrayBuffer()))
  return lyric ? { lyric, tlyric: null } : null
}

async function fetchQQMusicLyric(songmid: string): Promise<NativeLyricResult | null> {
  const params = new URLSearchParams({ songmid, g_tk: '5381', loginUin: '0', hostUin: '0', format: 'json', inCharset: 'utf8', outCharset: 'utf-8', platform: 'yqq' })
  const response = await fetchWithTimeout(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?${params}`, {
    headers: { Referer: 'https://y.qq.com/portal/player.html' },
  })
  if (!response) return null
  const payload = await response.json() as { code?: unknown; lyric?: unknown; trans?: unknown }
  if (payload.code !== 0) return null
  const lyric = decodeXmlEntities(decodeBase64(payload.lyric))
  return lyric ? { lyric, tlyric: decodeXmlEntities(decodeBase64(payload.trans)) || null } : null
}

const QQ_MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
/**
 * 免登录：实测裸 comm 就返回完整载荷（GetSession 那一步是多余的，省一次请求）。
 * 参数照 QQ 轻音乐端填，服务端只认真实字段，多带不影响。
 */
const QQ_MUSICU_COMM = {
  ct: 11, cv: '1003006', v: '1003006', os_ver: '15', phonetype: '24122RKC7C',
  rom: 'Redmi/miro/miro:15/AE3A.240806.005/OS2.0.105.0.VOMCNXM:user/release-keys',
  tmeAppID: 'qqmusiclight', nettype: 'NETWORK_WIFI', udid: '0',
}

const encodeQQName = (value: string): string => Buffer.from(value || '', 'utf8').toString('base64')

/**
 * QRC 只能按数字 songID 寻址（`songmid` 那条通道没有字时间）。没有它 tx 就没可能出
 * 原生逐字，只能去借酷狗的 KRC —— 上层据此决定要不要打这一枪。
 */
export function qqQrcSongId(musicInfo: MusicInfo): string | null {
  const songId = String(musicInfo.songId ?? '')
  return /^\d{1,12}$/.test(songId) ? songId : null
}

/** 载荷按 songID 寻址、名字只算回执，所以歌名闸门是这里唯一防串台的一道 */
function qrcBelongsToSong(lyric: WordLyric, musicInfo: MusicInfo): boolean {
  const title = lyric.headers.ti ?? ''
  const artist = lyric.headers.ar ?? ''
  return titleMatches(title, musicInfo.name) && artistMatches(artist, musicInfo.singer)
}

/**
 * QQ 云端逐字（QRC）：`GetPlayLyricInfo` 要数字 songID，`crypt:1` 回来的 `lyric` 是
 * 私有 3DES 十六进制密文（见 ./qrc-des），坐标系与咪咕 MRC 一致，故走 parseMrc。
 *
 * 实测两处必须防：`interval` 参数服务端不理（传 0 也回同一份），而 songID 一旦错位就
 * 会**整份返回另一首歌**的歌词 —— 命中后必须再核 `[ti:]`/`[ar:]`。
 */
async function fetchQQQrcLyric(musicInfo: MusicInfo): Promise<NativeLyricResult | null> {
  const songId = qqQrcSongId(musicInfo)
  if (!songId) return null

  const response = await fetchWithTimeout(QQ_MUSICU_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({
      comm: QQ_MUSICU_COMM,
      request: {
        method: 'GetPlayLyricInfo',
        module: 'music.musichallSong.PlayLyricInfo',
        param: {
          songID: Number(songId),
          songName: encodeQQName(musicInfo.name),
          singerName: encodeQQName(musicInfo.singer),
          albumName: encodeQQName(musicInfo.albumName ?? ''),
          interval: parseIntervalSeconds(musicInfo.interval),
          type: 0, qrc: 1, trans: 1, roma: 1, crypt: 1,
          lrc_t: 0, qrc_t: 0, trans_t: 0, roma_t: 0, ct: 19, cv: 2111,
        },
      },
    }),
  })
  if (!response) return null
  const payload = await response.json() as { request?: { data?: { lyric?: unknown; trans?: unknown } } }
  const data = payload.request?.data
  const cipher = typeof data?.lyric === 'string' ? data.lyric : ''
  if (!cipher) return null

  const text = decodeQrcPayload(cipher)
  const parsed = text ? parseMrc(text) : null
  if (!parsed) return null

  const verdict = screenWordLyric(parsed, { durationSeconds: parseIntervalSeconds(musicInfo.interval) })
  if (!verdict.ok) {
    logger.info('[lyrics] QQ 逐字被闸门拒绝，回落整行', { songId: musicInfo.songmid, reason: verdict.reason })
    return null
  }
  if (!qrcBelongsToSong(parsed, musicInfo)) {
    logger.warn('[lyrics] QQ 逐字歌名对不上，丢弃', {
      songId: musicInfo.songmid, 请求: musicInfo.name, 载荷: parsed.headers.ti ?? '',
    })
    return null
  }

  const trans = typeof data?.trans === 'string' && data.trans ? decryptQrcField(data.trans) : null
  logger.info('[lyrics] QQ 逐字命中', { songId: musicInfo.songmid, lineCount: verdict.lineCount })
  return { lyric: toPlainLrc(parsed), tlyric: trans?.trim() || null, wordLyric: toEnhancedLrc(parsed) }
}

async function fetchNeteaseLyric(songmid: string): Promise<NativeLyricResult | null> {
  const params = new URLSearchParams({ id: songmid, lv: '-1', tv: '-1', rv: '-1', kv: '-1' })
  const response = await fetchWithTimeout(`https://music.163.com/api/song/lyric?${params}`, {
    headers: { Referer: 'https://music.163.com/', 'User-Agent': 'Mozilla/5.0' },
  })
  if (!response) return null
  const payload = await response.json() as { lrc?: { lyric?: unknown }; tlyric?: { lyric?: unknown } }
  const lyric = typeof payload.lrc?.lyric === 'string' ? payload.lrc.lyric.trim() : ''
  return lyric ? { lyric, tlyric: typeof payload.tlyric?.lyric === 'string' ? payload.tlyric.lyric.trim() || null : null } : null
}

async function fetchMiguTranslation(musicInfo: MusicInfo, headers: Record<string, string>): Promise<string | null> {
  if (!musicInfo.trcUrl) return null
  const response = await fetchWithTimeout(musicInfo.trcUrl, { headers })
  return response ? (await response.text()).trim() || null : null
}

async function fetchMiguLyric(musicInfo: MusicInfo): Promise<NativeLyricResult | null> {
  const headers = {
    Referer: 'https://app.c.nf.migu.cn/',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 5.1.1; Nexus 6 Build/LYZ28E) AppleWebKit/537.36 Chrome/59.0.3071.115 Mobile Safari/537.36',
    channel: '0146921',
  }

  // 逐字优先：mrcUrl 是咪咕按这首歌确址给的资源（实测搜歌接口本就返回它），
  // 不存在按名搜索那条错配面；解不出来或过不了闸门就回落下面的整行路径。
  if (musicInfo.mrcUrl) {
    const mrcResponse = await fetchWithTimeout(musicInfo.mrcUrl, { headers })
    const parsed = mrcResponse ? parseMrc(decryptMiguMrc(await mrcResponse.text())) : null
    const verdict = parsed ? screenWordLyric(parsed, { durationSeconds: parseIntervalSeconds(musicInfo.interval) }) : null
    if (parsed && verdict?.ok) {
      logger.info('[lyrics] 咪咕逐字命中', { songId: musicInfo.songmid, lineCount: verdict.lineCount })
      return { lyric: toPlainLrc(parsed), tlyric: await fetchMiguTranslation(musicInfo, headers), wordLyric: toEnhancedLrc(parsed) }
    }
    if (verdict && !verdict.ok) logger.info('[lyrics] 咪咕逐字被闸门拒绝，回落整行', { songId: musicInfo.songmid, reason: verdict.reason })
  }

  const lrcResponse = musicInfo.lrcUrl ? await fetchWithTimeout(musicInfo.lrcUrl, { headers }) : null
  const mrcResponse = !lrcResponse && musicInfo.mrcUrl ? await fetchWithTimeout(musicInfo.mrcUrl, { headers }) : null
  const rawLyric = lrcResponse ? await lrcResponse.text() : mrcResponse ? decryptMiguMrc(await mrcResponse.text()) : ''
  const lyric = lrcResponse ? rawLyric.trim() : parseMiguMrc(rawLyric)
  if (!lyric) return null

  return { lyric, tlyric: await fetchMiguTranslation(musicInfo, headers) }
}

/** 按 hash 确址找到酷狗歌词候选，返回"按格式下载"的闭包；找不到候选返回 null */
async function openKugouLyric(musicInfo: MusicInfo): Promise<((fmt: 'krc' | 'lrc') => Promise<unknown>) | null> {
  if (!musicInfo.hash || !musicInfo.name) return null
  const params = new URLSearchParams({
    ver: '1', man: 'yes', client: 'pc', keyword: musicInfo.name, hash: musicInfo.hash,
    timelength: String(parseIntervalSeconds(musicInfo.interval)), lrctxt: '1',
  })
  const headers = {
    'KG-RC': '1',
    'KG-THash': 'expand_search_manager.cpp:852736169:451',
    'User-Agent': 'KuGou2012-9020-ExpandSearchManager',
  }
  const searchResponse = await fetchWithTimeout(`https://lyrics.kugou.com/search?${params}`, { headers })
  if (!searchResponse) return null
  const searchPayload = await searchResponse.json() as { candidates?: unknown }
  const list = Array.isArray(searchPayload.candidates) ? searchPayload.candidates : []
  const candidate = list.find((item): item is KugouLyricCandidate => Boolean(item) && typeof item === 'object' && titleMatches(String((item as KugouLyricCandidate).song || ''), musicInfo.name) && artistMatches(String((item as KugouLyricCandidate).singer || ''), musicInfo.singer))
  if (!candidate?.id || !candidate.accesskey) {
    // 没有这行就分不清"同名闸门拦住了"和"上游根本没给候选"（实测连打同一首第二遍会被限速）
    logger.info('[lyrics] 酷狗无可信候选', { songId: musicInfo.songmid, 候选数: list.length, 首条: String((list[0] as KugouLyricCandidate)?.song ?? '') })
    return null
  }

  return async (fmt: 'krc' | 'lrc') => {
    const downloadParams = new URLSearchParams({ ver: '1', client: 'pc', id: String(candidate.id), accesskey: String(candidate.accesskey), fmt, charset: 'utf8' })
    const response = await fetchWithTimeout(`https://lyrics.kugou.com/download?${downloadParams}`, { headers })
    if (!response) return null
    const payload = await response.json() as { fmt?: unknown; content?: unknown }
    return payload.fmt === fmt ? payload.content ?? null : null
  }
}

async function fetchKugouParsedLyricFrom(
  download: (fmt: 'krc' | 'lrc') => Promise<unknown>,
  musicInfo: MusicInfo,
): Promise<WordLyric | null> {
  const krcContent = await download('krc')
  const krcText = typeof krcContent === 'string' ? decodeKrcPayload(krcContent) : null
  const parsed = krcText ? parseKrc(krcText) : null
  if (!parsed) return null
  const verdict = screenWordLyric(parsed, {
    durationSeconds: parseIntervalSeconds(musicInfo.interval),
    expectedFileHash: musicInfo.hash,
  })
  if (verdict.ok) {
    logger.info('[lyrics] 酷狗逐字命中', { songId: musicInfo.songmid, lineCount: verdict.lineCount })
    return parsed
  }
  logger.info('[lyrics] 酷狗逐字被闸门拒绝，回落整行', { songId: musicInfo.songmid, reason: verdict.reason })
  return null
}

async function fetchKugouLyric(musicInfo: MusicInfo): Promise<NativeLyricResult | null> {
  const download = await openKugouLyric(musicInfo)
  if (!download) return null

  // 先试逐字：命中就一次解析同时给出行级与字级；不过闸门才回落到原来的 fmt=lrc，行为不变。
  const parsed = await fetchKugouParsedLyricFrom(download, musicInfo)
  if (parsed) return { lyric: toPlainLrc(parsed), tlyric: null, wordLyric: toEnhancedLrc(parsed) }

  const lrcContent = await download('lrc')
  const lyric = typeof lrcContent === 'string' ? decodeBase64(lrcContent) : ''
  return lyric ? { lyric, tlyric: null } : null
}

/**
 * 按歌曲自己的 FileHash 确址取酷狗逐字并过结构闸门；取不到返回 null。
 * 给"跨源借逐字"复用：播的是 A 源，但库里同一首歌有酷狗副本时，用那行的 hash 拿字时间。
 */
export async function fetchKugouWordLyric(musicInfo: MusicInfo): Promise<WordLyric | null> {
  const download = await openKugouLyric(musicInfo)
  return download ? fetchKugouParsedLyricFrom(download, musicInfo) : null
}

/**
 * 从歌曲所属平台精确取词。实现参考同级 lxserver：先走音源 ID / hash / 歌词 URL，
 * 不可用时才由调用方回退到自定义音源或第三方标题搜索。
 */
export async function fetchNativeLyric(musicInfo: MusicInfo): Promise<NativeLyricResult | null> {
  try {
    let result: NativeLyricResult | null = null
    switch (musicInfo.source) {
      case 'kw':
        if (/^\d+$/.test(String(musicInfo.songmid))) result = await fetchKuwoLyric(String(musicInfo.songmid))
        break
      case 'tx':
        // 先试逐字：命中就一次解析同时给行级与字级；没有数字 songID、过不了闸门
        // 或上游没给载荷，都回落到原来的整行通道，行为与改动前一致。
        result = await fetchQQQrcLyric(musicInfo) ?? await fetchQQMusicLyric(String(musicInfo.songmid))
        break
      case 'wy':
        if (/^\d+$/.test(String(musicInfo.songmid))) result = await fetchNeteaseLyric(String(musicInfo.songmid))
        break
      case 'mg':
        result = await fetchMiguLyric(musicInfo)
        break
      case 'kg':
        result = await fetchKugouLyric(musicInfo)
        break
    }
    if (result) logger.info('[lyrics] fetched precise source lyric', { source: musicInfo.source, songId: musicInfo.songmid, lineCount: result.lyric.split('\n').length })
    return result
  } catch (error) {
    logger.debug('[lyrics] native lyric request failed', { source: musicInfo.source, songId: musicInfo.songmid, error })
    return null
  }
}

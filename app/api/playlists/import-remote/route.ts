/**
 * 平台歌单导入 API
 * POST /api/playlists/import-remote   { url?: string, source?: string, id?: string, name?: string, cookie?: string }
 *
 * 支持直接导入五大平台（kw 酷我 / wy 网易 / tx QQ / kg 酷狗 / mg 咪咕）的歌单：
 * 传入歌单链接（自动识别平台与歌单 ID），或直接传 source + id。
 * 拉取歌单详情 → 复用发现页入库链路（MusicInfo upsert + uid）→ 建歌单 → 批量加入。
 *
 * 私有歌单：可选传 cookie（平台网页登录 Cookie），
 * 目前 wy 网易云（MUSIC_U）与 tx QQ 音乐有效；带 cookie 时不读不写公共缓存。
 *
 * 注意：
 * - 不带 cookie 时仅支持公开歌单
 * - kw/kg/mg 平台接口单页上限约 100 首，超大歌单仅导入前 100 首
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { createPlaylist, addSongsToPlaylist } from '@/lib/services/playlist-service'
import { getRecommendedPlaylistDetail, isDiscoverySource, type DiscoverySource } from '@/lib/services/discovery-service'
import { logger } from '@/lib/logger'

// 各平台歌单链接 → (source, id)
// 注意：取 id 参数时必须用「参数边界 + 非贪婪」写法（[?&]id= / (?:[^\s#]*&)?id=），
// 避免贪婪回退误匹配 creatorId / userid 等含 "id" 的后续参数。
const URL_PATTERNS: Array<{ source: DiscoverySource; re: RegExp }> = [
  // 网易云：music.163.com/playlist?id=123 / #/playlist?id=&creatorId=... / m/playlist?...&id= / playlist/123
  { source: 'wy', re: /music\.163\.com(?:\/#)?(?:\/m)?\/playlist(?:\/(\d+)|\?(?:[^\s#]*&)?id=(\d+))/i },
  // QQ 音乐：y.qq.com/n/ryqq/playlist/ABC123，或分享短链落地的移动端详情页
  { source: 'tx', re: /y\.qq\.com\/n\/ryqq\/playlist\/([A-Za-z0-9]+)|[?&]disstid=([A-Za-z0-9]+)|qq\.com\/[^\s]*?playlist\.html\?[^\s]*?[&?]id=([A-Za-z0-9]+)/i },
  // 酷我：kuwo.cn/playlist_detail/123 或任意 kuwo 链接带 pid=123
  { source: 'kw', re: /kuwo\.cn\/playlist_detail\/(\d+)|[?&]pid=(\d+)/i },
  // 酷狗：kugou.com/yy/special/single/xxx.html 或 specialid=xxx
  { source: 'kg', re: /kugou\.com\/yy\/special\/single\/(\w+)|[?&]specialid=(\w+)/i },
  // 咪咕：music.migu.cn/v3/music/playlist/xxx，或 App 分享页 h5.nf.migu.cn/...?id=xxx
  { source: 'mg', re: /migu(?:video)?\.cn\/v3\/music\/playlist\/([A-Za-z0-9]+)|h5\.nf\.migu\.cn[^\s]*?playlist[^\s]*?[?&]id=([A-Za-z0-9]+)/i },
]

function parsePlaylistUrl(url: string): { source: DiscoverySource; id: string } | null {
  for (const { source, re } of URL_PATTERNS) {
    const m = url.match(re)
    if (m) {
      // 兼容含多个捕获组的模式（交替分支），取第一个非 undefined 的组
      const id = m.slice(1).find(g => g !== undefined)
      if (id) return { source, id }
    }
  }
  return null
}

/**
 * 短链解析：App 分享出来的往往是短链（如 163cn.tv/xxx、t1.kugou.com/xxx），
 * 服务端 GET 跟随跳转，用最终落地地址重新识别歌单。
 * 自部署单管理实例场景；不做内网地址过滤（与洛雪音源脚本的既有权限面一致）。
 */
async function resolveShareUrl(url: string): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const resp = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) Mobile' },
      })
      return resp.url || null
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request)
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '请求体必须是 JSON 对象', 400)
    }
    const raw = body as Record<string, unknown>

    // 解析 (source, id)：优先 URL 自动识别，其次显式 source + id
    let source: string | null = null
    let id: string | null = null
    const url = typeof raw.url === 'string' ? raw.url.trim() : ''

    if (url) {
      let parsed = parsePlaylistUrl(url)
      if (!parsed) {
        // 短链（App 分享）：跟随跳转后用落地地址重新识别
        const resolved = await resolveShareUrl(url)
        if (resolved) parsed = parsePlaylistUrl(resolved)
      }
      if (!parsed) {
        return createErrorResponse(
          ErrorCodes.INVALID_PARAMS,
          '无法识别歌单链接，支持：网易云 / QQ音乐 / 酷我 / 酷狗 / 咪咕 的歌单链接或 App 分享短链',
          400,
        )
      }
      source = parsed.source
      id = parsed.id
    } else {
      source = typeof raw.source === 'string' ? raw.source : null
      id = typeof raw.id === 'string' ? raw.id.trim() : null
    }

    if (!isDiscoverySource(source) || !id) {
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, '请提供歌单链接，或 source + id', 400)
    }

    const cookie = typeof raw.cookie === 'string' ? raw.cookie.trim() : ''
    const detail = await getRecommendedPlaylistDetail(source, id, cookie || undefined)
    if (!detail || detail.tracks.length === 0) {
      return createErrorResponse(
        'NOT_FOUND',
        '歌单不存在、为空或不是公开歌单',
        404,
      )
    }

    const name =
      (typeof raw.name === 'string' && raw.name.trim()) ||
      detail.name ||
      `${source} 歌单 ${id}`

    const playlist = await createPlaylist(user.username, name.trim())
    await addSongsToPlaylist(playlist.id, user.username, detail.tracks.map(t => t.uid))

    logger.info(
      '[api/playlists/import-remote] 用户 %s 从 %s 导入歌单「%s」(%s)：%d 首',
      user.username, source, name, id, detail.tracks.length,
    )
    return createSuccessResponse(
      {
        playlistId: playlist.id,
        name: playlist.name,
        source,
        sourcePlaylistId: id,
        author: detail.author,
        imported: detail.tracks.length,
      },
      201,
    )
  } catch (err) {
    if (err instanceof AuthError) return createErrorResponse('UNAUTHORIZED', err.message, 401)
    logger.error('[api/playlists/import-remote POST] error:', err)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '导入平台歌单失败', 500)
  }
}

/**
 * 链专辑封面统一 API（服务端中转 + 跨源降级，kw/mg 通用）
 * GET /api/album/cover?source=kw|mg&albumid=<该源专辑id>&name=<专辑名>&singer=<歌手名> → 图片字节
 *
 * 解析链（单一实现，source 只决定第一跳）：
 * 1. 本源直查：kw=r.s 专辑/搜索 pic；mg=专辑详情 imgItems（老 id/column id 均可）
 * 2. kw 按名（专辑搜索卡片 pic）
 * 3. mg 按名（专辑搜索卡片 pic）
 * 4. Apple 按名搜索（首张歌手匹配专辑 600x600）
 * 5. 404（前端占位兜底）
 * Apple 卡片仍走既有 /api/album/apple/cover?collectionId=（id 直查更快）。
 * 前端 kw/mg 封面两级加载：卡片直链 img 失败/无图才请求本端点。需登录；字节缓存 24h。
 */
import { NextRequest } from 'next/server'
import { logger } from '@/lib/logger'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getMgAlbumDetail, searchMgAlbums } from '@/lib/services/mg-chain-service'
import { txPhotoUrl } from '@/lib/services/tx-chain-service'
import { resolveKwAlbumCoverUrl } from '@/lib/services/kw-chain-service'
import { searchItunesAlbums, appleT2S } from '@/lib/services/itunes-service'
import { fetchCoverImageBytes } from '@/lib/services/album-service'

/** 归一化比对键：简体+小写+去非字母数字 */
function normKey(value: string | null | undefined): string {
  return appleT2S(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** mg 按名搜专辑取封面（跨源链第三跳） */
async function mgCoverByName(name: string, singer: string): Promise<string | null> {
  const keyword = singer.trim() ? `${name.trim()} ${singer.trim()}` : name.trim()
  const cards = await searchMgAlbums(keyword, 5).catch(() => [])
  const n = normKey(name)
  const hit = cards.find(c => {
    const t = normKey(c.name)
    return !!t && (t === n || t.includes(n) || n.includes(t))
  })
  return hit?.img ?? null
}

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const source = request.nextUrl.searchParams.get('source') || ''
    const albumId = request.nextUrl.searchParams.get('albumid') || ''
    const name = request.nextUrl.searchParams.get('name') || ''
    const singer = request.nextUrl.searchParams.get('singer') || ''
    if (!name.trim() && !albumId) {
      return new Response('name 或 albumid 至少提供其一', { status: 400 })
    }

    // 1. 本源直查
    let url: string | null = null
    if (source === 'tx' && albumId) {
      // tx=T002 公式直出（500px，无需上游查询）
      url = txPhotoUrl('T002', albumId)
    } else if (albumId && /^\d+$/.test(albumId)) {
      if (source === 'mg') {
        const detail = await getMgAlbumDetail(albumId).catch(() => null)
        if (detail?.album.pic) url = detail.album.pic
      } else {
        // source=kw 或缺省：kw 解析（内部含 r.s 专辑 pic → kw 搜索 pic）
        url = await resolveKwAlbumCoverUrl(albumId, name, singer)
      }
    }

    // 2. kw 按名
    if (!url && name.trim()) {
      url = await resolveKwAlbumCoverUrl(null, name, singer)
    }
    // 3. mg 按名
    if (!url && name.trim()) {
      url = await mgCoverByName(name, singer)
    }
    // 4. Apple 按名
    if (!url && name.trim()) {
      const keyword = singer.trim() ? `${name.trim()} ${singer.trim()}` : name.trim()
      const appleAlbums = await searchItunesAlbums(keyword, 10).catch(() => [])
      const singerNorm = singer.trim().toLowerCase()
      const hit = appleAlbums.find(a => !singerNorm
        || a.artist.toLowerCase().includes(singerNorm)
        || singerNorm.includes(a.artist.toLowerCase()))
      if (hit?.img) url = hit.img
    }

    if (!url) return new Response('no cover', { status: 404 })
    const image = await fetchCoverImageBytes(url)
    if (!image) return new Response('cover fetch failed', { status: 404 })
    return new Response(image.bytes, {
      status: 200,
      headers: {
        'Content-Type': image.contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    if (error instanceof AuthError) {
      logger.warn('[api/album/cover] 未授权访问')
      return new Response('unauthorized', { status: 401 })
    }
    logger.error('[api/album/cover] error:', error)
    return new Response('internal error', { status: 500 })
  }
}

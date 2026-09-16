import { NextRequest } from 'next/server'
import { respond, subsonicError } from './subsonic'
import favorites, { FavoriteItem } from './favorites'
import { type AuthResult } from './auth'
import * as dbAPI from './db'

function parseListParam(raw: string | null): string[] {
  if (!raw) return []
  return raw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
}

/**
 * 从 `source-songmid` 复合 id 解析出 source。
 * song id 统一为该格式（见 subsonic-search / subsonic-getstarred），source 为第一个 '-' 之前的部分。
 */
function parseSourceFromId(id: string): string | null {
  if (!id.includes('-')) return null
  const src = id.substring(0, id.indexOf('-'))
  return src || null
}

/**
 * 专辑星标的展示快照。
 * 本服务的专辑 id 就是「代表曲的存储键」（source-{songmid}，见 subsonic-system 的 albumList2），
 * 所以能借它取回专辑名/歌手/封面；取不到就只存 id（读取侧用 id 兜底显示）。
 */
async function albumSnapshot(id: string): Promise<{ name?: string; singer?: string; img?: string }> {
  try {
    const musicInfo = await dbAPI.resolveMusicInfoById(id)
    if (!musicInfo) return {}
    return {
      name: musicInfo.albumName || undefined,
      singer: musicInfo.singer || undefined,
      img: musicInfo.img || undefined,
    }
  } catch {
    // 快照只是锦上添花，取不到不影响收藏本身
    return {}
  }
}

export async function handleStar(request: NextRequest, authRes: AuthResult): Promise<Response> {
  try {
    const url = new URL(request.url)
    const params = url.searchParams
    // Subsonic 的 star 三组参数都可用（至少传一个）：id=歌曲、albumId=专辑、artistId=艺术家
    const songIds = parseListParam(params.get('id'))
    const albumIds = parseListParam(params.get('albumId'))
    const artistIds = parseListParam(params.get('artistId'))

    if (songIds.length === 0 && albumIds.length === 0 && artistIds.length === 0) {
      return subsonicError(request, 50, 'Required parameter missing: id')
    }

    const userId = authRes.user!.id

    // song id 统一为 `source-songmid` 复合格式，直接从 id 解析出 source
    const items: FavoriteItem[] = songIds.map(id => ({
      itemType: 'song' as const,
      itemId: id,
      source: parseSourceFromId(id),
    }))
    for (const id of albumIds) {
      items.push({
        itemType: 'album' as const,
        itemId: id,
        source: parseSourceFromId(id),
        ...(await albumSnapshot(id)),
      })
    }
    for (const id of artistIds) {
      items.push({ itemType: 'artist' as const, itemId: id, source: null })
    }

    const { created } = await favorites.starItems(userId, items)
    console.debug('[star] created:', created)

    return respond(request, null)
  } catch (err) {
    console.error('[star] Error:', err)
    return subsonicError(request, 0, 'Internal error')
  }
}

export async function handleUnstar(request: NextRequest, authRes: AuthResult): Promise<Response> {
  try {
    const url = new URL(request.url)
    const params = url.searchParams
    const songIds = parseListParam(params.get('id'))
    const albumIds = parseListParam(params.get('albumId'))
    const artistIds = parseListParam(params.get('artistId'))

    if (songIds.length === 0 && albumIds.length === 0 && artistIds.length === 0) {
      return subsonicError(request, 10, 'Required parameter missing: id')
    }

    const userId = authRes.user!.id

    // 不传 source：按 id 删除该类型下的记录（服务端不校验客户端传的 source 是否与实际一致）
    const items: FavoriteItem[] = [
      ...songIds.map(id => ({ itemType: 'song' as const, itemId: id, source: null })),
      ...albumIds.map(id => ({ itemType: 'album' as const, itemId: id, source: null })),
      ...artistIds.map(id => ({ itemType: 'artist' as const, itemId: id, source: null })),
    ]

    const { deleted } = await favorites.unstarItems(userId, items)
    console.debug('[unstar] deleted:', deleted)

    return respond(request, null)
  } catch (err) {
    console.error('[unstar] Error:', err)
    return subsonicError(request, 0, 'Internal error')
  }
}

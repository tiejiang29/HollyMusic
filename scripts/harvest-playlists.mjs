/**
 * 歌单批量自采脚本：从各平台歌单广场遍历类目 → 拉歌单详情 → 曲目自动入库。
 *
 * 为什么走 HTTP 而不是直接调 lib：
 * discovery-service 的各源 detail 解析最终都汇到 enrichMusicInfos()
 * （discovery-service.ts:186），它内部就会 upsertMusicInfosInTransaction 入库。
 * 所以脚本只要把详情接口调一遍，曲目就已经带着可播放的 songmid 落库了，
 * 不需要自己碰 Prisma，也不用重复一份解析逻辑。
 *
 * 另一个好处是共享服务端的 searchCache（CACHE_TTL=10min）：重复跑不会反复打上游。
 *
 * 采到的条目自带 songmid（kg 为 FileHash，见 db.ts:65），可直接播放，
 * 不需要像外部数据集那样再过一遍 musicSearch.search 解析。
 *
 * 用法：
 *   node scripts/harvest-playlists.mjs                      # 默认全平台全类目
 *   node scripts/harvest-playlists.mjs --dry                # 只列计划，不发请求
 *   node scripts/harvest-playlists.mjs --sources=tx,wy      # 指定平台
 *   node scripts/harvest-playlists.mjs --tags=流行,摇滚      # 指定类目（不传则用平台完整类目树）
 *   node scripts/harvest-playlists.mjs --per-tag=20         # 每类目取多少歌单
 *   node scripts/harvest-playlists.mjs --pages=1            # 每类目翻几页
 *   node scripts/harvest-playlists.mjs --sort=hot           # recommend|hot|new|collect|soar
 *   node scripts/harvest-playlists.mjs --concurrency=3      # 详情请求并发
 *   node scripts/harvest-playlists.mjs --recommend          # 采完把曲目写入 isRecommended 白名单
 *   node scripts/harvest-playlists.mjs --hot-tags-only      # 只用 hotTag，不展开完整类目树
 *   node scripts/harvest-playlists.mjs --resume             # 跳过 state 文件里已采过的歌单
 *   node scripts/harvest-playlists.mjs --out=file.json      # 采到的曲目不写推荐，导出为 JSON
 *                                                           # （供 push-music-info.mjs 推送到目标服务器）
 *
 * 环境变量：
 *   HOLLY_BASE_URL   默认 http://127.0.0.1:3000
 *   HOLLY_USERNAME   默认 admin
 *   HOLLY_PASSWORD   必填（discover 接口全部 requireUser）
 *
 * 注意：所有 discover 接口都要求登录，--recommend 还要求 admin。
 *
 * 本机采集 → 服务器入库两段式：
 *   1) 本机跑本脚本 --out=data/harvest.json 采出 JSON（曲目已在过程中写入本机库，
 *      这是详情接口内置入库的副作用，无法绕过——但服务器库不受影响）
 *   2) node scripts/push-music-info.mjs --file=data/harvest.json 推到目标服务器
 */
import fs from 'fs'
import path from 'path'

// ============ 参数 ============
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const val = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const num = (name, dflt) => {
  const n = Number(val(name, dflt))
  return Number.isFinite(n) && n > 0 ? n : dflt
}

const DRY = has('--dry')
const RESUME = has('--resume')
const WRITE_RECOMMEND = has('--recommend')
const HOT_TAGS_ONLY = has('--hot-tags-only')
const OUT_FILE = val('out', '')

// --out 模式只采集不写推荐（写推荐是目标服务器上的决定，推过去时用 --recommend）
if (OUT_FILE && WRITE_RECOMMEND) {
  console.error('--out 与 --recommend 互斥：导出模式只采集，写推荐在推送脚本上做')
  process.exit(1)
}

const BASE_URL = (process.env.HOLLY_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '')
const USERNAME = process.env.HOLLY_USERNAME || 'admin'
const PASSWORD = process.env.HOLLY_PASSWORD || ''

const ALL_SOURCES = ['tx', 'wy', 'kw', 'kg', 'mg']
const SOURCES = val('sources', '')
  ? val('sources', '').split(',').map((s) => s.trim()).filter(Boolean)
  : ALL_SOURCES
const EXPLICIT_TAGS = val('tags', '') ? val('tags', '').split(',').map((s) => s.trim()).filter(Boolean) : null
const PER_TAG = Math.min(num('per-tag', 20), 100)
const PAGES = Math.min(num('pages', 1), 20)
const SORT = ['recommend', 'hot', 'new', 'collect', 'soar'].includes(val('sort', 'recommend'))
  ? val('sort', 'recommend')
  : 'recommend'
const CONCURRENCY = Math.min(num('concurrency', 3), 8)
// 详情请求之间的基础间隔，避免把上游打到限流（上游限流会返回空列表，
// 而 discovery-service 对空结果不缓存，于是下次又打——反而更糟）
const DELAY_MS = num('delay', 400)
const MAX_RETRY = 2

const STATE_FILE = path.join(process.cwd(), 'data', 'harvest-state.json')

const bad = SOURCES.filter((s) => !ALL_SOURCES.includes(s))
if (bad.length) {
  console.error(`不支持的音源: ${bad.join(', ')}（可选：${ALL_SOURCES.join('/')}）`)
  process.exit(1)
}

// ============ 工具 ============
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 简易并发池：保持最多 n 个任务在飞 */
async function pool(items, n, worker) {
  const results = []
  let cursor = 0
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return results
}

let COOKIE = ''

/** 带 cookie + 重试的 fetch，解包 { success, data } 信封 */
async function api(pathname, init = {}, retry = MAX_RETRY) {
  const url = `${BASE_URL}${pathname}`
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(COOKIE ? { Cookie: COOKIE } : {}),
        ...(init.headers || {}),
      },
    })
    // 401/403 是配置问题（密码错/非管理员），重试无意义，直接抛
    if (res.status === 401 || res.status === 403) {
      throw new Error(`HTTP ${res.status}（登录态或权限不足）`)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    if (!json?.success) throw new Error(json?.error?.message || '接口返回 success=false')
    return json.data
  } catch (e) {
    if (retry > 0 && !/HTTP 40[13]/.test(e.message)) {
      // 退避后重试：上游瞬时限流常见，退避比立即重试有效
      await sleep(DELAY_MS * (MAX_RETRY - retry + 2))
      return api(pathname, init, retry - 1)
    }
    throw e
  }
}

async function login() {
  if (!PASSWORD) {
    console.error('缺少 HOLLY_PASSWORD 环境变量（discover 接口需要登录态）')
    process.exit(1)
  }
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json?.success) {
    console.error(`登录失败: ${json?.error?.message || `HTTP ${res.status}`}`)
    process.exit(1)
  }
  // 收集 set-cookie（holly_user / holly_sv / holly_sig）
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean)
  COOKIE = raw.map((c) => c.split(';')[0]).join('; ')
  if (!COOKIE) {
    console.error('登录成功但未取到 cookie，无法继续')
    process.exit(1)
  }
  console.log(`✓ 已登录 ${USERNAME}@${BASE_URL}`)
}

/** 取平台类目：优先完整类目树，--hot-tags-only 时只用 hotTag */
async function resolveTags(source) {
  let hot = []
  let flat = []
  try {
    const data = await api(`/api/discover/playlists/tags?source=${source}`)
    hot = Array.isArray(data?.hotTag) ? data.hotTag : []
    for (const g of Array.isArray(data?.tags) ? data.tags : []) {
      for (const t of Array.isArray(g?.list) ? g.list : []) flat.push(t)
    }
  } catch (e) {
    console.warn(`  ! ${source} 取类目失败（${e.message}）`)
  }

  // hotTag 与 tags 常有重叠，按 name 去重
  const seen = new Set()
  const all = [...hot, ...flat].filter((t) => {
    const k = t?.name || ''
    if (!k || seen.has(k)) return false
    seen.add(k)
    return true
  })

  // 显式 --tags：必须从类目树反查出 id。
  // tx/kw/kg/mg 的 tag 参数是平台内部 id（tx 传中文名上游直接返回空列表），
  // 只有 wy 的 tag 参数本身就是类目名，故 wy 反查失败可安全回退用名字。
  if (EXPLICIT_TAGS) {
    const byName = new Map(all.map((t) => [t.name, t]))
    const resolved = []
    for (const name of EXPLICIT_TAGS) {
      const hit = byName.get(name)
      if (hit) { resolved.push(hit); continue }
      if (source === 'wy') { resolved.push({ id: name, name }); continue }
      console.warn(`  ! ${source} 无类目「${name}」，已跳过（可用：${all.slice(0, 8).map((t) => t.name).join('/')}…）`)
    }
    return resolved
  }

  if (HOT_TAGS_ONLY) return hot
  if (all.length === 0) {
    console.warn(`  ! ${source} 类目树为空，回退默认类目`)
    return ['流行', '经典', '儿歌', '摇滚', '民谣', '电子', '国风', 'ACG'].map((name) => ({ id: name, name }))
  }
  return all
}

function loadState() {
  if (!RESUME) return new Set()
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return new Set(Array.isArray(raw?.done) ? raw.done : [])
  } catch {
    return new Set()
  }
}

function saveState(done) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({ done: [...done], savedAt: new Date().toISOString() }, null, 2))
  } catch (e) {
    console.warn(`  ! 状态写入失败: ${e.message}`)
  }
}

// ============ 主流程 ============
async function main() {
  console.log('========== 歌单自采 ==========')
  console.log(`平台: ${SOURCES.join(', ')}`)
  console.log(`类目: ${EXPLICIT_TAGS ? EXPLICIT_TAGS.join(', ') : HOT_TAGS_ONLY ? '各平台 hotTag' : '各平台完整类目树'}`)
  console.log(`每类目 ${PER_TAG} 个歌单 × ${PAGES} 页 | sort=${SORT} | 并发 ${CONCURRENCY} | 间隔 ${DELAY_MS}ms`)
  if (WRITE_RECOMMEND) console.log('采完写入 isRecommended 白名单（需 admin）')
  if (OUT_FILE) console.log(`导出模式：曲目写入 ${OUT_FILE}（不写推荐，本机库仍会被详情接口顺带入库）`)
  if (DRY) console.log('** DRY RUN：只列计划，不发请求 **')
  console.log('')

  // dry 也要登录并取类目树：tag id 反查必须联网，否则列出的计划 URL 是错的
  await login()

  const done = loadState()
  if (RESUME) console.log(`✓ resume：已跳过 ${done.size} 个采过的歌单\n`)

  const stats = { playlists: 0, ok: 0, failed: 0, skipped: 0, tracks: 0 }
  const allUids = new Set()
  // 导出模式：uid → 裸 MusicInfo（去掉 uid/local 派生字段），uid 与 DB 存储键一致
  const itemsById = OUT_FILE ? new Map() : null

  for (const source of SOURCES) {
    const tags = await resolveTags(source)
    console.log(`\n【${source}】${tags.length} 个类目`)

    for (const tag of tags) {
      // 1. 列歌单
      const listed = []
      for (let page = 1; page <= PAGES; page++) {
        if (DRY) {
          console.log(`  [dry] GET /api/discover/playlists?source=${source}&tag=${tag.id || tag.name}&sort=${SORT}&limit=${PER_TAG}&page=${page}`)
          continue
        }
        try {
          const qs = new URLSearchParams({
            source,
            limit: String(PER_TAG),
            page: String(page),
            sort: SORT,
            // resolveTags 已保证 id 有值：tx/kw/kg/mg 为平台内部 id，wy 的 id 即类目名
            tag: tag.id || tag.name,
          })
          const list = await api(`/api/discover/playlists?${qs}`)
          if (!Array.isArray(list) || list.length === 0) break // 没有更多页
          listed.push(...list)
          await sleep(DELAY_MS)
        } catch (e) {
          console.warn(`  ! ${tag.name} p${page} 列表失败: ${e.message}`)
          break
        }
      }
      if (DRY) continue
      if (listed.length === 0) {
        console.log(`  - ${tag.name}: 无歌单`)
        continue
      }

      // 2. 拉详情（详情接口内部即完成入库）
      const targets = listed.filter((p) => {
        if (!p?.id) return false
        const key = `${source}:${p.id}`
        if (done.has(key)) { stats.skipped++; return false }
        return true
      })
      stats.playlists += targets.length

      let tagTracks = 0
      await pool(targets, CONCURRENCY, async (p) => {
        try {
          const detail = await api(`/api/discover/playlists/${encodeURIComponent(p.id)}?source=${source}`)
          const tracks = Array.isArray(detail?.tracks) ? detail.tracks : []
          for (const t of tracks) {
            if (!t?.uid) continue
            allUids.add(t.uid)
            // uid = `${source}-${存储songmid}`（kg 为 FileHash），与 DB 唯一键一致，
            // 直接作为导出去重键；剥掉 uid/local 派生字段保持 data 干净
            if (itemsById && !itemsById.has(t.uid)) {
              const { uid, local, ...mi } = t
              itemsById.set(uid, mi)
            }
          }
          tagTracks += tracks.length
          stats.tracks += tracks.length
          stats.ok++
          done.add(`${source}:${p.id}`)
        } catch (e) {
          stats.failed++
          console.warn(`  ! ${source}/${p.id} 详情失败: ${e.message}`)
        }
        await sleep(DELAY_MS)
      })

      console.log(`  ✓ ${tag.name}: ${targets.length} 歌单 / ${tagTracks} 首（累计去重 ${allUids.size}）`)
      saveState(done)
    }
  }

  console.log('\n========== 采集完成 ==========')
  console.log(`歌单: ${stats.ok} 成功 / ${stats.failed} 失败 / ${stats.skipped} 跳过`)
  console.log(`曲目: ${stats.tracks} 条（去重后 ${OUT_FILE ? itemsById.size : allUids.size} 首${OUT_FILE ? '待导出' : '已入库'}）`)

  // 3. 导出模式：写 JSON 供 push-music-info.mjs 推送到目标服务器
  if (OUT_FILE && !DRY) {
    const payload = {
      version: 1,
      harvestedAt: new Date().toISOString(),
      stats: { playlists: stats.ok, tracks: stats.tracks, deduped: itemsById.size },
      items: [...itemsById.values()],
    }
    try {
      fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
      fs.writeFileSync(OUT_FILE, JSON.stringify(payload))
      console.log(`✓ 已导出 ${itemsById.size} 首 → ${OUT_FILE}`)
    } catch (e) {
      console.error(`导出失败: ${e.message}`)
      process.exit(1)
    }
  }

  // 4. 可选：写入推荐白名单
  if (WRITE_RECOMMEND && allUids.size > 0 && !DRY) {
    console.log(`\n写入 isRecommended 白名单（${allUids.size} 首）...`)
    const uids = [...allUids]
    const BATCH = 500
    let written = 0
    for (let i = 0; i < uids.length; i += BATCH) {
      const chunk = uids.slice(i, i + BATCH)
      try {
        const r = await api('/api/admin/recommend', {
          method: 'POST',
          body: JSON.stringify({ uids: chunk }),
        })
        written += r?.count ?? chunk.length
        console.log(`  ✓ ${Math.min(i + BATCH, uids.length)}/${uids.length}`)
      } catch (e) {
        console.warn(`  ! 批次 ${i} 写入失败: ${e.message}`)
      }
    }
    console.log(`✓ 白名单写入 ${written} 首`)
  }

  if (RESUME || stats.ok > 0) console.log(`\n状态文件: ${STATE_FILE}（--resume 可续采）`)
}

main()
  .catch((e) => {
    console.error('脚本异常:', e)
    process.exit(1)
  })

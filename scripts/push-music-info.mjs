/**
 * 采集数据推送脚本：把 harvest-playlists.mjs --out 导出的 JSON 推送到目标服务器的
 * /api/admin/music-info/import，分批入库。
 *
 * 与采集脚本分离的原因：采集打上游平台，用本机（家用 IP）跑更稳；
 * 入库打自己的服务器，两者网络路径不同，分开跑互不拖累。
 *
 * 用法：
 *   node scripts/push-music-info.mjs --file=data/harvest.json
 *   node scripts/push-music-info.mjs --file=data/harvest.json --dry   # 只校验文件不发请求
 *   node scripts/push-music-info.mjs --file=data/harvest.json --target=https://srv.example.com
 *   node scripts/push-music-info.mjs --file=data/harvest.json --recommend  # 入库后写入推荐白名单
 *   node scripts/push-music-info.mjs --file=data/harvest.json --batch=300
 *
 * 环境变量：
 *   HOLLY_TARGET     目标服务器，默认 http://127.0.0.1:3000
 *   HOLLY_USERNAME   默认 admin
 *   HOLLY_PASSWORD   必填（导入接口 requireAdmin）
 *
 * 注意 --recommend：白名单一旦非空，/api/random 抽歌就完全锁进白名单
 * （lib/db.ts 两级查询是全有或全无回退），会改变全站发现页曲池，慎用。
 */
import fs from 'fs'

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
const RECOMMEND = has('--recommend')
const FILE = val('file', '')
const TARGET = (process.env.HOLLY_TARGET || val('target', '') || 'http://127.0.0.1:3000').replace(/\/+$/, '')
const USERNAME = process.env.HOLLY_USERNAME || 'admin'
const PASSWORD = process.env.HOLLY_PASSWORD || ''
const BATCH = Math.min(num('batch', 500), 500) // 服务端单请求上限 500
const MAX_RETRY = 3

if (!FILE) {
  console.error('缺少 --file=<采集 JSON 路径>（由 harvest-playlists.mjs --out 生成）')
  process.exit(1)
}
if (!DRY && !PASSWORD) {
  console.error('缺少 HOLLY_PASSWORD 环境变量（导入接口需要 admin 登录态）')
  process.exit(1)
}

// ============ 文件读取与校验 ============
let payload
try {
  payload = JSON.parse(fs.readFileSync(FILE, 'utf8'))
} catch (e) {
  console.error(`读取/解析 ${FILE} 失败: ${e.message}`)
  process.exit(1)
}

const items = Array.isArray(payload?.items) ? payload.items : []
const bySource = {}
const VALID_SOURCES = ['tx', 'wy', 'kw', 'kg', 'mg']
let invalid = 0
for (const it of items) {
  const ok =
    it !== null && typeof it === 'object'
    && typeof it.name === 'string' && it.name !== ''
    && typeof it.songmid === 'string' && it.songmid !== ''
    && VALID_SOURCES.includes(it.source)
  if (ok) bySource[it.source] = (bySource[it.source] || 0) + 1
  else invalid++
}

console.log('========== 采集数据推送 ==========')
console.log(`文件: ${FILE}（采集于 ${payload?.harvestedAt || '未知时间'}，version ${payload?.version ?? '?'}）`)
console.log(`曲目: ${items.length} 条（${Object.entries(bySource).map(([s, n]) => `${s}:${n}`).join(' ') || '无有效条目'}${invalid ? `，另有 ${invalid} 条格式非法` : ''}）`)
console.log(`目标: ${TARGET} | 每批 ${BATCH} 条${RECOMMEND ? ' | 入库后写入推荐白名单' : ''}`)
if (DRY) {
  console.log('** DRY RUN：文件格式如上校验通过，未发任何请求 **')
  process.exit(invalid === items.length && items.length > 0 ? 1 : 0)
}
if (items.length === 0 || invalid === items.length) {
  console.error('没有可推送的有效条目')
  process.exit(1)
}
const validItems = items.filter((it) =>
  it !== null && typeof it === 'object'
  && typeof it.name === 'string' && it.name !== ''
  && typeof it.songmid === 'string' && it.songmid !== ''
  && VALID_SOURCES.includes(it.source))

// ============ 登录 ============
let COOKIE = ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function login() {
  const res = await fetch(`${TARGET}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json?.success) {
    console.error(`登录失败: ${json?.error?.message || `HTTP ${res.status}`}`)
    process.exit(1)
  }
  // 收集 set-cookie（holly_user / holly_sv / holly_sig）；getSetCookie 需 Node 20+
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean)
  COOKIE = raw.map((c) => c.split(';')[0]).join('; ')
  if (!COOKIE) {
    console.error('登录成功但未取到 cookie（Node 版本过低？需 20+），无法继续')
    process.exit(1)
  }
  console.log(`✓ 已登录 ${USERNAME}@${TARGET}`)
}

// ============ 分批推送 ============
/** 401/403 是配置问题直接抛终止；网络/5xx 指数退避重试 */
async function pushBatch(chunk, retry = MAX_RETRY) {
  try {
    const res = await fetch(`${TARGET}/api/admin/music-info/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: COOKIE },
      body: JSON.stringify({ items: chunk, recommend: RECOMMEND }),
    })
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error(`HTTP ${res.status}（登录态或权限不足）`), { fatal: true })
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    if (!json?.success) throw new Error(json?.error?.message || '接口返回 success=false')
    return json.data
  } catch (e) {
    if (e.fatal) throw e
    if (retry > 0) {
      await sleep(2000 * (MAX_RETRY - retry + 1))
      return pushBatch(chunk, retry - 1)
    }
    throw e
  }
}

const totals = { received: 0, skipped: 0, inserted: 0, updated: 0, noop: 0, recommended: 0 }
await login()

for (let i = 0; i < validItems.length; i += BATCH) {
  const chunk = validItems.slice(i, i + BATCH)
  try {
    const r = await pushBatch(chunk)
    for (const k of Object.keys(totals)) totals[k] += r?.[k] ?? 0
    console.log(`  ✓ 批次 ${Math.floor(i / BATCH) + 1}: +${r?.inserted ?? 0} 新增 / ${r?.updated ?? 0} 更新 / ${r?.noop ?? 0} 未变 / ${r?.skipped ?? 0} 跳过`)
  } catch (e) {
    console.error(`\n✗ 批次 ${Math.floor(i / BATCH) + 1} 推送失败: ${e.message}`)
    console.error(`  已推送 ${i}/${validItems.length} 条后中止；修复后重跑同一命令即可（入库幂等，已入库的会 noop 跳过）`)
    process.exit(1)
  }
}

console.log('\n========== 推送完成 ==========')
console.log(`入库: ${totals.inserted} 新增 / ${totals.updated} 更新 / ${totals.noop} 未变（净增 ${totals.inserted}）`)
if (totals.skipped) console.log(`服务端跳过非法条目: ${totals.skipped}`)
if (RECOMMEND) console.log(`推荐白名单写入: ${totals.recommended} 首`)

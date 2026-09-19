#!/usr/bin/env node
/**
 * 源健康摸底：把「启用源 × 平台」矩阵逐格取址 + 首块字节验证，输出耗时分布与坏因。
 *
 * 为什么要它：实时账本（lib/server/source-health.ts）是被动记账，瀑布止于首次成功，
 * 所以只有头源那一格会被真实流量填上（本地实测：1 格 / 应覆盖 31 格）。3c 要按
 * 「连续坏几次就跳过、冷却多久、半开放几个」定参数，没有全矩阵的耗时/坏因分布就只能凭手感。
 *
 * 探测跑在独立进程的**内联沙箱**里（等价 SOURCE_RUNNER_MODE=inline 的老路径），不经过
 * MusicSourceManager，因此：不写实时账本、不落音乐库、不进磁盘缓存、不碰 config。
 * 坏脚本在这里崩溃也不会波及正在跑的 dev/生产服务。
 *
 * 用法：
 *   node scripts/probe-source-matrix.js --samples            # 只看选出的基准样本，不探测
 *   node scripts/probe-source-matrix.js                      # 跑全矩阵
 *   node scripts/probe-source-matrix.js --sources=屿溪,星海   # 名称子串过滤
 *   node scripts/probe-source-matrix.js --platforms=wy,tx --quality=flac --samples=1
 *   node scripts/probe-source-matrix.js --json=probe-report.json
 *
 * 每格 = 源×平台×基准样本。成本上限 = 格数 × (取址预算 + 首块预算)，默认串行。
 */
const fs = require('fs')
const path = require('path')
const LXEnvironmentSimulator = require('../lib/music-core/index')

const ROOT = path.resolve(__dirname, '..')
const write = (s = '') => process.stdout.write(s + (s.endsWith('\n') ? '' : '\n'))

// ── 参数 ───────────────────────────────────────────
function arg(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const has = name => process.argv.includes(`--${name}`)

const OPT = {
  quality: arg('quality', '320k'),
  samplesPerPlatform: Number(arg('samples', '2')),
  resolveTimeoutMs: Number(arg('resolve-timeout', '8000')),
  headTimeoutMs: Number(arg('head-timeout', '8000')),
  headBytes: Number(arg('head-bytes', '65536')),
  sources: arg('sources', ''),
  platforms: arg('platforms', ''),
  json: arg('json', ''),
  gapMs: Number(arg('gap', '300')),
}

const ALL_PLATFORMS = ['kw', 'tx', 'wy', 'kg', 'mg']

// ── 内联探测工具（TS 模块不能被 CJS require，判据与 lib/server/* 手工对齐）──────
/**
 * 与 lib/server/audio-sniff.ts 的 CONTAINER_TESTS 逐项对齐（判"能否交付"，不是"如何命名"）。
 * 注意别照抄 CONTAINER_TYPES：那张表刻意不含 mp4/asf/avi，但它管的是扩展名覆盖；
 * 健康判定上 m4a 是 tx/kg 的常见正常载荷，判成"认不出"会把好源当坏源。
 */
function detectAudioContainer(buf) {
  if (!buf || buf.length < 2) return null
  const at = (off, ascii) =>
    buf.length >= off + ascii.length && buf.subarray(off, off + ascii.length).toString('latin1') === ascii
  if (at(0, 'ID3')) return 'mp3'
  if (at(0, 'fLaC')) return 'flac'
  if (at(0, 'OggS')) return 'ogg'
  if (at(0, 'RIFF') && (at(8, 'WAVE') || at(8, 'AVI '))) return at(8, 'AVI ') ? 'avi' : 'wav'
  if (at(4, 'ftyp')) return 'mp4'
  if (at(0, 'FORM') && (at(8, 'AIFF') || at(8, 'AIFC'))) return 'aiff'
  if (at(0, 'MAC ')) return 'ape'
  if (at(0, 'wvpk')) return 'wavpack'
  if (at(0, 'TTA1')) return 'tta'
  if (at(0, '#!AMR')) return 'amr'
  if (at(0, 'DSD ')) return 'dsf'
  if (buf.length >= 4 && buf[0] === 0x30 && buf[1] === 0x26 && buf[2] === 0xb2 && buf[3] === 0x75) return 'asf'
  if (at(0, '.RMF')) return 'realmedia'
  if (at(0, '.snd')) return 'au'
  if (at(0, 'caff')) return 'caf'
  if (at(0, 'MThd')) return 'midi'
  if (buf[0] === 0x0b && buf[1] === 0x77) return 'ac3'
  if (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0xfe && buf[2] === 0x80 && buf[3] === 0x01) return 'dts'
  // MPEG 帧同步（11 位全 1 + 版本位非保留），MP3/ADTS AAC 共用
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && ((buf[1] >> 3) & 0x03) !== 0x01) return 'mpeg-frame'
  return null
}

/** 文本/结构化载荷 → 假地址（音源常返回 HTML 错误页或 JSON 报错体） */
function looksTextLike(buf) {
  if (!buf || buf.length < 2) return false
  const head = buf.subarray(0, Math.min(buf.length, 512)).toString('latin1').trimStart().toLowerCase()
  return head.startsWith('<') || head.startsWith('{') || head.startsWith('[') ||
    head.includes('<!doctype html') || head.includes('<html')
}

/** 公网 http(s) 才允许探测（与 lib/server/url-guard.ts 的意图一致，脚本侧做简化判据） */
function isProbeableUrl(value) {
  let u
  try {
    u = new URL(value)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const h = u.hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.local') || h === '' ) return false
  if (/^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.)/.test(h)) return false
  if (h === '100.64.0.0' || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return false
  if (/^[a-f0-9:]*$/i.test(h) && h.includes(':')) return false // IPv6 字面量
  return true
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时 ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

const pct = (sorted, p) => {
  if (!sorted.length) return null
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[idx]
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── 基准样本：每平台取「真被播过」的前 N 首 ───────────
// 为什么不用随机曲：源里没这首歌 → 整格 noMatch，和"源坏了"分不开。基准样本必须是
// 至少有一个源真出过货的曲子（被播过即证明），这样 noMatch 才重新具备诊断意义。
async function pickSamples(prisma, perPlatform) {
  const out = {}
  for (const platform of ALL_PLATFORMS) {
    const played = await prisma.$queryRaw`
      SELECT m.id, CAST(SUM(p.playCount) AS INTEGER) AS plays
      FROM MusicInfo m JOIN PlayHistory p ON p.musicInfoId = m.id
      WHERE m.source = ${platform} AND m.durationSeconds > 0
      GROUP BY m.id
      ORDER BY plays DESC, MAX(p.playedAt) DESC, m.id ASC
      LIMIT ${perPlatform}
    `
    let ids = played.map(r => Number(r.id))
    if (ids.length < perPlatform) {
      // 该平台没有播放记录（mg 常如此）：退回推荐白名单，再退回最近更新
      const where = { source: platform, durationSeconds: { gt: 0 }, id: { notIn: ids } }
      let fill = await prisma.musicInfo.findMany({
        where: { ...where, isRecommended: true }, orderBy: { updatedAt: 'desc' }, take: perPlatform - ids.length, select: { id: true },
      })
      if (fill.length < perPlatform - ids.length) {
        fill = fill.concat(await prisma.musicInfo.findMany({
          where, orderBy: { updatedAt: 'desc' }, take: perPlatform - ids.length - fill.length, select: { id: true },
        }))
      }
      ids = ids.concat(fill.map(r => r.id))
    }
    const rows = await prisma.musicInfo.findMany({ where: { id: { in: ids } } })
    // 保持选中的顺序（plays 优先）
    out[platform] = ids.map(id => rows.find(r => r.id === id)).filter(Boolean)
  }
  return out
}

function toMusicInfo(row) {
  let base = {}
  try {
    base = JSON.parse(row.data) || {}
  } catch {
    base = {}
  }
  // 搜索结果里的原始字段优先，缺失时用表上展开列补齐
  return {
    id: base.id ?? row.songmid,
    mid: base.mid ?? row.songmid,
    songmid: base.songmid ?? row.songmid,
    hash: base.hash ?? row.hash,
    songId: base.songId ?? row.songId,
    copyrightId: base.copyrightId ?? row.copyrightId,
    albumId: base.albumId ?? row.albumId,
    albumMid: base.albumMid ?? row.albumMid,
    strMediaMid: base.strMediaMid ?? row.strMediaMid,
    name: base.name ?? row.name ?? '',
    singer: base.singer ?? row.singer ?? '',
    duration: base.duration ?? row.durationSeconds ?? 0,
    types: base.types || [],
    typesMap: base.typesMap || {},
    source: row.source,
  }
}

// ── 首块验证：把「取出地址」和「地址真能给音频字节」分开计 ──
// 只取址会漏掉最坑的一类故障：地址给了，内容是 HTML/JSON 假页（第 0 刀之前正是它挡路）。
async function probeBytes(url, opt) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opt.headTimeoutMs)
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        Range: `bytes=0-${opt.headBytes - 1}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    })
    const buf = Buffer.from(await resp.arrayBuffer())
    const ct = resp.headers.get('content-type') || ''
    await resp.body?.cancel().catch(() => {})
    const container = detectAudioContainer(buf)
    if (container) return { outcome: 'ok', container, status: resp.status, bytes: buf.length, contentType: ct }
    if (looksTextLike(buf)) return { outcome: 'fake', reason: `文本载荷(${ct || '无 CT'}, ${buf.length}B)`, status: resp.status, bytes: buf.length, contentType: ct }
    if (!resp.ok) return { outcome: 'http-error', reason: `HTTP ${resp.status}`, bytes: buf.length, contentType: ct }
    if (buf.length < 1024) return { outcome: 'fake', reason: `字节过少(${buf.length}B)`, status: resp.status, contentType: ct }
    return { outcome: 'unverified', reason: '认不出容器', status: resp.status, bytes: buf.length, contentType: ct }
  } catch (e) {
    return { outcome: 'head-error', reason: (e && e.message ? e.message : String(e)).slice(0, 100) }
  } finally {
    clearTimeout(timer)
  }
}

// ── 单格探测：源在指定平台上对一首基准曲取址并验证首块 ──
async function probeCell(sim, platform, musicInfo, opt) {
  const started = Date.now()
  let url
  try {
    url = await withTimeout(
      sim.getMusicUrl(platform, musicInfo, opt.quality),
      opt.resolveTimeoutMs,
      `取址 ${platform}/${opt.quality}`,
    )
  } catch (e) {
    const msg = (e && e.message ? e.message : String(e)).slice(0, 120)
    const timeout = msg.includes('超时')
    return { outcome: timeout ? 'timeout' : 'error', reason: msg, resolveMs: Date.now() - started }
  }
  const resolveMs = Date.now() - started

  if (!url || typeof url !== 'string' || !url.trim()) {
    return { outcome: 'no-address', reason: '脚本返回空地址', resolveMs }
  }
  if (!isProbeableUrl(url)) {
    return { outcome: 'ssrf', reason: '非公网 http(s) 地址', resolveMs, urlPreview: url.slice(0, 60) }
  }
  const head = await probeBytes(url, opt)
  return { ...head, resolveMs, byteMs: head.outcome === 'ok' || head.outcome === 'unverified' ? Date.now() - started - resolveMs : null, urlPreview: url.slice(0, 60) }
}

const BAD_OUTCOMES = new Set(['timeout', 'error', 'fake', 'ssrf', 'http-error', 'head-error'])

function summarize(results) {
  const okLat = results.filter(r => r.outcome === 'ok').map(r => r.resolveMs).sort((a, b) => a - b)
  const badLat = results.filter(r => BAD_OUTCOMES.has(r.outcome)).map(r => r.resolveMs).sort((a, b) => a - b)
  const kinds = {}
  for (const r of results) kinds[r.outcome] = (kinds[r.outcome] || 0) + 1
  return {
    attempts: results.length,
    ok: kinds.ok || 0,
    noMatch: kinds['no-address'] || 0,
    bad: results.filter(r => BAD_OUTCOMES.has(r.outcome)).length,
    kinds,
    okP50: pct(okLat, 50),
    okP90: pct(okLat, 90),
    badP50: pct(badLat, 50),
    badMax: badLat.length ? badLat[badLat.length - 1] : null,
  }
}

const cellLabel = r => ({
  ok: '出货', 'no-address': '无地址', timeout: '取址超时', error: '取址报错',
  fake: '假地址', ssrf: '私网地址', 'http-error': '首块HTTP错', 'head-error': '首块拉取失败',
  unverified: '字节认不出',
}[r.outcome] || r.outcome)

;(async () => {
  // 沙箱与脚本自身的 console 输出很吵（[Info]/[Result] 全量 JSON），统一改走 stdout.write
  if (!has('verbose')) {
    console.log = () => {}
    console.info = () => {}
    console.debug = () => {}
    console.warn = () => {}
    console.error = () => {}
  }

  const { PrismaClient } = require('../lib/generated/prisma')
  if (!process.env.DATABASE_URL) {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/)
      if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, '')
    }
  }
  const prisma = new PrismaClient()

  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/music-sources.json'), 'utf-8'))
  let sources = (config.sources || []).filter(s => s.enabled)
  if (OPT.sources) {
    const keys = OPT.sources.split(',').map(x => x.trim()).filter(Boolean)
    sources = sources.filter(s => keys.some(k => (s.name || s.path).includes(k)))
  }
  const wantedPlatforms = OPT.platforms ? OPT.platforms.split(',').map(x => x.trim()) : ALL_PLATFORMS

  const samples = await pickSamples(prisma, Math.max(1, OPT.samplesPerPlatform))
  write('==== 基准样本（按播放量取，跨次运行可比）====')
  for (const p of ALL_PLATFORMS) {
    const list = samples[p] || []
    write(`  ${p}: ${list.length ? list.map(r => `${r.name}-${r.singer}[${r.songmid}]`).join('、') : '库内无候选'}`)
  }
  const totalSamples = ALL_PLATFORMS.reduce((a, p) => a + (samples[p] || []).length, 0)
  write(`\n启用源 ${sources.length} 个，基准样本 ${totalSamples} 首，音质档 ${OPT.quality}，取址预算 ${OPT.resolveTimeoutMs}ms`)

  if (has('samples')) {
    await prisma.$disconnect()
    write('\n--samples 只读模式，结束。')
    process.exit(0)
  }

  let planned = 0
  for (const s of sources) {
    const pt = Array.isArray(s.pt) && s.pt.length ? s.pt : ALL_PLATFORMS
    for (const p of pt.filter(x => wantedPlatforms.includes(x))) planned += (samples[p] || []).length
  }
  write(`计划探测 ${planned} 格（最坏耗时 ≈ ${(planned * (OPT.resolveTimeoutMs + OPT.headTimeoutMs) / 60000).toFixed(1)} 分钟）\n`)

  const report = { startedAt: new Date().toISOString(), quality: OPT.quality, budgets: OPT, samples: {}, sources: [] }
  for (const p of ALL_PLATFORMS) {
    report.samples[p] = (samples[p] || []).map(r => ({ songmid: r.songmid, name: r.name, singer: r.singer }))
  }

  const matrix = []
  for (const s of sources) {
    const name = s.name || s.path
    const scriptPath = path.resolve(ROOT, s.path)
    const sim = new LXEnvironmentSimulator()
    const entry = { name, path: s.path, priority: s.priority, pt: s.pt || null, platforms: {}, error: null }
    let info = null
    try {
      info = await withTimeout(sim.loadScript(scriptPath), 20000, 'loadScript')
    } catch (e) {
      entry.error = `脚本加载失败: ${(e && e.message ? e.message : String(e)).slice(0, 100)}`
      report.sources.push(entry)
      write(`[p${s.priority}] ${name} → ${entry.error}`)
      sim.dispose()
      continue
    }

    const declared = Object.keys(info?.sources || {})
    const declaredPt = Array.isArray(s.pt) && s.pt.length ? s.pt : ALL_PLATFORMS
    write(`[p${s.priority}] ${name}  声明平台=[${declared.join(',')}]  配置pt=[${declaredPt.join(',')}]`)

    for (const platform of declaredPt.filter(x => wantedPlatforms.includes(x))) {
      const cfg = info.sources[platform]
      if (!cfg || !(cfg.actions || []).includes('musicUrl')) {
        entry.platforms[platform] = { skipped: '脚本未声明 musicUrl' }
        write(`   ${platform}: 跳过（脚本未声明）`)
        continue
      }
      const results = []
      for (const row of samples[platform] || []) {
        const r = await probeCell(sim, platform, toMusicInfo(row), OPT)
        results.push({ songmid: row.songmid, name: row.name, ...r })
        write(`   ${platform} ${String(row.name).slice(0, 14).padEnd(15)} ${cellLabel(r).padEnd(7)} 取址${r.resolveMs || 0}ms${r.reason ? ` — ${r.reason}` : ''}${r.container ? ` (${r.container})` : ''}`)
      }
      entry.platforms[platform] = { ...summarize(results), results }
    }
    sim.dispose()
    report.sources.push(entry)
    await sleep(OPT.gapMs)
  }

  // ── 矩阵汇总 ──
  write('\n==== 源 × 平台矩阵（出货/尝试 · 取址p50 · 坏因）====')
  const header = ['源'.padEnd(28), ...ALL_PLATFORMS.map(p => p.padEnd(16))].join('')
  write(header)
  for (const entry of report.sources) {
    const cells = ALL_PLATFORMS.map(p => {
      const c = entry.platforms[p]
      if (!c) return '—'.padEnd(16)
      if (c.skipped) return '未声明'.padEnd(16)
      const badKinds = Object.entries(c.kinds).filter(([k]) => k !== 'ok').map(([k, v]) => `${cellLabel({ outcome: k })}${v}`).join('/')
      return `${c.ok}/${c.attempts} p50=${c.okP50 ?? '-'}${badKinds ? ' ' + badKinds : ''}`.padEnd(16)
    }).join('')
    write(`${String(entry.name).slice(0, 26).padEnd(28)}${cells}${entry.error ? ' [加载失败]' : ''}`)
  }

  // ── 横向交叉验证：同一首基准曲哪些源出货 ──
  write('\n==== 按曲目交叉验证（区分「源坏了」与「源里没这首歌」）====')
  for (const platform of ALL_PLATFORMS) {
    for (const row of samples[platform] || []) {
      const hits = []
      const misses = []
      for (const entry of report.sources) {
        const c = entry.platforms[platform]
        if (!c || !c.results) continue
        const r = c.results.find(x => x.songmid === row.songmid)
        if (!r) continue
        ;(r.outcome === 'ok' ? hits : misses).push(`${entry.name}(${cellLabel(r)})`)
      }
      write(`  [${platform}] ${String(row.name).slice(0, 18)}-${row.singer}: 出货 ${hits.length} | 不出货 ${misses.length}`)
      if (misses.length) write(`      ${misses.join('、')}`)
    }
  }

  // ── 3c 阈值要点 ──
  write('\n==== 定阈值用的汇总 ====')
  const globalContainers = {}
  for (const entry of report.sources) {
    const all = Object.values(entry.platforms).filter(c => c && c.attempts)
    if (!all.length) { write(`  ${entry.name}: 无有效探测`); continue }
    const agg = summarize(all.flatMap(c => c.results))
    const containers = {}
    for (const r of all.flatMap(c => c.results)) {
      if (r.container) { containers[r.container] = (containers[r.container] || 0) + 1; globalContainers[r.container] = (globalContainers[r.container] || 0) + 1 }
    }
    const ct = Object.entries(containers).map(([k, v]) => `${k}×${v}`).join(',')
    write(`  ${String(entry.name).padEnd(28)} 出货 ${agg.ok}/${agg.attempts} 坏 ${agg.bad} 无地址 ${agg.noMatch} | 好样取址 p50=${agg.okP50 ?? '-'}ms p90=${agg.okP90 ?? '-'}ms | 坏样 p50=${agg.badP50 ?? '-'}ms max=${agg.badMax ?? '-'}ms | ${ct}`)
  }
  write(`\n容器分布（全矩阵）: ${Object.entries(globalContainers).map(([k, v]) => `${k}×${v}`).join('  ')}`)

  if (OPT.json) {
    fs.writeFileSync(path.resolve(ROOT, OPT.json), JSON.stringify(report, null, 2))
    write(`\n明细已写入 ${OPT.json}`)
  }
  await prisma.$disconnect()
  process.exit(0)
})().catch(e => {
  write(`脚本异常: ${(e && e.stack) || e}`)
  process.exit(1)
})

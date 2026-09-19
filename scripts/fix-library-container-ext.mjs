/**
 * 一次性修复：音乐库正本的文件扩展名与真实容器不符（默认 dry-run，加 --apply 才落盘）。
 *
 * 根因：入库扩展名此前照抄上游 Content-Type，而音源的 CT 会撒谎（把 FLAC 字节标成
 * audio/mpeg 是常态）。本地库实测 228 个 `.mp3` 命名的正本里有 115 个真实容器是 FLAC。
 * 代码侧已修好（嗅探容器优先，见 lib/server/audio-sniff.ts 的 CONTAINER_TYPES），本脚本
 * 只处理修好之前已经入库的存量文件。
 *
 * 动作：逐条读文件头魔数 → 认出容器且与现扩展名不符 → 连同歌词边车（.lrc /
 * .tlyric.lrc，与音频同目录同名）一起改名 + 更新 LibrarySong.filePath。目标名已被占用
 * 时跳过并报告，不自动加序号——重复正本是要人看一眼的数据问题，不是命名问题。
 *
 * 顺带审计（只报告不改动）：AudioCache 行里同样谎报的 contentType，它只影响缓存命中时
 * 的响应头，重下即自然收敛。
 *
 * 魔数判据与 lib/server/audio-sniff.ts 的 CONTAINER_TYPES 一一对应（TS 模块不能被 .mjs
 * 直接 require，故此处内联同一张表）。mp4 / asf / avi / realmedia 等可承载视频的容器
 * 一律不动。
 *
 * 用法：
 *   node scripts/fix-library-container-ext.mjs            # 只看报告，不落盘
 *   node scripts/fix-library-container-ext.mjs --apply    # 真正改名
 */
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const { PrismaClient } = require('../lib/generated/prisma')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 与 lib/server/audio-sniff.ts 的 CONTAINER_TYPES 同步（视频可承载的容器刻意不列） */
const CONTAINER_TYPES = [
  { name: 'mp3', mime: 'audio/mpeg', ext: '.mp3' },
  { name: 'flac', mime: 'audio/flac', ext: '.flac' },
  { name: 'ogg', mime: 'audio/ogg', ext: '.ogg' },
  { name: 'wav', mime: 'audio/wav', ext: '.wav' },
  { name: 'aiff', mime: 'audio/aiff', ext: '.aiff' },
  { name: 'ape', mime: 'audio/ape', ext: '.ape' },
  { name: 'wavpack', mime: 'audio/wavpack', ext: '.wv' },
  { name: 'tta', mime: 'audio/x-tta', ext: '.tta' },
  { name: 'dsf', mime: 'audio/x-dsf', ext: '.dsf' },
  { name: 'amr', mime: 'audio/amr', ext: '.amr' },
  { name: 'au', mime: 'audio/basic', ext: '.au' },
  { name: 'caf', mime: 'audio/x-caf', ext: '.caf' },
]

/** Content-Type 别名归一（音源常发 audio/x-flac 这类非规范变体） */
const MIME_ALIASES = {
  'audio/mp3': 'audio/mpeg',
  'audio/x-flac': 'audio/flac',
  'audio/x-wav': 'audio/wav',
  'audio/x-pn-windows-acm': 'audio/wav',
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Prisma Client 只读进程环境；裸 node 运行时从 .env 补 DATABASE_URL */
function ensureDatabaseUrl() {
  if (process.env.DATABASE_URL) return
  const envFile = path.join(root, '.env')
  if (!fs.existsSync(envFile)) return
  for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/)
    if (m) {
      process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, '')
      return
    }
  }
}

/** 识别文件头魔数对应的容器；认不出或可能是视频容器返回 null */
function sniffContainer(filePath) {
  let fd = null
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(64)
    const { bytesRead } = fs.readSync(fd, buf, 0, 64, 0)
    const h = buf.subarray(0, bytesRead)
    if (bytesRead < 4) return null
    const at = (off, ascii) =>
      h.length >= off + ascii.length && h.subarray(off, off + ascii.length).toString('latin1') === ascii

    const byName = {
      mp3: at(0, 'ID3') || mpegFrameSync(h),
      flac: at(0, 'fLaC'),
      ogg: at(0, 'OggS'),
      ape: at(0, 'MAC '),
      wavpack: at(0, 'wvpk'),
      tta: at(0, 'TTA1'),
      amr: at(0, '#!AMR'),
      dsf: at(0, 'DSD '),
      au: at(0, '.snd'),
      caf: at(0, 'caff'),
      aiff: at(0, 'FORM') && (at(8, 'AIFF') || at(8, 'AIFC')),
      wav: at(0, 'RIFF') && at(8, 'WAVE'),
    }
    const hit = CONTAINER_TYPES.find(t => byName[t.name])
    return hit ?? null
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** MPEG 音频帧同步字（与 audio-sniff.isMpegFrameSync 同款；括号不可省：& 优先级低于 !==） */
function mpegFrameSync(h) {
  if (h.length < 2) return false
  if (h[0] !== 0xff || (h[1] & 0xe0) !== 0xe0) return false
  return ((h[1] >> 3) & 0x03) !== 0x01
}

/** rename + EPERM/EBUSY 重试（Windows 下 dev/播放器正读着该文件会占用） */
async function renameWithRetry(from, to) {
  for (let i = 0; i < 3; i++) {
    try {
      await fsp.rename(from, to)
      return true
    } catch (e) {
      if (e.code === 'ENOENT') return false // 边车本就不存在，不算失败
      if (e.code === 'EPERM' || e.code === 'EBUSY') {
        await sleep(2000)
        continue
      }
      throw e
    }
  }
  console.log(`[失败] 文件被占用，放弃: ${from}`)
  return false
}

async function main() {
  ensureDatabaseUrl()
  const apply = process.argv.includes('--apply')
  const prisma = new PrismaClient()
  const rows = await prisma.librarySong.findMany({ orderBy: { id: 'asc' } })

  const plan = []
  let ok = 0
  let missing = 0
  let unknown = 0

  for (const row of rows) {
    if (!fs.existsSync(row.filePath)) {
      missing++
      console.log(`[缺失] #${row.id} ${row.singer} - ${row.name} :: ${row.filePath}`)
      continue
    }
    const container = sniffContainer(row.filePath)
    const oldExt = path.extname(row.filePath).toLowerCase()
    if (!container) {
      unknown++
      continue
    }
    if (container.ext === oldExt) {
      ok++
      continue
    }
    const dest = row.filePath.slice(0, row.filePath.length - oldExt.length) + container.ext
    plan.push({
      id: row.id,
      label: `${row.singer} - ${row.name}`,
      from: row.filePath,
      to: dest,
      oldExt,
      newExt: container.ext,
      container: container.name,
      occupied: fs.existsSync(dest),
    })
  }

  for (const p of plan) {
    const tag = p.occupied ? '[冲突跳过]' : apply ? '[改名]' : '[待改名]'
    console.log(`${tag} #${p.id} ${p.label} 容器=${p.container}\n          ${path.basename(p.from)} -> ${path.basename(p.to)}`)
  }

  let renamed = 0
  let sidecarMoved = 0
  let failed = 0
  let conflicts = 0

  if (apply) {
    for (const p of plan) {
      if (p.occupied) {
        conflicts++
        continue
      }
      if (!(await renameWithRetry(p.from, p.to))) {
        failed++
        continue
      }
      const stemFrom = p.from.slice(0, p.from.length - p.oldExt.length)
      const stemTo = p.to.slice(0, p.to.length - p.newExt.length)
      for (const suffix of ['.lrc', '.tlyric.lrc']) {
        if (!fs.existsSync(stemFrom + suffix)) continue
        if (await renameWithRetry(stemFrom + suffix, stemTo + suffix)) sidecarMoved++
      }
      await prisma.librarySong
        .update({ where: { id: p.id }, data: { filePath: p.to } })
        .catch(async e => {
          // 登记行没改成就先还原文件名，避免库内出现指向旧名的死路径
          console.log(`[回滚] #${p.id} 更新登记失败（${e.message}），改回原名`)
          await renameWithRetry(p.to, p.from)
          throw e
        })
      renamed++
    }
  }

  let cacheWrong = 0
  const cacheRows = await prisma.audioCache.findMany({ select: { cacheKey: true, filePath: true, contentType: true } })
  const cacheRoot = path.resolve(root, process.env.AUDIO_CACHE_DIR || 'data/audio-cache')
  for (const r of cacheRows) {
    const abs = path.isAbsolute(r.filePath) ? r.filePath : path.join(cacheRoot, r.filePath)
    const declared = (r.contentType || '').toLowerCase().split(';')[0].trim()
    if (!declared) continue
    const canon = MIME_ALIASES[declared] ?? declared
    const container = fs.existsSync(abs) ? sniffContainer(abs) : null
    if (container && container.mime !== canon) {
      cacheWrong++
      console.log(`[缓存谎报] ${r.cacheKey} 记录=${declared} 字节=${container.mime}`)
    }
  }

  const applied = apply ? `（已改名 ${renamed}，冲突跳过 ${conflicts}，占用失败 ${failed}，歌词边车随迁 ${sidecarMoved}）` : '（dry 未落盘，加 --apply 执行）'
  console.log(
    `\n库内共 ${rows.length} 条：命名相符 ${ok}，待改名 ${plan.length}${applied}，` +
      `文件缺失 ${missing}，容器未识别或可能是视频 ${unknown}`
  )
  console.log(`AudioCache 里 contentType 与容器不符的记录 ${cacheWrong} 条（本脚本不改动；该记录只影响缓存命中时的响应头）`)
  await prisma.$disconnect()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})

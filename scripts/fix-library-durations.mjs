/**
 * 一次性修复：音乐库登记时长（kw 等源 interval 脏值导致的 1-4 秒错误登记）。
 *
 * 根因：旧入库逻辑在 checkTrialAudio 跳过探测（interval<120）时回退元数据
 * interval，kw 部分歌曲的 interval 是 1-4 秒的脏值。
 *
 * 动作：对库内全部条目重新探测文件真实时长，与登记值相差 >5s 的更新。
 *
 * 用法：node scripts/fix-library-durations.mjs [--dry]
 */
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { PrismaClient } = require('../lib/generated/prisma')
// 与 lib/server/audio-integrity.ts 同库（TS 不能直接 require，这里用原库）
const { parseFile } = require('music-metadata')

/** MP4 mvhd box 直解（music-metadata 对 mp42 视频容器解析失败时的回退） */
function parseMp4Duration(buf) {
  // 逐层找 moov/mvhd（简单扫描，足够修复场景用）
  const idx = buf.indexOf(Buffer.from('mvhd'))
  if (idx < 0) return null
  let o = idx + 4 // 跳过 box type
  const version = buf.readUInt8(o); o += 4 // version + flags
  if (version === 1) {
    o += 16 // creation + modification (8+8)
    const timescale = buf.readUInt32BE(o); o += 4
    const duration = Number(buf.readBigUInt64BE(o))
    return timescale > 0 && duration > 0 ? duration / timescale : null
  }
  o += 8 // creation + modification (4+4)
  const timescale = buf.readUInt32BE(o); o += 4
  const duration = buf.readUInt32BE(o)
  return timescale > 0 && duration > 0 ? duration / timescale : null
}

/** 解析本地音频文件真实时长（秒）；失败返回 null */
async function parseDurationFromFile(filePath) {
  try {
    const meta = await parseFile(filePath)
    const d = meta.format.duration
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) return d
    throw new Error('no duration')
  } catch {
    const buf = require('fs').readFileSync(filePath)
    return parseMp4Duration(buf)
  }
}

const DRY = process.argv.includes('--dry')

async function main() {
  const prisma = new PrismaClient()
  const rows = await prisma.librarySong.findMany()
  let fixed = 0
  let ok = 0
  let failed = 0

  for (const row of rows) {
    const probed = await parseDurationFromFile(row.filePath)
    if (probed === null) {
      failed++
      console.log(`[skip] 探测失败: ${row.name}`)
      continue
    }
    if (Math.abs(probed - row.durationSec) > 5) {
      console.log(`[fix] ${row.name} | ${Math.round(row.durationSec)}s -> ${Math.round(probed)}s`)
      if (!DRY) {
        await prisma.librarySong.update({ where: { id: row.id }, data: { durationSec: probed } })
      }
      fixed++
    } else {
      ok++
    }
  }

  console.log(`\n共 ${rows.length} 条：修正 ${fixed}，本就正确 ${ok}，探测失败 ${failed}${DRY ? '（dry 未落盘）' : ''}`)
  await prisma.$disconnect()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})

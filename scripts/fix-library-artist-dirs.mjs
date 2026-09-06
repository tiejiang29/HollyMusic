/**
 * 一次性修复：多歌手合并名目录/去重键（primarySinger 旧正则缺陷的存量数据）。
 *
 * 问题：旧版 primarySinger 对 "灯叔、方大树" 这类串匹配失败回退成完整串，
 * 导致 library/ 下出现合并歌手目录、dedupeKey 也带合并名。
 *
 * 动作：按修复后的规则（分隔符切分取第一个）重算每行的主歌手与 dedupeKey，
 * 目录不符的文件移到 library/主歌手/<原专辑段>/<原文件名>，并清理空目录。
 *
 * 用法：node scripts/fix-library-artist-dirs.mjs [--dry]
 */
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { PrismaClient } = require('../lib/generated/prisma')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DRY = process.argv.includes('--dry')

function normalizeText(s) {
  return (s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

function primarySinger(singer) {
  const normalized = normalizeText(singer)
  if (!normalized) return '未知歌手'
  const first = normalized
    .split(/[、,，/／&\uFF06;；]/)[0]
    .replace(/\s*(?:feat|ft)\..*$/i, '')
    .trim()
  return first || '未知歌手'
}

function sanitizeFilename(filename, maxLength = 200) {
  let cleaned = filename
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\.\./g, '')
    .trim()
  if (!cleaned) cleaned = 'download'
  cleaned = cleaned.replace(/\.+/g, '.').replace(/\s+/g, ' ')
  if (cleaned.length > maxLength) cleaned = cleaned.substring(0, maxLength)
  return cleaned.replace(/[\s.]+$/, '')
}

async function main() {
  const prisma = new PrismaClient()
  const libraryDir = process.env.AUDIO_LIBRARY_DIR?.trim() || path.join(ROOT, 'data/library')
  const rows = await prisma.librarySong.findMany()
  let moved = 0
  let keyFixed = 0
  let skipped = 0

  for (const row of rows) {
    const correctSinger = sanitizeFilename(primarySinger(row.singer), 80)
    const newKey = `${normalizeText(row.name).toLowerCase()}|${primarySinger(row.singer).toLowerCase()}`
    const oldDir = path.dirname(path.dirname(row.filePath))
    const newDir = path.join(libraryDir, correctSinger)
    const needsMove = path.basename(oldDir) !== correctSinger && row.filePath.startsWith(libraryDir)
    const needsKey = row.dedupeKey !== newKey

    if (!needsMove && !needsKey) {
      skipped++
      continue
    }

    let finalPath = row.filePath
    if (needsMove) {
      const albumSeg = path.basename(path.dirname(row.filePath))
      const fileName = path.basename(row.filePath)
      const destDir = path.join(newDir, albumSeg)
      let dest = path.join(destDir, fileName)
      let counter = 2
      while (fs.existsSync(dest) && dest !== row.filePath) {
        const dot = fileName.lastIndexOf('.')
        dest = path.join(destDir, `${fileName.slice(0, dot)}(${counter})${fileName.slice(dot)}`)
        counter++
      }
      if (dest !== row.filePath) {
        console.log(`[move] ${path.relative(libraryDir, row.filePath)}\n    -> ${path.relative(libraryDir, dest)}`)
        if (!DRY) {
          await fsp.mkdir(destDir, { recursive: true })
          await fsp.rename(row.filePath, dest).catch(async e => {
            if (e.code === 'EXDEV') {
              await fsp.copyFile(row.filePath, dest)
              await fsp.unlink(row.filePath).catch(() => {})
            } else throw e
          })
        }
        finalPath = dest
        moved++
      }
      // 清理旧专辑/旧歌手空目录
      if (!DRY) {
        for (const dir of [path.dirname(row.filePath), oldDir]) {
          try {
            if ((await fsp.readdir(dir)).length === 0) await fsp.rmdir(dir)
          } catch {}
        }
      }
    }

    if (needsKey) keyFixed++
    if (!DRY) {
      await prisma.librarySong.update({
        where: { id: row.id },
        data: { filePath: finalPath, dedupeKey: newKey },
      })
    }
  }

  console.log(`\n共 ${rows.length} 条：移动 ${moved}，去重键修正 ${keyFixed}，无需处理 ${skipped}${DRY ? '（dry 未落盘）' : ''}`)
  await prisma.$disconnect()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})

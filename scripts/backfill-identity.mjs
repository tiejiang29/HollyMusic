/**
 * MusicInfo.identity 存量回填脚本。
 *
 * identity（同款歌分组键）由 lib/song-identity.ts 的 songIdentity 纯函数计算，
 * 新写入由 upsert 路径自动维护；本脚本只负责给迁移前入库的存量行补齐，
 * 并提供误合并时的拆组工具。幂等，可重复执行。
 *
 * 用法（仓库根目录）：
 *   node scripts/backfill-identity.mjs            # 回填全部存量行
 *   node scripts/backfill-identity.mjs --dry      # 只统计不写库
 *   node scripts/backfill-identity.mjs --rekey 42 # 把 id=42 的行拆出当前组（identity 加唯一后缀）
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.DATABASE_URL ??= 'file:./data/music.db'
const require = createRequire(import.meta.url)
const { PrismaClient } = require(path.join(root, 'lib/generated/prisma'))
const { songIdentity } = await import('../lib/song-identity.ts')

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const rekeyIdx = args.indexOf('--rekey')
const rekeyId = rekeyIdx >= 0 ? Number(args[rekeyIdx + 1]) : null

const prisma = new PrismaClient()
const BATCH = 500

try {
  if (rekeyId != null) {
    const row = await prisma.musicInfo.findUnique({ where: { id: rekeyId } })
    if (!row) throw new Error(`musicInfo id=${rekeyId} 不存在`)
    const base = songIdentity(row)
    const identity = `${base}#${row.id}`
    await prisma.musicInfo.update({ where: { id: row.id }, data: { identity } })
    console.log(`已拆组: id=${row.id} "${row.name}" | ${row.singer}`)
    console.log(`  ${base} → ${identity}`)
    process.exit(0)
  }

  let cursor = 0
  let scanned = 0
  let updated = 0
  const groupSizes = new Map()
  for (;;) {
    const rows = await prisma.musicInfo.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: BATCH,
      select: { id: true, name: true, singer: true, identity: true },
    })
    if (rows.length === 0) break
    cursor = rows[rows.length - 1].id

    const needUpdate = []
    for (const row of rows) {
      scanned++
      const identity = songIdentity(row)
      groupSizes.set(identity, (groupSizes.get(identity) ?? 0) + 1)
      if (row.identity !== identity) needUpdate.push({ id: row.id, identity })
    }
    if (!dry && needUpdate.length > 0) {
      await prisma.$transaction(
        needUpdate.map(r => prisma.musicInfo.update({ where: { id: r.id }, data: { identity: r.identity } }))
      )
    }
    updated += needUpdate.length
    console.log(`  已扫描 ${scanned} 行（本批待写 ${needUpdate.length}）`)
  }

  const multi = [...groupSizes.values()].filter(n => n > 1).length
  console.log('---')
  console.log(`${dry ? '[dry] ' : ''}扫描 ${scanned} 行，${dry ? '需' : '已'}回填 ${updated} 行`)
  console.log(`同款歌分组：${groupSizes.size} 组，其中多副本组 ${multi} 组`)
} finally {
  await prisma.$disconnect()
}

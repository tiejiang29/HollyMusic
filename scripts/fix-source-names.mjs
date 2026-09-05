/**
 * 一次性修复：音源脚本乱码文件名（历史上传通道编码损坏，文件名含 U+FFFD 不可逆乱码）。
 *
 * 原理：脚本内容是完好的 UTF-8，头部 @name/@version 注释可重建正确名称。
 * 动作：
 *   1. custom-sources/ 中乱码文件 → 按元数据重命名（目标冲突时追加 -2/-3）
 *   2. config/music-sources.json 中乱码 path/name → 同步为重命名结果
 *
 * 用法：node scripts/fix-source-names.mjs [--dry]
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS_DIR = path.join(ROOT, 'custom-sources')
const CONFIG_PATH = path.join(ROOT, 'config', 'music-sources.json')
const DRY = process.argv.includes('--dry')

/** 与 lib/server/download-utils.ts 的 sanitizeFilename 保持一致（保留中文） */
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

function parseScriptMeta(content) {
  const head = content.slice(0, 2048)
  const pick = key => {
    const m = head.match(new RegExp(`@${key}\\s+([^\\r\\n]+)`))
    if (!m) return undefined
    return m[1].replace(/\s*\*\s*$/, '').trim() || undefined
  }
  return { name: pick('name'), version: pick('version') }
}

const isMojibake = s => s.includes('\uFFFD')

// ---------- 1. 重命名乱码脚本文件 ----------
const renames = new Map() // oldRel -> { newRel, meta }
const files = fs.readdirSync(SCRIPTS_DIR)
for (const f of files) {
  if (!f.endsWith('.js') || !isMojibake(f)) continue
  const oldAbs = path.join(SCRIPTS_DIR, f)
  const meta = parseScriptMeta(fs.readFileSync(oldAbs, 'utf-8'))
  const base = sanitizeFilename([meta.name, meta.version].filter(Boolean).join(' ') || 'unnamed-source')
  let target = path.join(SCRIPTS_DIR, `${base}.js`)
  let counter = 1
  // 目标已存在且不是自己 → 追加序号
  while (fs.existsSync(target) && path.basename(target) !== f) {
    target = path.join(SCRIPTS_DIR, `${base}-${counter}.js`)
    counter++
  }
  const newRel = `custom-sources/${path.basename(target)}`
  console.log(`[rename] ${JSON.stringify(f)}\n      -> ${newRel}`)
  if (!DRY) fs.renameSync(oldAbs, target)
  renames.set(`custom-sources/${f}`, { newRel, meta })
}

// ---------- 2. 同步配置 ----------
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
let changed = false
for (const s of config.sources) {
  const rename = renames.get(s.path)
  if (rename && rename.newRel !== s.path) {
    s.path = rename.newRel
    changed = true
  }
  if (isMojibake(s.name || '')) {
    const meta = rename?.meta ?? parseScriptMeta(fs.readFileSync(path.join(ROOT, s.path), 'utf-8'))
    s.name = [meta.name, meta.version].filter(Boolean).join(' ') || path.basename(s.path, '.js')
    changed = true
    console.log(`[config] name -> ${s.name}`)
  }
}

if (changed) {
  if (DRY) {
    console.log('[dry] 配置未写入')
  } else {
    const tmp = CONFIG_PATH + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8')
    fs.renameSync(tmp, CONFIG_PATH)
    console.log('[config] music-sources.json 已更新')
  }
} else {
  console.log('[config] 无需修改')
}
console.log(DRY ? '[dry] 完成（未做任何改动）' : '完成。配置文件的 MD5 变化会触发运行中服务的懒重载。')

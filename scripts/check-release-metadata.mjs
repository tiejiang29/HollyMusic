/**
 * 发布元数据门禁：pnpm release:check（CI 的 check job 也会跑一遍）
 *
 * 存在的理由很具体：package.json 从 v2.1.2 起没再动过，而 main 已经往前 123 个提交，
 * 于是那几天部署 NAS 只能靠 docker exec + grep 字面量来判断容器里是新代码还是旧代码
 * —— 镜像里 /api/version 报的版本号本身是错的。这里把「版本号可信」重新变成一件有保障的事。
 *
 * 一次报完所有问题，不是碰到第一个就退：改这一类东西时人想知道的是全貌。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  findPackageParityIssues,
  findToolchainIssues,
  findVersionIssues,
  listReleaseTags,
  parseVersion,
  pnpmVersionFromPackageManager,
} from './release-utils.mjs'

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

const git = (args) => execFileSync('git', args, { encoding: 'utf8' })

function gitLines(args) {
  try {
    return git(args).split('\n').map((line) => line.trim()).filter(Boolean)
  } catch (error) {
    // 浅克隆、不在 git 仓库里、git 缺失都走这里；不静当通过，由下面的 notes 说清楚
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

const root = readJson('package.json')
const frontend = readJson('frontend/package.json')
const dockerfile = readFileSync('Dockerfile', 'utf8')
const ciYml = readFileSync('.github/workflows/ci.yml', 'utf8')

const merged = gitLines(['tag', '--merged', 'HEAD'])
const atHead = gitLines(['tag', '--points-at', 'HEAD'])
const notes = []
const releaseTags = []
let tagsAtHead = []

if (typeof merged === 'object' && !Array.isArray(merged)) {
  notes.push(`读不到「HEAD 可达的 tag」（${merged.error}）：版本倒退检查跳过`)
} else {
  releaseTags.push(...listReleaseTags(merged))
  if (!releaseTags.length) notes.push('HEAD 可达的正式版 tag 为空：CI 需要 fetch-depth: 0 + fetch-tags: true，本地需要 git fetch --tags')
}
if (typeof atHead === 'object' && !Array.isArray(atHead)) {
  notes.push(`读不到「HEAD 上的 tag」（${atHead.error}）：tag 与版本号一致性检查跳过`)
} else {
  tagsAtHead = atHead
}

const issues = [
  ...findPackageParityIssues(root, frontend),
  ...findToolchainIssues({ packageManager: root.packageManager, dockerfile, ciYml }),
  ...findVersionIssues({ version: root.version, releaseTags, tagsAtHead }),
]

if (issues.length) {
  // 一次报完，且不给 Node 断言堆栈：CI 日志里读的人要的是"哪几处、为什么"
  process.stderr.write(`发布元数据不一致，共 ${issues.length} 处：\n`)
  for (const [index, issue] of issues.entries()) process.stderr.write(`  ${index + 1}. ${issue}\n`)
  for (const note of notes) process.stderr.write(`· ${note}\n`)
  process.exit(1)
}

const nodeMajor = /^\s*node-version:\s*['"]?(\d+)/m.exec(ciYml)?.[1] ?? '?'
process.stdout.write(`发布元数据一致：${parseVersion(root.version).version}（pnpm@${pnpmVersionFromPackageManager(root.packageManager)} · node ${nodeMajor} · 最新已发布 tag ${releaseTags.at(-1) ?? '无'}）\n`)
for (const note of notes) process.stdout.write(`· ${note}\n`)

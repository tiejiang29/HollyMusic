/**
 * 发布准备：pnpm release:prepare 2.1.3
 *
 * 只做一件事 —— 把两处 version 抬到目标，并保证这一步踩不到已发布的东西。
 * 刻意不生成 docs/releases/*.md、不动 CHANGELOG：我们的发布说明由 docker-publish.yml
 * 里的 git-cliff 在 tag 之后生成（本地也没装 git-cliff），在这儿再生成一份只是
 * 多出第二个真相源。
 *
 * 为什么要在打 tag 之前本地 bump：docker-publish.yml 末尾那步「Sync package.json
 * version」是 bot 直推 main，会被分支保护挡掉（它自己的注释都写了"预期内"）——
 * 把版本号寄托在一个经常被拒的回写上，正是它停在 2.1.2 的原因。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { compareTag, listReleaseTags, parseVersion } from './release-utils.mjs'

// 人面向的脚本不该甩 Node 的断言堆栈：每条失败都直接说清「为什么」再退 1
function fail(message) {
  process.stderr.write(`发布准备失败：${message}\n`)
  process.exit(1)
}

const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim()
  } catch (error) {
    fail(`git ${args.join(' ')} 执行失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

const input = (process.argv[2] ?? '').trim()
if (!input) fail('缺少版本号参数，用法：pnpm release:prepare 2.1.3')

let target
try {
  target = parseVersion(input)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

if (git('status', '--porcelain') !== '') {
  fail('工作区不干净。它会改两个 package.json，混进在做的改动里就分不清了；请先提交或把改动挪开')
}

// 本地 tag 查一遍、远端再查一遍：我们本地和远端的 tag 是分叉的，只看一边会漏。
// ls-remote 只取引用列表，绝不打印远端 URL（历史里嵌过令牌）。
if (spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/tags/${target.tag}`]).status === 0) {
  fail(`${target.tag} 已存在于本地；已发布的版本不许重写`)
}
let remoteRefs
try {
  remoteRefs = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${target.tag}`], { encoding: 'utf8' })
} catch (error) {
  fail(`无法确认远端是否已有 ${target.tag}：${error instanceof Error ? error.message : String(error)}；请确认 origin 可达后重试`)
}
if (remoteRefs.trim() !== '') fail(`${target.tag} 已存在于 origin；已发布的版本不许重写`)

const root = JSON.parse(readFileSync('package.json', 'utf8'))
const frontend = JSON.parse(readFileSync('frontend/package.json', 'utf8'))
const releaseTags = listReleaseTags(git('tag', '--merged', 'HEAD').split('\n'))
const newestTag = releaseTags.at(-1) ?? null

// 基准取「当前 version」与「已发布最高正式 tag」的较大者，低于它一律拒。
// 之前只拦"撞上或高于已有 tag"，于是 v3.0.0 已发布时 prepare 2.9.9 能过——那不该过：
// 发一个比已发布版本更低的号，Docker 的 :latest 与 semver tag 都会语义倒挂。
const baseline = newestTag && compareTag(newestTag, `v${root.version}`) > 0 ? newestTag : `v${root.version}`
if (compareTag(target.tag, baseline) <= 0) {
  fail(
    `版本必须高于 ${baseline}（package.json 当前值与已发布最高 tag 的较大者），收到 ${target.tag}` +
      (newestTag ? `；已发布最高是 ${newestTag}` : ''),
  )
}

for (const [path, pkg] of [['package.json', root], ['frontend/package.json', frontend]]) {
  pkg.version = target.version
  // 2 空格缩进 + 结尾换行，和 CI 那段回写、和 pnpm 自己的写法一致
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
}

process.stdout.write(
  `已把根与 frontend 的 package.json 版本抬到 ${target.version}。\n` +
  `下一步：\n` +
  `  1. git diff 复核这两个文件\n` +
  `  2. git commit -m "chore(release): 准备 ${target.tag}"\n` +
  `  3. 推 main 需单独确认，只推分支，绝不 --tags / --force；等 CI 绿\n` +
  `  4. CI 绿后再给那个提交打 ${target.tag} —— 推 tag 同样要单独确认\n` +
  `  5. 出镜像后部署判据改看 /api/version 是否等于 ${target.version}\n`,
)

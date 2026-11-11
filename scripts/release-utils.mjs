/**
 * 发布元数据的纯函数层：解析 tag、比较优先级、列出三类必须一致的断言。
 * 这里不读文件也不跑 git —— 那样单测得搭一个临时仓库，而真正容易写错的就是这几个比较。
 */

// semver 的三段：0 或无前导零的正整数。带前导零（v2.01.3）不当合法版本处理。
const NUMERIC = '0|[1-9]\\d*'
const TAG_RE = new RegExp(`^v(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$`)

/**
 * 拆开一个 tag（或 package.json 的 version，允许不带前导 v）。
 * 主/次/补丁必须是纯数字且段前导零不合法，否则后面的数值比较会变成字典序比较。
 */
export function parseVersion(input) {
  const text = typeof input === 'string' ? input.trim() : ''
  const core = text.startsWith('v') ? text.slice(1) : text
  const match = TAG_RE.exec(`v${core}`)
  if (!match) throw new Error(`版本号格式非法：${text || '（空）'}，应形如 2.1.3 或 v2.1.3-beta.1`)
  return { tag: `v${core}`, version: core, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? '' }
}

/**
 * 纯数字段与字母数字段的优先级不同：数字段比数值且低于同位的字母段，
 * 全部相等时段少的一方在前（beta.2 < beta.10 < beta.10.a）。
 */
function comparePrerelease(a, b) {
  if (a === b) return 0
  if (a === '') return 1
  if (b === '') return -1
  const left = a.split('.')
  const right = b.split('.')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i]
    const y = right[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const numericX = /^\d+$/.test(x)
    const numericY = /^\d+$/.test(y)
    if (numericX && numericY) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1
      continue
    }
    if (numericX !== numericY) return numericX ? -1 : 1
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** 返回 -1 / 0 / 1。主>次>补丁为纯数值比较，同号时正式版高于任何预发布。 */
export function compareTag(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (x.major !== y.major) return x.major > y.major ? 1 : -1
  if (x.minor !== y.minor) return x.minor > y.minor ? 1 : -1
  if (x.patch !== y.patch) return x.patch > y.patch ? 1 : -1
  return comparePrerelease(x.pre, y.pre)
}

/**
 * 只认正式版（v2.1.3，带 - 的预发布不收）。
 * 这是 check 里「package.json 不许落后于已发布 tag」和 prepare 里取上一版的基准；
 * 预发布不参与，否则 beta 会挡住正式版判断。
 */
export function listReleaseTags(tags) {
  const release = []
  for (const tag of tags) {
    const text = typeof tag === 'string' ? tag.trim() : ''
    if (!text || !TAG_RE.test(text) || text.includes('-')) continue
    release.push(text)
  }
  return [...new Set(release)].sort(compareTag)
}

/** 在升序正式版数组里找 target 的前后邻居；pre 用于「必须递增」判断，next 用来提醒版本号跳跃。 */
export function mergeTagNeighbours(sortedReleaseTags, target) {
  let previous = null
  let next = null
  for (const tag of sortedReleaseTags) {
    const cmp = compareTag(tag, target)
    if (cmp < 0) previous = tag
    else if (cmp > 0 && next === null) next = tag
  }
  return { previous, next }
}

/** packageManager 形如 pnpm@10.22.0+sha512... → 10.22.0 */
export function pnpmVersionFromPackageManager(value) {
  const match = /^pnpm@(\d+\.\d+\.\d+)/.exec(String(value ?? '').trim())
  if (!match) throw new Error(`packageManager 无法解析：${value ?? '（缺）'}，应形如 pnpm@10.22.0`)
  return match[1]
}

/**
 * 前后端两份 package.json 必须逐项一致的字段。
 * 刻意不含 @types/react（根 ^19.2.18 / 前端 ^19）与 dayjs、qs、tailwind-merge 那几个范围——
 * 那些是各自安装、不会造成运行时错版的噪声，写进闸门只会让 CI 常红。
 */
export function findPackageParityIssues(rootPkg, frontendPkg) {
  const issues = []
  if (rootPkg.version !== frontendPkg.version) {
    issues.push(`version 必须一致：根 ${rootPkg.version ?? '（缺）'}，前端 ${frontendPkg.version ?? '（缺）'}（SPA 侧栏读的是根 package.json，两份各报各的没有意义）`)
  }
  // 两边都写成 undefined 也算问题：undefined === undefined 会让"整块字段没了"静静通过
  const compare = (label, rootValue, frontValue) => {
    if (rootValue === undefined || frontValue === undefined) {
      issues.push(`${label} 缺失：根 ${rootValue ?? '（缺）'}，前端 ${frontValue ?? '（缺）'}`)
    } else if (rootValue !== frontValue) {
      issues.push(`${label} 必须一致：根 ${rootValue}，前端 ${frontValue}`)
    }
  }
  for (const name of ['react', 'react-dom']) {
    compare(name, rootPkg.dependencies?.[name], frontendPkg.dependencies?.[name])
  }
  for (const name of ['vitest', 'typescript']) {
    compare(name, rootPkg.devDependencies?.[name], frontendPkg.devDependencies?.[name])
  }
  return issues
}

/**
 * 构建工具链三处一致：本地 pnpm 由 packageManager 决定、CI 由 pnpm/action-setup 读同一个字段，
 * 只有 Docker 那一段是自己 npm install 的 —— 不钉死就可能装到 pnpm 11 再 --frozen-lockfile，
 * 那是最坏的一种失败：只有出镜像时炸，CI 全绿。
 */
export function findToolchainIssues({ packageManager, dockerfile, ciYml }) {
  const issues = []
  let declared
  try {
    declared = pnpmVersionFromPackageManager(packageManager)
  } catch (error) {
    issues.push(error.message)
  }
  if (declared) {
    const match = /npm install -g pnpm@([^\s"']+|)/.exec(dockerfile)
    if (!match) issues.push('Dockerfile 未匹配到 `npm install -g pnpm@<版本>`（不能裸装 pnpm：镜像里装的版本会随时间漂）')
    else if (match[1] !== declared) issues.push(`Dockerfile 里的 pnpm@${match[1] || '（未钉版本）'} 必须等于 packageManager 的 pnpm@${declared}`)
  }
  const nodeMajors = [...dockerfile.matchAll(/FROM node:(\d+)-/gm)].map((match) => match[1])
  if (!nodeMajors.length) issues.push('Dockerfile 未匹配到 `FROM node:<主版本>-`')
  const ciNode = /^\s*node-version:\s*['"]?(\d+)/m.exec(ciYml)
  if (!ciNode) issues.push('ci.yml 未匹配到 `node-version: <主版本>`')
  if (nodeMajors.length && ciNode) {
    for (const major of new Set(nodeMajors)) {
      if (major !== ciNode[1]) issues.push(`Dockerfile 用 Node ${major}、CI 用 Node ${ciNode[1]}，必须一致`)
    }
  }
  return issues
}

/** 版本号与 git tag 的一致性：package.json 不许落后于已发布的 tag，HEAD 上若正好有 tag 则必须同号。 */
export function findVersionIssues({ version, releaseTags, tagsAtHead }) {
  const issues = []
  let current
  try {
    current = parseVersion(version)
  } catch (error) {
    issues.push(error.message)
    return issues
  }
  if (releaseTags.length) {
    const newest = releaseTags.at(-1)
    if (compareTag(newest, current.tag) > 0) {
      issues.push(`package.json 是 ${current.version}，但已发布的 tag 里最新是 ${newest}：版本号不能倒退，否则镜像里 /api/version 报的是旧版本`)
    }
  }
  for (const tag of tagsAtHead) {
    if (!TAG_RE.test(tag)) continue
    if (compareTag(tag, current.tag) !== 0) issues.push(`HEAD 上的 tag ${tag} 与 package.json 的 ${current.version} 不一致：发版前先 pnpm release:prepare`)
  }
  return issues
}

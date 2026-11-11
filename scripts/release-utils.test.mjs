import { describe, expect, it } from 'vitest'
import {
  compareTag,
  findPackageParityIssues,
  findToolchainIssues,
  findVersionIssues,
  listReleaseTags,
  parseVersion,
  pnpmVersionFromPackageManager,
} from './release-utils.mjs'

const ROOT = {
  version: '2.1.3',
  dependencies: { next: '16.3.1', react: '19.2.8', 'react-dom': '19.2.8' },
  devDependencies: { 'eslint-config-next': '16.3.1', typescript: '^5', vitest: '^3.2.7' },
}
const FRONTEND = {
  version: '2.1.3',
  dependencies: { react: '19.2.8', 'react-dom': '19.2.8' },
  devDependencies: { typescript: '^5', vitest: '^3.2.7' },
}
const DOCKERFILE = 'FROM node:20-bookworm-slim AS deps\nRUN npm install -g pnpm@10.22.0\nFROM node:20-alpine AS x\n'
const CI_YML = 'name: CI\n    - uses: actions/setup-node@v5\n      with:\n          node-version: 20\n'

describe('版本号解析与优先级', () => {
  it('接受带 v 与不带 v 两种写法，并给出 tag 与 version', () => {
    expect(parseVersion('2.1.3')).toMatchObject({ tag: 'v2.1.3', version: '2.1.3', major: 2, minor: 1, patch: 3, pre: '' })
    expect(parseVersion('v2.1.3-beta.10')).toMatchObject({ tag: 'v2.1.3-beta.10', version: '2.1.3-beta.10', pre: 'beta.10' })
  })

  it('拒绝非三段、前导零与垃圾输入', () => {
    for (const bad of ['', '  ', 'v2.1', 'v2.1.3.4', 'v2.01.3', 'v2.1.x', 'banana']) {
      expect(() => parseVersion(bad), bad).toThrowError(/版本号格式非法/)
    }
  })

  it('主/次/补丁按数值比较，不是字典序', () => {
    expect(compareTag('v2.1.10', 'v2.1.9')).toBe(1)
    expect(compareTag('v2.2.0', 'v2.10.0')).toBe(-1)
    expect(compareTag('v10.0.0', 'v9.9.9')).toBe(1)
  })

  it('正式版高于同号预发布，预发布按 semver 排', () => {
    expect(compareTag('v2.1.3', 'v2.1.3-beta.1')).toBe(1)
    expect(compareTag('v2.1.3-beta.2', 'v2.1.3-beta.10')).toBe(-1)
    expect(compareTag('v2.1.3-beta', 'v2.1.3-beta.1')).toBe(-1)
    expect(compareTag('v2.1.3-alpha.1', 'v2.1.3-beta.1')).toBe(-1)
  })
})

describe('正式版 tag 清单', () => {
  it('剔除预发布、空行、重复与垃圾', () => {
    const tags = ['v2.1.3', '', '  ', 'v2.1.0', 'v2.1.3', 'v2.1.3-beta.2', 'not-a-tag', 'v0.9.9']
    expect(listReleaseTags(tags)).toEqual(['v0.9.9', 'v2.1.0', 'v2.1.3'])
  })

  it('全是垃圾或为空时给空数组（调用方据此提示，而不是误判通过）', () => {
    expect(listReleaseTags([])).toEqual([])
    expect(listReleaseTags(['v2.1', 'v2.1.3-beta.1'])).toEqual([])
  })
})

describe('前后端 package.json 一致性', () => {
  it('对齐时没有问题', () => {
    expect(findPackageParityIssues(ROOT, FRONTEND)).toEqual([])
  })

  it('版本号、react、vitest 各自漂移都能被点名', () => {
    const issues = findPackageParityIssues(ROOT, {
      ...FRONTEND,
      version: '0.1.0',
      dependencies: { ...FRONTEND.dependencies, react: '19.2.7' },
      devDependencies: { ...FRONTEND.devDependencies, vitest: '^3.2.4' },
    })
    expect(issues).toHaveLength(3)
    expect(issues.join('\n')).toContain('version 必须一致：根 2.1.3，前端 0.1.0')
    expect(issues.join('\n')).toContain('react 必须一致：根 19.2.8，前端 19.2.7')
    expect(issues.join('\n')).toContain('vitest 必须一致：根 ^3.2.7，前端 ^3.2.4')
  })

  it('字段整块缺失要报错，不能和 undefined 互相抵消', () => {
    expect(findPackageParityIssues(ROOT, {})).toEqual(
      expect.arrayContaining([expect.stringContaining('（缺）')]),
    )
    expect(findPackageParityIssues({ version: '1.0.0' }, { version: '1.0.0' })).toHaveLength(4)
  })

  it('刻意不管 @types/react 这类各自安装的范围（根 ^19.2.18 / 前端 ^19 是有意不同）', () => {
    expect(findPackageParityIssues(
      { ...ROOT, devDependencies: { ...ROOT.devDependencies, '@types/react': '^19.2.18' } },
      { ...FRONTEND, devDependencies: { ...FRONTEND.devDependencies, '@types/react': '^19' } },
    )).toEqual([])
  })
})

describe('构建工具链一致性', () => {
  it('pnpm 钉死且 Node 主版本一致时通过', () => {
    expect(findToolchainIssues({ packageManager: 'pnpm@10.22.0+sha512.abc', dockerfile: DOCKERFILE, ciYml: CI_YML })).toEqual([])
  })

  it('Docker 裸装 pnpm 会被拒（装到什么版本取决于构建那天）', () => {
    const issues = findToolchainIssues({
      packageManager: 'pnpm@10.22.0',
      dockerfile: 'FROM node:20-bookworm-slim AS deps\nRUN npm install -g pnpm\n',
      ciYml: CI_YML,
    })
    expect(issues.join('\n')).toMatch(/未钉版本|未匹配到/)
  })

  it('pnpm 钉了但钉错，不会因为前缀相同而蒙混过关', () => {
    const issues = findToolchainIssues({
      packageManager: 'pnpm@10.22.0',
      dockerfile: 'FROM node:20-bookworm-slim\nRUN npm install -g pnpm@10.2\n',
      ciYml: CI_YML,
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('pnpm@10.2 必须等于 packageManager 的 pnpm@10.22.0')
  })

  it('Node 主版本不一致会被点名；Dockerfile 里没有 FROM node: 也算问题', () => {
    expect(findToolchainIssues({ packageManager: 'pnpm@10.22.0', dockerfile: 'FROM node:22-bookworm-slim\nRUN npm install -g pnpm@10.22.0\n', ciYml: CI_YML }).join('\n'))
      .toContain('Dockerfile 用 Node 22、CI 用 Node 20')
    expect(findToolchainIssues({ packageManager: 'pnpm@10.22.0', dockerfile: 'FROM debian:bookworm-slim\nRUN npm install -g pnpm@10.22.0\n', ciYml: CI_YML }).join('\n'))
      .toContain('未匹配到 `FROM node:')
  })

  it('CI 里找不到 node-version 也算问题，不能默认放行', () => {
    expect(findToolchainIssues({ packageManager: 'pnpm@10.22.0', dockerfile: DOCKERFILE, ciYml: 'name: CI\n' }).join('\n'))
      .toContain('ci.yml 未匹配到')
  })

  it('packageManager 缺失或不是 pnpm 直接抛（抛错比默默跳过可信）', () => {
    expect(() => pnpmVersionFromPackageManager(undefined)).toThrowError(/packageManager 无法解析/)
    expect(() => pnpmVersionFromPackageManager('yarn@3.0.0')).toThrowError(/packageManager 无法解析/)
    expect(pnpmVersionFromPackageManager('pnpm@10.22.0+sha512.abc')).toBe('10.22.0')
  })
})

describe('版本号与 tag 的一致性', () => {
  it('版本号落在已发布 tag 之内时通过（main 领先最后一个 tag 是常态）', () => {
    expect(findVersionIssues({ version: '2.1.2', releaseTags: ['v2.1.2'], tagsAtHead: [] })).toEqual([])
    expect(findVersionIssues({ version: '2.1.3', releaseTags: ['v2.1.2'], tagsAtHead: [] })).toEqual([])
  })

  it('package.json 落后于已发布 tag 时报错', () => {
    expect(findVersionIssues({ version: '2.1.2', releaseTags: ['v2.1.2', 'v2.2.0'], tagsAtHead: [] }).join('\n'))
      .toContain('版本号不能倒退')
  })

  it('HEAD 上正好有 tag 但号不一致时报错', () => {
    expect(findVersionIssues({ version: '2.1.2', releaseTags: ['v2.1.2'], tagsAtHead: ['v2.1.3'] }).join('\n'))
      .toContain('HEAD 上的 tag v2.1.3 与 package.json 的 2.1.2 不一致')
    expect(findVersionIssues({ version: '2.1.3', releaseTags: ['v2.1.2'], tagsAtHead: ['v2.1.3'] })).toEqual([])
  })

  it('一个可见 tag 都没有时不报错，但也不谎称通过（由 check 脚本报提示）', () => {
    expect(findVersionIssues({ version: '2.1.2', releaseTags: [], tagsAtHead: [] })).toEqual([])
  })

  it('package.json 里是垃圾版本号时报错', () => {
    expect(findVersionIssues({ version: 'v2.1', releaseTags: [], tagsAtHead: [] }).join('\n'))
      .toContain('版本号格式非法')
  })
})

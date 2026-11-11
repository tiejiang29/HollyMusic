# 发布流程

这份文档说明两个脚本各自管什么，以及为什么它们长这个样子。

## 为什么要这两个脚本

`package.json` 的 version 停在 `2.1.2`，而 `main` 已经往前 123 个提交，中间有两次 NAS 部署。
后果不是"难看"：`lib/version.ts` 把根 `package.json` 的 version 内联成 `APP_VERSION`，
`/api/version` 和 SPA 侧栏的 `v{APP_VERSION}` 都读它，于是**镜像里自报的版本号是错的**。
那两次部署我只能用 `docker exec` 进容器 grep 代码字面量来判断"新代码到底在不在"。

版本号本身在旧流程里是由 `docker-publish.yml` 末尾那步 bot 回写的，但它是直推 `main`，
会被分支保护挡掉（那个 step 自己的注释就写了"预期内"）——**依赖一个经常被拒的回写，
版本号必然长期不动**。所以改成：**打 tag 之前在本地把版本号抬好**，CI 只负责生成发布说明。

## pnpm release:check —— 门禁（CI 每次跑）

`scripts/check-release-metadata.mjs`，一次报完所有不一致，不是碰到第一个就退。

| 断言 | 现在的值 | 为什么要管 |
|------|----------|-----------|
| 根与 `frontend/package.json` 的 version 一致 | 都是 `2.1.2` | SPA 侧栏读的是根那一份，前端自己那份 `0.1.0` 只是历史遗留 |
| `react` / `react-dom` 前后端一致 | `19.2.8` | 两份安装树错版会直接导致 hooks 失效 |
| `vitest` / `typescript` 前后端一致 | `^3.2.7` / `^5` | 测试与类型口径 |
| Dockerfile 的 `npm install -g pnpm@X` == `packageManager` | `pnpm@10.22.0` | 裸装 pnpm 会装到构建那天最新的；CI 用 pnpm 10，镜像装到 11 就在 `--frozen-lockfile` 上炸——CI 全绿、只有出镜像时红 |
| Dockerfile 的 `FROM node:N` == ci.yml 的 `node-version: N` | `20` | 构建环境与门禁环境不一致 |
| version 不落后于 HEAD 可达的最高正式 tag | `2.1.2` vs `v2.1.2` | 版本号倒退等于镜像自报旧版本 |
| HEAD 上若有 tag，必须与 version 同号 | 当前 HEAD 无 tag | 防"打了 tag 但忘了 bump" |

刻意**不管**的：`@types/react`（根 `^19.2.18`、前端 `^19`）、`dayjs`/`qs`/`tailwind-merge`/
`react-use` 那几个范围、`engines`（我们没有 `.node-version`，本地实测 Node 22）。闸门只放
"错了会炸"的不变量，放一堆现状就不红了。

tag 相关断言需要能看到 tag：CI 的 checkout 因此带 `fetch-depth: 0` + `fetch-tags: true`；
本地跑之前先 `git fetch origin --tags`。看不到 tag 时脚本会打印一行说明而不是假装通过。

## pnpm release:prepare 2.1.3 —— 准备（只在本地跑）

`scripts/prepare-release.mjs` 依次检查，全过才动文件：

1. 参数必须像 `2.1.3` / `v2.1.3-beta.1`（semver，主/次/补丁纯数字、不许前导零）。
2. 工作区必须干净——它会改两个 `package.json`，混进在做的改动里就分不清了。
3. `vX` 不许已存在于**本地**，也不许存在于 **origin**（`ls-remote --tags`，只取引用列表）。
   我们本地和远端的 tag 是分叉的，只看一边会漏。已发布的版本不许重写。
4. 版本必须严格高于基准，基准取「当前 version」与「HEAD 可达最高正式 tag」的较大者。
5. 若目标夹在两个已有 tag 中间，还要低于它的后继 tag——那是 tag 分叉的现场信号，宁可不发。

然后同时写根与 `frontend/package.json` 的 version（2 空格缩进 + 结尾换行，和 CI 那段回写
同一个写法），并打印后续步骤。

它**不**生成 `docs/releases/vX.md`、**不**改 `CHANGELOG.md`：发布说明由 `docker-publish.yml`
里的 git-cliff 在 tag 之后生成（本地也没装 git-cliff），在这儿再生成一份只是多一个真相源。

## 一次发布的动作

```bash
git fetch origin --tags
pnpm release:check                 # 必须绿
pnpm release:prepare 2.1.3         # 只改两个 package.json
git diff                            # 人工复核
git commit -am "chore(release): 准备 v2.1.3"
# 推 main 需要单独确认；只推分支，绝不 --tags / --force
git push origin main
# 等 CI 绿（pnpm release:check 也在里面）
git tag -a v2.1.3 -m "v2.1.3"
# 推 tag 会触发镜像发布 + GitHub Release，同样要单独确认
git push origin v2.1.3
```

部署判据因此变简单：容器起来后 `GET /api/version` 应返回 `2.1.3`。
**限制也说清楚**：未打 tag 的 main 镜像仍然报上一个版本号——这条改动只让"版本号可信"
变成有保证的事，不改变"我们目前只在发版时打 tag"这个事实。

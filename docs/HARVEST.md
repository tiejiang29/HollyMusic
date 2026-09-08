# 歌单自采与跨机推送

把各音乐平台歌单广场的曲目批量采进 HollyMusic 曲库。支持两种形态：

- **单机**：本机采、本机入库（脚本调本机 discover 接口，详情解析过程自动入库）
- **两段式（推荐）**：本机采集导出 JSON → 推送到服务器入库。采集打上游平台，家用宽带 IP 比机房 IP 更不容易被限流；入库打自己的服务器，两者网络路径分离，互不拖累

## 前置

- 服务端已启动（本机 dev 或生产实例），脚本全部走 HTTP，不直连数据库
- `HOLLY_PASSWORD` 环境变量：目标实例 `admin` 的密码（discover 接口需登录，导入接口需 admin）
- Node 20+（登录时依赖 `res.headers.getSetCookie()` 收全会话 cookie）

## 单机采集（采完即入库）

```bash
HOLLY_PASSWORD=xxx pnpm harvest -- --sources=tx,wy --tags=流行,摇滚 --per-tag=20
```

采集原理：遍历平台类目树 → 列歌单 → 逐个拉详情。详情接口内部会经
`enrichMusicInfos`（lib/services/discovery-service.ts）把曲目 upsert 入库，
所以采完曲目就带着可播放的 songmid 落库了，无需额外步骤。

## 两段式：本机采集 → 推送服务器

### 第 1 步：本机采集并导出

```bash
HOLLY_PASSWORD=xxx pnpm harvest -- --out=data/harvest-2026-09-08.json
```

`--out` 模式下曲目不写推荐白名单，而是导出为 JSON（裸 MusicInfo 数组，
已按 `source-存储songmid` 去重）。注意：本机库仍会被详情接口顺带入库，
这是 discover 详情接口的内置行为，无法绕过；服务器库不受影响。

### 第 2 步：推送到服务器

```bash
HOLLY_PASSWORD=xxx pnpm harvest:push -- \
  --file=data/harvest-2026-09-08.json \
  --target=https://your-server.com
```

推送走 `POST /api/admin/music-info/import`（仅管理员），按批（默认 500 条，
服务端上限）分批入库，复用 checksum 去重与 `source_songmid` 复合唯一键，
**幂等**：重复推送同一文件，第二次全部 noop（未变），中断后重跑即可续传。

## 常用参数

### harvest（采集）

| 参数 | 说明 |
|---|---|
| `--sources=tx,wy` | 平台列表（默认全部 5 平台） |
| `--tags=流行,摇滚` | 指定类目名，自动反查平台内部 tag id；不传则遍历完整类目树 |
| `--per-tag=20` / `--pages=1` | 每类目歌单数 / 翻页数 |
| `--sort=hot` | recommend / hot / new / collect / soar |
| `--out=file.json` | 导出模式（见两段式） |
| `--recommend` | 采完把曲目写入本机 isRecommended 白名单（与 `--out` 互斥） |
| `--hot-tags-only` | 只用各平台 hotTag，不展开完整类目树 |
| `--resume` | 跳过 state 文件（data/harvest-state.json）里已采过的歌单 |
| `--delay=400` / `--concurrency=3` | 请求间隔与详情并发（防上游限流） |
| `--dry` | 只列计划不发请求 |

### harvest:push（推送）

| 参数 | 说明 |
|---|---|
| `--file=path.json` | 采集导出的 JSON（必填） |
| `--target=https://srv` | 目标服务器（默认 `HOLLY_TARGET` 或 127.0.0.1:3000） |
| `--recommend` | 入库后写入目标服务器推荐白名单，**慎用**（见下） |
| `--batch=500` | 每批条数（服务端上限 500） |
| `--dry` | 只校验文件格式，不发请求 |

环境变量：`HOLLY_TARGET`（目标）、`HOLLY_USERNAME`（默认 admin）、
`HOLLY_PASSWORD`（必填）。密码只经环境变量传入，不落任何文件。

## ⚠️ 推荐白名单的行为

`--recommend`（以及导入接口的 `recommend: true`）写入 `isRecommended` 白名单。
白名单一旦非空，`/api/random` 抽歌**完全锁进白名单**（全有或全无回退，
不会混合全库），会改变全站「发现」页的曲池。建议先纯采集扩充曲库，
人工确认质量后再单独决定是否写白名单。

## 相关代码

| 位置 | 职责 |
|---|---|
| `scripts/harvest-playlists.mjs` | 采集 + 导出 |
| `scripts/push-music-info.mjs` | 推送 |
| `app/api/admin/music-info/import/route.ts` | 批量导入接口（仅管理员，单批 ≤500） |
| `lib/db.ts` | `upsertMusicInfosInTransaction`（checksum 去重）、`getStorageSongmid`（kg 用 FileHash 作存储键） |

# HollyMusic 系统架构与接口文档

> 面向未接触过代码的读者：本文描述 HollyMusic 的整体架构、实现的功能、后端全部 API 路由、前端结构、数据模型与部署形态。
> 基于代码现状整理（2026-09-19，v2.1.0）。接口变更的增量记录见 `docs/ANDROID_API.md`，运维交接见 `HANDOFF.md`。

---

## 目录

1. [项目概览](#1-项目概览)
2. [技术栈与运行形态](#2-技术栈与运行形态)
3. [代码目录导览](#3-代码目录导览)
4. [后端架构](#4-后端架构)
5. [API 路由参考](#5-api-路由参考)
6. [前端架构](#6-前端架构)
7. [关键数据流：点播一首歌的全链路](#7-关键数据流点播一首歌的全链路)
8. [配置参考](#8-配置参考)
9. [数据模型](#9-数据模型)
10. [测试与质量保障](#10-测试与质量保障)
11. [部署](#11-部署)

---

## 1. 项目概览

HollyMusic 是一个**自部署的音乐聚合与播放服务**：通过「洛雪（LX）音源脚本」聚合多个音乐平台（QQ / 酷我 / 咪咕 / 网易 / 酷狗）的曲目元数据与播放地址，由**服务端统一代理音频流**，对外提供 Web SPA、Subsonic 兼容 API 与 Android 客户端三套消费端。

核心设计决策（理解整个系统的钥匙）：

| 决策 | 含义 |
|---|---|
| **服务端代理音频** | 客户端拿到的永远是 `/api/audio` 代理流，不直连音源 CDN。由此获得了 Range seek、磁盘缓存、多用户去重、边听边下入库、以及「假地址识别」的能力 |
| **音源可插拔** | 音源是洛雪脚本（JS），管理端可上传/订阅/启停/排序，运行在独立的 runner 子进程中，崩溃自动重启 |
| **元数据自建** | 搜索结果落本地 SQLite（MusicInfo 表），跨源去重（checksum），歌曲以 `uid = source-songmid` 复合 ID 引用 |
| **本地优先播放** | 音乐库（边听边下的永久正本）→ 磁盘缓存 → 在线解析，三级依次命中 |
| **Subsonic 兼容** | 实现 `/rest/*` 核心方法，第三方 Subsonic 客户端（如 Musiver）可直接接入 |

---

## 2. 技术栈与运行形态

### 2.1 技术栈

- **后端**：Next.js 16（App Router，仅 API 路由，`output: standalone`）+ TypeScript + Prisma ORM + SQLite
- **前端**：Vite 6 + React 19 + react-router v7 + zustand + Tailwind CSS v4，PWA（Service Worker + manifest）
- **音频引擎**：前端原生 HTML5 Audio（非 Howler）；安卓端 Media3 ExoPlayer
- **测试**：vitest（后端 node 环境 + 前端 jsdom 两套配置）
- **部署**：Docker（nginx + Next standalone 双进程，supervisor 拉起）

### 2.2 运行拓扑

**开发态**（`pnpm dev:all`，两个进程）：

```
浏览器 ──► Vite dev server :5173（SPA + HMR）
              │ proxy /api、/rest（changeOrigin=false，保留原始 Host）
              ▼
         Next dev server :3000（API）
              ▼
         SQLite（data/music.db）+ 音频缓存（data/audio-cache/）+ 音乐库（data/library/）
```

**生产态**（Docker 容器，对外端口 3000，NAS 上映射为 3099）：

```
客户端 ──► nginx :3000
            ├── 静态文件：frontend/dist（SPA，/assets 一年强缓存，/sw.js、/manifest.json no-cache）
            │   try_files → /index.html（SPA fallback）
            └── /api、/rest 反代 ──► Next standalone :3001（纯 API，启动前先 prisma migrate deploy）
```

> 注意：**生产环境 SPA 由 nginx 服务，Next.js 不承担任何页面渲染**。`app/` 目录下只有 API 路由，没有页面路由。

**Android 客户端**：Kotlin + Media3 ExoPlayer，复用同一套 `/api/audio`、`/api/download` 接口（带登录 cookie），已拆分为独立仓库，本文不展开。

---

## 3. 代码目录导览

```
HollyMusic/
├─ app/                     # Next.js App Router —— 全部是 API 路由
│  ├─ api/                  # 83 个 route.ts（见第 5 节）
│  └─ rest/[method]/        # Subsonic 兼容层（单一入口分发 ~25 个方法）
├─ lib/                     # 后端核心逻辑（前端经 @ 别名直接复用其中一部分）
│  ├─ music-source-manager.ts   # 音源瀑布管理器（核心中的核心）
│  ├─ music-core/              # 洛雪脚本运行时：LXEnvironmentSimulator + runner 子进程
│  ├─ audio-serve.ts           # 音频流服务（磁盘缓存 + 流式代理 + 多用户去重）
│  ├─ server/                  # 服务端工具：audio-sniff / audio-integrity / credentials /
│  │                           #   url-guard(SSRF) / login-rate-limit / lyric-cache / download-utils
│  ├─ services/                # 业务服务：music-library / source-manager-service / tx|kw|mg-chain-service /
│  │                           #   album|artist-service / discovery / lyrics / cover / user-service /
│  │                           #   recommend-worker / cover-backfill / source-toggle / music-library
│  ├─ store/                   # zustand stores（前后端共用，前端为主）
│  ├─ api/                     # 前端 API 封装（23 个模块，统一走 lib/api/client.ts）
│  ├─ subsonic-*.ts            # Subsonic 协议层（流、搜索、元数据、收藏同步）
│  ├─ db.ts                    # Prisma 单例（globalThis 守卫，dev 热重载复用）
│  └─ config-sync.ts           # 启动时同步配置用户到 DB（instrumentation.ts 调用）
├─ components/              # React 组件（player / admin / shared / toast，前后端共用别名 @）
├─ hooks/                   # 前端 hooks（useAudioPlayer / useAuth / useDownload …）
├─ frontend/                # SPA 源码：src/routes（页面）、src/components（页面级组件）、
│  │                        #   src/hooks、index.html、vite.config.ts
│  └─ public → 仓库根 public/（PWA：sw.js / manifest.json / 图标）
├─ prisma/                  # schema.prisma + migrations/
├─ config/                  # music-sources.json（音源配置，运行时可写）
├─ custom-sources/          # 音源脚本存放目录
├─ scripts/                 # 运维脚本（harvest-playlists / push-music-info / lx-debug 调试工具）
├─ data/                    # 运行时数据：music.db、audio-cache/、library/、logs/
└─ Dockerfile / docker-compose.yml / nginx-spa.conf
```

---

## 4. 后端架构

### 4.1 分层

```
API 路由层（app/api/**）        —— 参数校验、鉴权、响应包装
    │
业务服务层（lib/services/**）   —— 歌单/收藏/历史/发现/专辑歌手链/音乐库/推荐任务
    │
音源管理层（lib/music-source-manager.ts）
    │   瀑布调度：按优先级遍历音源 × 音质，拿到第一个非空地址
    ▼
脚本运行时（lib/music-core/）   —— LXEnvironmentSimulator 环境模拟 + runner 子进程 IPC
    │
音频服务层（lib/audio-serve.ts）—— 磁盘缓存 / Range / 流式代理 / 假地址嗅探 / 入库
    │
数据层（lib/db.ts → Prisma/SQLite）
```

### 4.2 音源系统（核心）

**音源脚本**：一个音源 = 一个洛雪 JS 脚本，声明自己支持的平台（kw/tx/mg/wy/kg）、音质（128k/320k/flac/flac24bit）和 actions（musicUrl/getLyric/getPic）。脚本运行在一个**常驻 runner 子进程**里，宿主通过 IPC 调用（`slot.create` / `slot.load` / `slot.call`），脚本崩溃由熔断器自动重启。

**音源配置** `config/music-sources.json`，每条：`path`（脚本路径）、`name`、`pt`（平台白名单）、`enabled`、`priority`（数字越小越先被尝试）。管理端的启停/排序修改会**原子写回这个文件**（临时文件 + rename）并触发运行时热重载（配置 MD5 变化 → 重建音源实例）。订阅源（subscription）支持在线 URL 自动更新脚本。

**解析瀑布**（`_getMusicUrlSamePlatform`）：

1. 按 `priority` 升序遍历启用音源；
2. 逐源过滤：`pt` 白名单 → 脚本声明的平台 → musicUrl action → 脚本声明的音质 → 歌曲元数据里该音质存在；
3. 取址有三级时间预算夹住：单次调用 15s、同一源在一首歌上累计 8s、整条瀑布 18s（详见下面的"取址预算"）；
   剩余预算不足 250ms 时不再发起下一次调用（"尘埃调用"救不回歌，却会白占一个 runner slot）；
4. 拿到地址后过 SSRF 检查（拒绝私网地址），**返回 `{ url, provider }`**——provider 供下游「假地址换源重试」排除用；
5. 同平台全失败 → 跨平台换源：按「歌名 + 歌手 + 时长 ±4s」在其他平台找同款（结果缓存：命中 10 分钟 / 未命中 60 秒，防抖）。

**假地址拦截与换源重试**（2026-09 新增，见 `lib/server/audio-sniff.ts`）：

部分音源对无版权/VIP 歌曲会返回 HTTP 200 的 HTML/JSON 错误页甚至垃圾数据。audio-serve 在**下载首块时**做载荷判定：

- `reject`（确定非音频）：Content-Type 是 text/html/json/xml，或首字节是 `<`/`{`/`[`，或命中图片/压缩包魔数 → **把该音源加入排除集重新走瀑布**（上限 `AUDIO_FAKE_URL_RETRIES`，默认 2 次）。上游返回非 2xx 同样触发换源重试。关键时序：嗅探发生在客户端响应构造之前，**换源对播放器完全无感知**。
- `unverified`（未知容器）：正常交付、进缓存，但**不进永久音乐库**（见 4.3）。
- 判据以字节魔数为主、Content-Type 为辅（音源的 Content-Type 普遍不可信）。

**取址预算与健康度账本**（2026-09 新增）：瀑布的三级预算必须自洽——单次调用（默认 15s）
≤ 单源累计（8s）< 整条瀑布总预算（18s）**< 外层 audio-serve 的解析等待（20s）**。最后这条
关系是关键：总预算一旦超过外层，外层先返回 503/502，客户端永远看不到"瀑布试完了"的结论
（实测一个挂起的头源就能让整首歌必然失败，后面的可用源一次都轮不到）。单源预算用尽即换下
一个源，不再终止整条瀑布；三个值均可 env 覆盖（`SOURCE_URL_*`）。另外剩余预算不足
`MIN_USEFUL_ATTEMPT_MS`（250ms）时不再发起调用——给一次只剩 0-2ms 的"尘埃调用"既不可能出货，
又会把一次真实脚本调用丢进 runner（promise 被放弃，slot 却还占着）。

同时新增**内存健康账本** `lib/server/source-health.ts`：按 `音源 × 平台` 记滑动窗（50 样本）
内的成/坏与耗时，随 `/api/health` 的 `sources[].health` 输出（`supported*` 是脚本自报的声明，
`health` 是真跑出来的实测）。三条护栏都是实测换来的：版权/能力不符不计坏、缓存与音乐库命中
不入账、本机网络故障期间（DNS/连不上）不记坏。

**3c：账本开始动作**（2026-09-19）。瀑布在取址前按 `源×平台` 查冷却状态，冷却中的源直接跳过
（priority 排序一律不动，也不自动改配置），冷却到期放**一次**半开探测（`claimProbe` 是租约式的，
60s 无人收账就自动释放，避免探测请求中途死掉把源永久锁住），探测失败按 2^n 翻倍、上限 30min。
一条硬护栏：**同一平台至少留一个候选源上场**——摸底实测 mg 只有两个源支持，全跳等于该平台无源可用。

冷却参数来自 `scripts/probe-source-matrix.js` 的全矩阵摸底（10 源 × pt × 每平台 2 首基准曲 = 62 格，
跑了两轮）：**跨歌连续 2 次坏 → 冷却；快速失败类 60s，挂起类（取址超时 / 字节段 stall 中断）5min**。
摸底的关键事实决定了这套参数形态——62 格里 **0 次取址超时**，坏样 p50 1031ms / max 2224ms，
而健康源取址 p50 0-1860ms、单次成功最大 4558ms。所以"坏"的主流是快速报错与死链，不是挂起，
熔断只看连续坏次数、**不按延迟分位数**（那会砍掉全场最慢但确实出货的 gdstudio，而它是 mg 唯二来源
之一）；`perSourceMs=8s` 保持在观测最大值之上，不要压。

注意账本天然只看得到"被轮到的源"：健康路径下 10 个源里通常只有 1-2 个有样本（实测面板上只有
1/31 格有数据），这正是周测（主动全矩阵探测）不可省略的原因。管理端「健康」列据此把三种状态分开：
`无实测`（没轮到）、`不测`（pt 不含该平台，不是坏）、`冷却中 Ns / 冷却中·试探`（3c 正在跳它）。

**周测（3c 的先验来源，2026-09-19 新增）**：`lib/services/source-probe.ts`。启动后每 7 天（或面板
「立即周测」手动）把「启用源 × pt × 每平台 2 首基准曲」全矩阵跑一遍，结果写 `SourceProbeResult`
（append）+ `SourceProbeRun`（批次元数据与样本快照）。三件事值得知道：

- **探测不写实时账本**。取址走 `musicSourceManager.probeSourceUrl`（单源、跳过瀑布、不记账），字节段
  在这里自己用 `judgeUpstreamPayload` 判。探测证据和真实用户证据必须分开，否则探测自身的抖动
  会被 3c 当成"用户遇到的坏"去熔断。
- **只取址不够**：每格都对地址发一次 `Range: bytes=0-65535`（经 `safePublicFetch` 逐跳 SSRF 校验）。
  摸底实测过"地址给了、Content-Type 谎称 audio/mpeg、真取是 404 + 64 字节文本"这一类。
- **先验只设冷却、不塞假样本**：`seedHealthFromProbe()` 把 TTL（9 天）内判坏的格子调
  `sourceHealth.seedCooldown()`（快速失败 60s / 挂起类 5min），到期照常放半开，一次真实成功即彻底
  解除——先验判错最多浪费一首歌。合并规则：一格两首样本里有一首出货就算这格可用；更新的一批覆盖旧批次。
- **必须由取址侧的模块实例启动，不能挂在 `instrumentation.ts`**：Next 给 instrumentation 单独一套
  lib 模块副本，从那边写内存账本路由侧读不到（dev 实测：先验日志说注入了 3 格，`/api/health` 始终
  `cooling:0`），且它那份 `musicSourceManager` 单例会再拉起一个 runner 子进程。现在的接法是
  `MusicSourceManager.initialize()` 末尾 `void this.wireSourceProbe()`（每进程一次）。

面板上「健康」与「周测」是两列，口径不同别混读：前者是真实用户身上发生了什么（重启清零），后者是
上次主动探测说了什么（落库跨重启）。

### 4.3 音频服务（lib/audio-serve.ts）

音频流服务的核心语义：

1. **三级命中**：本地音乐库（`serveFromLibrary`，uid 精确 → 跨平台模糊，库内音质 ≥ 请求档即服务）→ 磁盘缓存（DB 记录 + Range 读文件）→ 在线解析回源。
2. **多用户去重**：同一首歌并发请求合并为一个 in-flight entry，上游只打一次。
3. **跟随交付**：miss 时响应不等下载完成——body 流跟随磁盘写入进度发送（无 Range → 200 完整文件；Range → 206 完整区间），不按已下载字节数截断。
4. **磁盘缓存**：完整下载且校验通过才落库（audioCache 表），LRU 淘汰（默认配额 10GB）；试听片段（时长 < 期望 80% 且差值 > 30s）不落库，交付不受影响。
5. **超时体系**：URL 解析 20s / 上游 stall 30s（有数据进展即续期）/ seek 等待 15s（超时 503 + Retry-After）/ readiness 兜底 60s。
6. **边听边下入库**：完整缓存成功后，后台把文件移入 `data/library/`（歌手/专辑两级目录），登记 LibrarySong（去重键 = 归一化歌名|主歌手 + 时长 ±4s 同录音；更高音质到达时替换）。**入库前有容器嗅探门槛**：字节无法证明是已知音频容器的文件不进永久库（库优先于在线源且不可自愈，一旦登记坏文件，这首歌就永远播不了），只留在缓存里随 LRU 淘汰。

### 4.4 缓存体系一览

| 缓存 | 位置 | TTL / 容量 | 说明 |
|---|---|---|---|
| 音频磁盘缓存 | `data/audio-cache/` + audioCache 表 | 10GB LRU | 按 `${source}:${songmid}:${quality}` 键；命中 0 次上游调用 |
| 本地音乐库 | `data/library/` + LibrarySong 表 | 20GB 配额 | 永久正本，播放最高优先级 |
| searchCache（内存） | 进程内 | 分键不同：tx 专辑 1h / kw、mg 专辑 24h / discovery 10min / Subsonic 搜索 210min | 容量 2000，FIFO 淘汰 |
| urlCache（内存） | 进程内 | 210 分钟 | 仅 `/api/music-url` 使用 |
| 换源结果缓存 | 进程内 | 命中 10min / 未命中 60s，300 条 | 抑制同首歌密集重复搜索 |
| 歌词/封面缓存 | 进程内 | 1h / 10min | 歌词另有磁盘边车（.lrc 随音频缓存同目录） |
| 图片同源代理 | 内存 | 60min | `/api/image-proxy`，域名白名单 |

### 4.5 认证与安全

- **Web/App 会话**：签名 cookie（`holly_user` + `holly_sig`，HMAC，密钥 `AUTH_SECRET`）。`User.sessionVersion` 递增可踢掉其它设备；`mustChangePassword` 强制改密。
- **密码存储**：scrypt 哈希（`scrypt$N$r$p$salt$hash`，node:crypto 零依赖），登录时防用户名枚举（用户不存在也烧等价耗时）。存量明文密码在登录成功时惰性迁移。
- **Subsonic 凭据**：`User.subsonicSecret` 是每用户随机令牌（与登录密码解耦），客户端按 `t = md5(token + salt)` 校验。令牌唯一获取入口是管理端 `POST /api/admin/users/[id]/subsonic-token`（仅响应内显示一次）；改密时自动轮换。
- **登录限速**：IP + 用户名双维，5 分钟失败 10 次锁 15 分钟（进程内存态，管理端可解锁）。
- **SSRF 防护**：音源返回的播放地址过 `isTrustworthyUrl`（拒绝私网/非 http(s)）；订阅 URL 与图片代理走逐跳护栏 + 域名白名单。
- **权限**：管理端全部 `requireAdmin`；C 端 `requireUser`；公开接口仅登录/登出/health/version/share/封面/图片代理及 Subsonic 匿名读（受 `REQUIRE_AUTH` 开关控制）。
- **分享链接**：`/api/share?uid=` 生成自包含 SSR 播放页（og meta 供微信爬虫），签发 HMAC 的 `st` token（绑定 uid+quality+时效）供匿名播放，不需登录。

### 4.6 后台任务

- **封面回填**（cover-backfill）：进程内定时器（启动 15s 后首跑，之后每 6h），补齐历史歌曲的封面，幂等。
- **推荐任务**（RecommendTask）：管理端创建 AI 推荐任务（建歌单/筛歌），进程内 worker 串行消费，进度写 `progressJson`，前端 2.5s 轮询；服务重启时把僵尸态任务标记 `interrupted`。API Key 只在创建请求里透传，不落库。

---

## 5. API 路由参考

### 5.0 约定

- **响应包装**（二进制接口除外）：成功 `{ success: true, data: T }`；失败 `{ success: false, error: { code, message } }`。
- **uid 格式**：全站统一 `${source}-${songmid}`（如 `tx-003xxxxx`）；封面 id 额外兼容 `al-`（专辑）/`ar-`（歌手）前缀。
- **鉴权标注**：`[admin]` 管理员 / `[user]` 登录用户 / `[opt]` 登录可选 / `[pub]` 公开。
- 常用错误码：`INVALID_PARAMS`、`QUALITY_NOT_SUPPORTED`、`ALL_SOURCES_FAILED`、`SEARCH_FAILED`、`UNAUTHORIZED` 等（全集见 `lib/api-response.ts`）。

### 5.1 播放与音频

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET/HEAD | `/api/audio?uid=&quality=` | **音频流主入口**：三级命中（库→缓存→回源），支持 Range，假地址自动换源 | opt（匿名仅放行分享 st token） |
| POST | `/api/music-url` | 获取播放直链（`{musicInfo, quality}`），带跨平台换源 toggle 信息 | user |
| GET | `/api/download?uid=&quality=` | 单曲下载（uid 模式，文件名后端组装） | user |
| POST | `/api/download` | url 模式下载兼容（`{url, filename?}`） | user |
| GET | `/api/download/batch?uids=&quality=` | 批量下载 ZIP（≤100 首，store 模式零压缩） | user |
| GET | `/api/random?size=30` | 从已入库曲目随机抽歌 | user |
| POST | `/api/recognize` | 听音识曲：body 为 PCM（Int16LE/48kHz/单声道/4~12s），返回前 3 候选 | user |

### 5.2 搜索与发现

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/api/search?source=&keyword=&page=&limit=` | 音乐搜索；`source=all` 五源并发汇聚，结果去重入库并附 uid | user |
| GET | `/api/search/suggest?keyword=` | 搜索联想（网易 + 本地库 + TX 专辑三路并行，1.2s 截断） | user |
| GET | `/api/search-sources` | 当前启用的搜索平台列表 | user |
| GET | `/api/discover/playlists` | 歌单广场（分页/标签/排序/关键词） | user |
| GET | `/api/discover/playlists/[id]` | 歌单详情 | user |
| GET | `/api/discover/playlists/groups` | 推荐歌单按类目跨平台聚合 | user |
| GET | `/api/discover/playlists/tags?source=` | 歌单广场标签 | user |
| GET | `/api/discover/toplists?source=&scope=` | 排行榜列表 | user |
| GET | `/api/discover/toplists/[id]` | 榜单详情 | user |
| GET | `/api/discover/trending` | 大家都在听（五平台热歌去重合成） | user |
| GET | `/api/recommend/guess?size=&page=` | 猜我喜欢（本地画像推荐，同日结果稳定） | user |
| GET | `/api/music/alternatives` | 换源候选（其他平台同款歌） | user |

### 5.3 歌曲信息（曲目/歌词/封面/专辑/歌手）

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/api/track?uid=` | 曲目元数据反查（分享自动播放用） | user |
| GET | `/api/lyrics?id=` | 歌词 | user |
| GET | `/api/cover/{id}` | 封面二进制（公开，供 Subsonic 客户端） | pub |
| GET | `/api/album/{tx,kw,mg,apple}/tracks` | 各平台专辑曲目（tx/kw/mg 相互降级，Apple 独立） | user |
| GET | `/api/album/apple/cover`、`/api/album/cover` | 专辑封面中转 | user |
| GET | `/api/artist/{tx,kw,mg,apple}/detail` | 歌手详情（头像/热门歌/专辑/MV，三源降级 Apple 兜底） | user |
| GET | `/api/artist/avatar?name=` | 维基歌手头像（经 WIKI_PROXY_URL 代理） | user |
| GET | `/api/artist/apple/avatar`、`/api/artist/apple/mvs` | Apple 头像 / MV 列表（30s 预告） | user |
| GET | `/api/image-proxy?url=` | 图片同源代理（域名白名单防 SSRF） | pub |

### 5.4 收藏 / 歌单 / 历史 / 音乐库

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET/POST/DELETE | `/api/favorites`（`?type=song\|album`） | 收藏 CRUD + `/check` 状态查询；专辑收藏随行落展示快照 | user |
| GET/POST | `/api/playlists` | 歌单列表 / 创建（`collected=true` 为榜单收藏型） | user |
| GET/PATCH/DELETE | `/api/playlists/[id]` | 歌单详情 / 更新 / 删除 | user |
| POST/DELETE | `/api/playlists/[id]/songs` | 添加歌曲（songIds[]）/ 按 position 移除 | user |
| POST | `/api/playlists/[id]/collect` | 收藏他人歌单（复制到自己名下） | user |
| POST | `/api/playlists/[id]/replace-entry` | 歌单条目原位换源 | user |
| POST | `/api/playlists/import` | 洛雪歌单导入（兼容新旧格式） | user |
| POST | `/api/playlists/import-remote` | 五平台公开歌单链接导入（wy/tx 支持 cookie 导私有歌单） | user |
| GET/POST/DELETE | `/api/history` | 播放历史：查 / 上报 / 清空 | user |
| GET/POST | `/api/recent-contexts` | 最近播放的歌单/专辑 | user |
| GET | `/api/stats/song-plays` | 跨源合并的播放统计（猜你喜欢数据出口） | user |
| GET | `/api/library?keyword=` | 本地音乐库列表 + 拼音首字母搜索 | user |
| DELETE | `/api/library/[id]` | 删除库条目（文件 + 登记行） | user |
| POST | `/api/library/rebuild` | 重建库索引（DB 丢失/手动放文件后修复） | admin |

### 5.5 用户认证

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| POST | `/api/auth/login` | 登录（限速；scrypt 校验；存量明文惰性迁移；返回 mustChangePassword） | pub |
| POST | `/api/auth/logout` | 登出 | pub |
| GET | `/api/auth/me` | 当前会话状态 | opt |
| POST | `/api/auth/change-password` | 改密（成功后踢其它设备 + 轮换 Subsonic 令牌） | user |
| POST | `/api/auth/heartbeat` | 在线心跳（更新 lastSeen/IP/UA） | user |
| PUT | `/api/auth/avatar` | 设置内置头像（1~10） | user |

### 5.6 管理端（全部 admin）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/admin/cache` | 缓存统计 / 清理（search/url/audio/all/scan-orphans/clean-orphans） |
| GET/POST | `/api/admin/login-locks` | 登录锁定列表 / 解锁 |
| POST | `/api/admin/music-info/import` | 批量导入元数据（checksum 去重幂等） |
| GET/POST | `/api/admin/recommend` | 推荐白名单列表 / 批量加入 |
| DELETE | `/api/admin/recommend/[uid]`、`/batch-remove`、`/clear-all` | 取消推荐 |
| POST | `/api/admin/recommend/ai-filter`、`/ai-generate` | AI 辅助筛选 / AI 生成名单（只读建议，不写库） |
| GET/POST | `/api/admin/recommend-tasks` | 推荐任务列表 / 创建（含 cancel/rerun/rollback 子接口） |
| GET/POST | `/api/admin/sources` | 音源配置列表 / 新增 |
| PUT/POST/DELETE | `/api/admin/sources/[id]` | 修改 / 手动更新订阅脚本 / 删除音源 |
| POST | `/api/admin/sources/subscriptions` | 在线音源订阅 |
| POST | `/api/admin/sources/upload` | 上传音源脚本（预校验 + 自动注册） |
| GET/POST | `/api/admin/users` | 用户列表 / 新建 |
| GET/PUT/DELETE | `/api/admin/users/[id]` | 单用户管理 |
| POST | `/api/admin/users/[id]/subsonic-token` | 轮换 Subsonic 令牌（唯一获取入口，仅显示一次） |

### 5.7 其他与 Subsonic 兼容层

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/api/health` | 健康检查：音源初始化快照 + 汇总 | pub |
| GET | `/api/version` | 版本号（登录页显示） | pub |
| GET | `/api/share?uid=` | 分享落地页（SSR 自包含播放页 + og meta + st token） | pub |

**Subsonic 兼容层** `/rest/[method]`（GET only，XML 或 `f=json`）：

- 读方法：`ping`、`getLicense`、`search3`、`stream`（走同一音频服务）、`getCoverArt`、`getLyrics`、`getLyricsBySongId`（OpenSubsonic 结构化歌词）、`getSong`、`getAlbum`、`getStarred(2)`、`getPlaylists`、`getPlaylist`、`getUser`、`getOpenSubsonicExtensions`、`getAlbumList2`、`getRandomSongs` 等
- 写方法（必须验证 token）：`star`、`unstar`、`createPlaylist`、`deletePlaylist`、`updatePlaylist`
- 认证：`u` + `t=md5(token+s)`（或 `p` 明文兼容）；`REQUIRE_AUTH` 环境变量控制校验范围。收藏与歌单在 Subsonic 与 Web 之间**双向同步**（同一套表）。

---

## 6. 前端架构

### 6.1 托管与构建

- 开发：Vite :5173，`/api`、`/rest` 代理到 Next :3000；`@` 别名指向仓库根，SPA 直接复用根目录的 `components/`、`hooks/`、`lib/`。
- 生产：`frontend/dist` 由 nginx 服务（SPA fallback），`/assets` 一年强缓存。
- **PWA**：Service Worker（`public/sw.js`）——`/api/*` network-only；HTML 导航 network-first 失败回退缓存；静态资源 stale-while-revalidate；版本号递增触发旧缓存清理。manifest 深色单主题、standalone 显示。

### 6.2 页面路由（react-router v7，集中声明于 `frontend/src/App.tsx`）

| 路径 | 页面 | 功能 |
|---|---|---|
| `/` | HomePage | 首页（随机推荐 + 最近播放的歌单/专辑） |
| `/recommend` | RecommendedMusicPage | 推荐音乐 |
| `/leaderboard` | LeaderboardPage | 排行榜 |
| `/discover/toplists/:id`、`/discover/playlists/:id` | DiscoveryCollectionPage | 榜单/歌单合集详情 |
| `/search` | SearchPage | 多源搜索（歌曲/专辑） |
| `/favorites` | FavoritesPage | 收藏（歌曲 + 专辑） |
| `/playlists`、`/playlists/:id` | PlaylistsPage / PlaylistDetailPage | 歌单管理/详情 |
| `/playlists/ai-create`、`/playlists/:id/ai-add` | AiPlaylistPage | AI 协助建歌单/加歌（五步向导） |
| `/artist/:source/:artistId`、`/album/:gid` | ArtistDetailPage / AlbumDetailPage | 歌手/专辑详情 |
| `/history` | HistoryPage | 播放历史 |
| `/admin`（`?tab=` 驱动 6 个 Tab） | AdminPage | 用户/登录锁定/音源/推荐/推荐任务/缓存 |
| `/login`、`/change-password` | LoginPage / ChangePasswordPage | 认证（独立全屏布局） |

全局守卫：未登录跳 `/login?redirect=`；`mustChangePassword` 强制改密；分享链接 `?uid=` 自动播放、`?playlist=` 跳歌单。

### 6.3 状态管理（zustand）

- **player-store**（播放内核状态）：
  - 双队列：主队列 + 插播队列（"下一首播放"插队头，优先于一切播放模式，插播期间主队列指针冻结）；播放模式 sequence/loop/random。
  - 音质策略：用户偏好（localStorage 持久化）→ 按歌曲可用音质就近降级 → 再按浏览器 `canPlayType` 探测的编解码能力压掉播不了的格式。
  - **错误自愈**（`handleTrackError`）：解码类错误只对当前歌降一档音质重试（不污染全局能力表）；连续跳歌有上限（min(3, 队列长度)），播放稳定 >5s 重置计数；达上限才报错停止。
  - 睡眠定时器、MediaSession 集成、下载进度上报、登录态才上报播放历史。
- favorites-store（乐观更新 + 失败回滚）、search-store（reqId 丢弃过期请求、页面切换不丢结果）、discover/guess-store（TTL 缓存 + 换一批）、context-menu-store（全局右键菜单）。
- useAuth（hooks）：启动拉取会话、2 分钟心跳、401 自动下线。

### 6.4 组件地图

- `components/player/`（19 个文件）：PlayerBar 全局底栏（唯一 Audio 元素）、QueuePanel、LyricsPanel、音质/模式弹层、频谱可视化。
- `components/admin/`：6 个 Panel 对应管理端 6 个 Tab（Users/LoginLocks/Sources/Recommend/RecommendTask/Cache）。
- `frontend/src/components/`：AI 建歌单向导（双壳自适应）、歌单弹窗组、听音识曲。
- `components/shared/`：SongList/SongRow、SongContextMenu（全局右键/长按）、封面组件（两级降级）、Toast。
- `lib/api/`（23 个模块）：统一走 `client.ts` 的 `apiGet/apiPost/...`，统一解析 `{success, data}` 信封。

### 6.5 样式

Tailwind CSS v4（CSS-first 配置，无 config 文件），**深色单主题**（oklch 变量，Spotify 风），safe-area / 44px touch-target 等自定义工具类，framer-motion 动画。

---

## 7. 关键数据流：点播一首歌的全链路

以 Web 端点击一首未缓存的歌曲为例：

```
1. UI 点击播放
   player-store.loadStreamUrl(track)
     → 按偏好音质就近降级 + 浏览器编解码能力过滤 → 定格 quality
     → streamUrl = /api/audio?uid=tx-003xxx&quality=320k   （不先要直链）
     → <audio>.src = streamUrl，开始请求

2. GET /api/audio（Next）
   → 鉴权（会话 cookie 或分享 st token）
   → uid 反查 MusicInfo（DB）
   → ① 本地音乐库命中？（uid 精确 → 跨平台模糊）命中即发文件，结束
   → ② 磁盘缓存命中？（audioCache 表 + Range）命中即发文件，结束
   → ③ miss → 注册 in-flight entry（并发去重）→ 后台开始下载

3. 下载（audio-serve.runDownload）
   → musicSourceManager.getMusicUrlWithProvider(mi, quality)
       → 瀑布：按 priority 遍历启用音源 × 音质
           （pt 白名单 → 脚本声明 → 音质存在 → 15s 单次超时）
       → runner 子进程执行洛雪脚本 getMusicUrl()
       → SSRF 检查 → 返回 { url, provider }
       （同平台全失败 → 跨平台找同款歌重试一次）
   → fetch(url) → 检查状态码 / Content-Length
   → 读首块 → 容器嗅探（audio-sniff）
       ├─ reject（HTML/JSON/图片…）→ 排除 provider，重新走瀑布（≤2 次）
       ├─ unverified（未知容器）→ 继续交付，但不入库
       └─ audio → 继续下载
   → 边下边写盘，进度事件驱动响应流「跟随交付」给客户端
     （Range 请求返回 206，可 seek，seek 超前则等待下载推进 ≤15s）
   → 下载完成：大小校验 → 试听片段判定（时长比对）→ 落库 audioCache
   → post-cache：歌词预缓存 + 移入本地音乐库（容器校验 + 去重 + 配额）

4. 前端播放
   → 原生 Audio 解码播放；出错 → handleTrackError（降音质重试 → 连续上限内跳歌）
   → 起播稳定后 fire-and-forget 上报 /api/history + 最近上下文
```

Android / Subsonic 客户端走完全相同的 `/api/audio` 入口（Subsonic 的 `stream` 方法内部委托同一 audio-serve），因此服务端缓存与音乐库对三类客户端共享。

---

## 8. 配置参考

### 8.1 环境变量（主要项，全集见 `.env.example`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | `file:./data/music.db` | SQLite（相对 prisma/ 目录解析） |
| `AUTH_SECRET` | — | 会话签名密钥，生产必须 ≥32 位随机 |
| `REQUIRE_AUTH` | 未设置=全部要求 | Subsonic 接口鉴权范围（`false`=仅写方法 / 方法名列表） |
| `ENABLE_FILE_CACHE` | `true` | 音频磁盘缓存总开关；false 时流式透传（无 seek） |
| `AUDIO_CACHE_DIR` | `data/audio-cache` | 磁盘缓存目录 |
| `AUDIO_CACHE_QUOTA_GB` | `10` | 磁盘缓存配额（LRU 淘汰） |
| `AUDIO_CACHE_READINESS_TIMEOUT_MS` | `20000` | 上游 URL 解析超时 |
| `AUDIO_FAKE_URL_RETRIES` | `2` | 假地址换源重试次数上限 |
| `AUDIO_LIBRARY_DIR` / `AUDIO_LIBRARY_QUOTA_GB` | `data/library` / `20` | 音乐库目录与配额 |
| `SEARCH_CACHE_TTL_MS` | `12600000` | 搜索/URL 内存缓存 TTL |
| `WIKI_PROXY_URL` | — | 维基歌手头像代理 |
| `USER_CONFIG` | — | 配置用户文件路径（config-sync 启动同步用） |

### 8.2 音源配置 `config/music-sources.json`

```jsonc
{
  "sources": [
    {
      "path": "custom-sources/xxx.js",   // 脚本路径（相对 cwd）
      "name": "音源显示名",
      "pt": ["kw", "tx", "mg"],          // 平台白名单：该源只对这些平台生效
      "enabled": true,
      "priority": 1,                     // 数字越小越先尝试（即瀑布顺序）
      "subscription": { "url": "...", "updatedAt": "..." }  // 订阅源才有
    }
  ]
}
```

管理端的启停/排序直接写回此文件并热重载。`priority` 就是瀑布顺序——**排序是这个系统里最值钱的手工调优项**（慢源排前面会吃满级联预算拖慢所有人）。

### 8.3 用户种子（config-sync）

启动时（instrumentation.ts）把配置文件里的用户同步到 DB（存在即跳过）；检测到弱口令（`admin`）会自动重置为随机密码并打印一次、标记强制改密。

---

## 9. 数据模型（Prisma / SQLite）

| 模型 | 职责 | 关键字段 |
|---|---|---|
| `MusicInfo` | 歌曲元数据正本（搜索时落库） | source、songmid、name、singer、typesJson（各音质可用性）、checksum（跨源去重） |
| `User` | 用户 | username、passwordHash（scrypt）、subsonicSecret（Subsonic 令牌）、sessionVersion、mustChangePassword、avatar、lastSeen |
| `Favorite` | 收藏（歌曲 + 专辑共用） | userId、itemId、itemType、展示快照（name/singer/img，专辑不在曲库无法回查） |
| `Playlist` / `PlaylistEntry` / `PlaylistAllowedUser` | 歌单 / 条目（position 定序）/ 可见用户 | collected（榜单收藏型）、comment |
| `PlayHistory` | 播放历史 | userId、musicInfo 快照 |
| `RecentContext` | 最近播放的歌单/专辑 | itemType、itemId、快照 |
| `AudioCache` | 磁盘缓存索引 | cacheKey、filePath、size、contentType、lastAccessAt（LRU 依据） |
| `LibrarySong` | 本地音乐库登记 | dedupeKey（归一化歌名\|主歌手）、uid、quality、filePath、durationSec |
| `RecommendTask` | AI 推荐任务 | status、progressJson、addedUids（支持回滚） |

---

## 10. 测试与质量保障

- **两套 vitest**：根目录（node 环境，`lib/**` + `app/**`，服务端）与 frontend（jsdom，hooks/components）。当前服务端 59 文件 / 590 测试。
- **验证惯例**（每次改动后跑全）：`typecheck` → `lint`（0 error 基线）→ `vitest run` → `pnpm build`；关键改动另做真机探测脚本（起 dev 后 curl 全链路断言，跑完即删）。
- 测试风格：接口测试 mock Prisma（图级替换），纯逻辑（嗅探/凭据/限速）直接单测；audio-serve 用临时目录 + mock fetch 流验证「跟随交付」语义。

---

## 11. 部署

- **Docker**：多阶段构建 —— backend-builder 跑 `next build`（standalone），frontend-builder 跑 Vite build，产物进运行时镜像；入口是 `scripts/start-spa.sh`：先以镜像内捆绑的 prisma CLI 执行 `migrate deploy`（失败即终止启动，不带缺失 schema 静默运行）→ 后台起 Next standalone（:3001，`HOSTNAME=0.0.0.0`）→ 探活就绪后 nginx 前台运行（:3000）作为容器主进程。另有 HEALTHCHECK 打 `:3000/api/health`。对外映射建议 3099:3000（NAS 实例）。
- **持久化**：`data/`（music.db + audio-cache + library + logs）与 `config/`、`custom-sources/` 挂载卷。
- **nginx 要点**：SPA fallback、`/assets` 一年强缓存、`/sw.js` `/manifest.json` no-cache、`/api` `/rest` 反代 3001。
- **升级**：镜像替换 + 自动迁移；音源脚本与配置在挂载卷中不随镜像丢失。

---

*文档完。有出入处以代码为准；运维注意事项与未提交改动清单见 `HANDOFF.md`，Android 客户端接口契约见 `docs/ANDROID_API.md`。*

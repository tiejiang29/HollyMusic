# HollyMusic 系统架构与接口文档

> 面向未接触过代码的读者：本文描述 HollyMusic 的整体架构、实现的功能、后端全部 API 路由、前端结构、数据模型与部署形态。
> 基于代码现状整理（2026-09-19，v2.1.1）。接口变更的增量记录见 `docs/ANDROID_API.md`，运维交接见 `HANDOFF.md`。

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
`health` 是真跑出来的实测）。三条护栏都是实测换来的：**「没找到 / 不支持」不等于「坏了」**（pt 不含该平台、脚本没声明该
平台或该音质、歌曲元数据里没这档、脚本返回空地址，一律只累计 `noMatch` 不计坏——判据见
`isContentMiss`，它刻意只认"明确说没这首歌"的文案，而把 `服务端返回非 JSON`、`get url
failed`、HTTP 4xx/5xx 这类**传输层**失败留在"坏"里）、**缓存与音乐库命中不入账**（结构性保证：
埋点只存在于瀑布和 `openUpstream` 这两个 miss 路径上）、**本机网络故障期间不记坏**（DNS/连不上
会一次性冤枉所有源）。

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
「立即周测」手动）把「启用源 × 该平台能力 × 每平台 2 首基准曲」全矩阵跑一遍，结果写 `SourceProbeResult`
（append）+ `SourceProbeRun`（批次元数据与样本快照）。几条值得知道：

- **范围以脚本自己声明的平台为准，不看 `pt`**（2026-10-07 改）。`pt` 是面向用户的派活白名单；探测要是
  也被它挡着，一个平台一旦被摘出 `pt` 就永远不再产生新数据，下次想放回去时没有任何证据。取址侧
  `probeSourceUrl` 里原先那道 `isAllowedByPt` 闸门已删，判范围的是 `scopePlatformsForSource()`。
  `unsupported` 的格子计入「不适用」，不进分母，也不参与好坏判定。

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

**周测建议（`lib/services/source-advice.ts`，2026-10-07 新增）**：把周测结论翻成「改 `pt` / 改
priority」的建议，**只给建议**——改配置必须是管理员在面板上的一次点击，没有任何定时器会自己
apply（`music-sources.json` 只有一个原子写入者）。门槛**不对称**：摘掉平台与调整顺位要连续两批同向
（误摘 = 一个好平台再没上场机会、也没有数据翻案），放回平台只要最新一批出货就提（误放 = 那个平台
多试一次不行，3c 会熔断、下一批还会再建议摘）。顺位是**全局一套**（瀑布先按 `priority` 排一次再按
平台筛），没实测数据的源不参与也不动位置。**一个源的一个方向合成一条**（面板一行一个勾），但每个
平台的出货数字各自留在依据里 —— 合并的是点击次数，不是证据。固化**只认 id**（值由服务端按这一刻
重算，客户端挂着旧页面也写不进旧值），写前把配置原文存进 `AppSetting['source_advice_undo']`，
撤销按字节还原，快照只留最近一份。

**tx（QQ音乐）搜索要走 `zzc` 签名（2026-10-08）**：老的 `musicu.fcg` 对匿名请求已经不给结果——
`DoSearchForQQMusicLite` 回子包 `code=2001/500003`，换 `Desktop/Mobile`、换 `ct=11/24`、补 `uin/guid`
共 12 种组合全是 0 条（`code=0` 的那些是 `meta.estimate_sum>0` 而 `sum=0`，即引擎认得这个词、结果被压着
不给），连 QQ 自家网页匿名搜也是空。现在走 `musics.fcg?sign=zzc…`：签名是**纯算法**（对载荷 JSON 串做
SHA1 → 两组按下标取字符 + 20 字节 XOR → 去掉 `+/=` 的 base64），**不需要登录也不需要 token**，所以
无人值守可用。实现集中在 `lib/music-core/tx-sign.js`：`txSearchRequest()` 一次给出 `url` 与 `text`，
**调用方不许再 stringify 第二次**（键序一变签名就对不上，这条钉在测试里）；`pickTxSongs()` 同时认新版
`body.song.list` 与老版 `body.item_song`。算法移植自 lyswhut/lx-music-desktop v2.12.3（#2848）的
`tx/utils/crypto.js`，该仓库是 **Apache-2.0**，署名随文件注释。该 cgi 偶现拒人，所以重试 3 次（间隔
300ms）后才抛错，且**把上游 code 带进错误消息**——以前只丢一句"搜索失败"，排查时分不清是被拒还是真没结果。
UA 不必冒充客户端（实测我们那串老 UA 同样出 20 条）。tx 的其他接口（取词、取址、专辑曲目）仍走老接口，未受影响。

> 顺带一条排查口径：**验某平台的搜索还活不活，必须用没搜过的关键词**。`searchCache` 的 TTL 是 210 分钟、
> 键含 `keyword:page:limit`，所以旧结果会让人以为上游恢复了（这次那个 200/5 就是缓存）；换个 `limit`
> 或 `page` 是最省事的绕缓存探针。

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
- **SSRF 防护**：音源返回的播放地址过 `isTrustworthyUrl`（拒绝私网/非 http(s)）；订阅 URL 与图片代理走逐跳护栏 + 域名白名单；**音源脚本自己发的请求**（沙箱 `lx.request`）在建连前先解析域名、对每个地址判公网（IPv6 会还原内嵌 IPv4 后再判），`SOURCE_ALLOW_PRIVATE_NET=true` 时整条短路。三处口径同为 `lib/server/url-guard.ts` 的 `isPublicIp` 段表（沙箱侧因是 CommonJS 子进程，另存一份同口径实现，改一段要同时改另一段）。残余风险：校验与实际建连之间的 DNS rebinding 窗口不覆盖。
- **权限**：管理端全部 `requireAdmin`；C 端 `requireUser`；公开接口仅登录/登出/health/version/share/封面/图片代理及 Subsonic 匿名读（受 `REQUIRE_AUTH` 开关控制）。
- **分享链接**：`/api/share?uid=` 生成自包含 SSR 播放页（og meta 供微信爬虫），签发 HMAC 的 `st` token（绑定 uid+quality+时效）供匿名播放，不需登录。

### 4.6 后台任务

- **封面回填**（cover-backfill）：进程内定时器（启动 15s 后首跑，之后每 6h），补齐历史歌曲的封面，幂等。
- **推荐任务**（RecommendTask）：管理端创建 AI 推荐任务（建歌单/筛歌），进程内 worker 串行消费，进度写 `progressJson`，前端 2.5s 轮询；服务重启时把僵尸态任务标记 `interrupted`。API Key 只在创建请求里透传，不落库。

### 4.7 小爱音箱网关（`lib/services/xiaomi/*`，分期推进中）

服务端自建的小米网关，不挂任何旁路容器。已落地：G0 扫码与设备表、G1 投歌、G2 投放态、G0.5 对话回显、G3 语音接管。**G1.5（ffmpeg 转码）实现过又整块撤掉**，理由见 §4.7.4。

- **登录是两步，少第二步什么也干不了**：二维码的 `sid` 是 `mijia`（米家），它只发 `passToken`；小爱音箱走的 MiNA 要的是 `sid=micoapi` 的 serviceToken，必须再换一次票。换票要**跟完重定向并收集每一跳的 Set-Cookie**（票就在其中一跳的头里），所以这一段用不了 `safePublicFetch`（它跟跳时会 cancel 中间响应体、也不回传中间跳的头），改成每跳先过 `assertPublicHttpUrl` 再手动 `redirect:'manual'`。
- **两个必须照抄的取数细节**：响应体带 `&&&START&&&` 前缀；`nonce` 是 18~19 位大整数，**只能从原始字符串里抠**（`JSON.parse` 会把尾数改掉，签名于是算错，表现是"换票莫名失败"）。
- **二维码要用平台渲染的那张**（返回体里的 `qr` 字段是图片地址）；自己拿 `loginUrl` 编一张 App 认不出来，只回"二维码已过期"。
- **凭据与设备表落 `AppSetting` 单键 `speaker`（JSON）**，与 `sourceDiscovery` 同构：管理员要调的都在面板上，不写配置文件也不走环境变量。`serviceToken` 按 12h 计（**这是参考实现写死的估值，小米的响应里没有 `expires_in`**），剩 3h 主动用 `passToken` 静默续（不需要重扫）；设备侧回"票不行"时当场续一次再试一遍。续期失败**不清凭据** —— passToken 大概率还在（三家参考实现都把它当长期凭据存，没一处给它记过期时间），清了就等于把人逼去重扫。
- **判"票不行"要按码与话术一起看**：`mina-client.isAuthFailure` 认 `code=401/319/70016`、message 含"登录验证失败"、message 含 `auth`（小米这套常是 HTTP 200 包里夹着错误码，只看 HTTP 状态会漏掉最常见的 `70016`，于是既不触发续期也不提示重扫）。
- **换到的新票要先验一次才算数**（照 miot 的 `validateToken`：拿新票打一次 `device_list`，`code===0` 才落库）。只信"换票接口给了串"的话，一张开不了门的票存进库以后面板显示"已登录"、每次操作却都失败，比明说"要重扫"难查得多。验证拿回 401 类错 ⇒ 不落库；只是上游抖动/超时（502 类）⇒ 新票照存（这一步没能证明它是坏的）。
- **续票有 60 秒最小间隔**（`RENEW_MIN_INTERVAL_MS`）：小米对频繁登录确实限流（`code=70022`，连续失败还会进更长的冷却），管理员连点几下"刷新设备列表"不该变成连着打 `serviceLogin`。被跳过时报的话是"刚试过，等一会儿"，不是"要重扫"。
- **脱敏是硬线**：`GET /api/admin/speaker` 只回 `accountTail` / `tokenTail`（尾四位），凭据原值没有任何一条路径从服务端走到浏览器；日志同样只打尾巴（`0b33df9` 那次 wire 日志泄露会话 cookie 的同类教训）。
- **小米侧的 401 不许发成本站的 401**：`lib/api/client` 一见到 401 就作废管理员在本站的会话（`hooks/useAuth` 注册的处置），否则"小爱的票过期"会把人从后台踢下线。路由统一降级成 502，靠 `error.code` 区分 `XIAOMI_UNAUTHORIZED`（要重扫）与 `XIAOMI_UPSTREAM_ERROR`（上游抽了）。
- **扫码的长轮询不在路由里等满 30 秒**：单次 lp 只等 8 秒就返回 `waiting`（把 Next 的请求槽挂住会拖垮同时进行的音频请求），前端隔 3 秒再来一次；过期由服务端会话时间戳判（5 分钟），不靠前端计数。轮询要同时带 `sessionId` 与一次性 `loginToken`（后者只在出二维码那一次响应里出现过），对不上就一律回同一句话，不给可用来试探哪些 id 有效的差异。
- **设备表必须存 `hardware`**：G1 判"这台走 `player_play_music` 还是 `player_play_url`"只看它，G0 不存 G1 就得改结构。刷新列表时按 `deviceID` 保住管理员手工标的 `managed`。

### 4.7.1 G1：投歌到音箱

- **ubus 一条设备一条队**：`mina-client.enqueueUbus(deviceId, …)` 把同一台设备的指令串起来（云端不保证并发指令的执行顺序，两条一起发会变成"后发的被先发的盖掉"）；G2 的对话轮询将来也挤这条队。
- **`player_play_music` 那串 `music` 是"字符串化后再放进 message"**（`{startaudioid, music: JSON.stringify(…)}`），不是嵌套对象 —— 抄错这一层设备端直接不认。型号名单照参考实现的 `MUSIC_API_MODELS`（我们那台 `L05B` 在里面）；面板上可把某型号摘出名单退回 `player_play_url`。
- **`code==0` 只代表云端受理**：设备级的回执在 `data.code`，非 0 就是"音箱拒了"。推完等 2 秒回读一次 `player_get_play_status`（它的 `info` 是一段 JSON 字符串），把"亮灯不出声"变成能看见的失败；读不到状态与"确实停了"是两件事（`-1` vs `0`），面板上分开显示。
- **给音箱的是本站出口 `/api/speaker/stream`，不是 `/api/audio`**：`/api/audio` 有"本地秒开优先"（`shouldServeLibraryFile`：库内音质 ≥ 请求档就直接端本地文件），请求 320k 也可能把 **FLAC** 端出来 —— 手机车机听得懂，音箱听不懂。与其改那条热路径的裁决规则，不如单开一条**只认 MP3** 的口：库内文件先读头部字节嗅容器（扩展名不算证据），不是 MP3 就改走在线取 320k/128k，拿回来还不是 MP3 就 415 明确失败（宁可失败也不给一个放不出来的地址）。
- **`st` 令牌必须放在第一个参数位**：部分固件会把 URL 里的 `&` 换成空格，令牌在前才还能按"第一个空格之前就是令牌"还原（`readParams`）；令牌不在第一位就救不回来，只能 401。令牌本身是分享页那套 HMAC（绑定 uid+quality、时效 2 小时，因为这条 URL 会**经过小米云端**），日志与返回值里都只留脱敏形式。这台 L05B 实测**确实改写了分隔符**（`[speaker/stream] 还原了被固件改写成分隔符的查询参数`），而且它是**带 Range 拉流、一条连接能挂 3 分半**（日志里那条 206）—— 这条对 G2 的"改位置只能重推"有影响。
- **面板上的音量是"点开竖向滚动条、拖动即发"**：一次 ubus 往返实测 0.34~0.46 秒，拖一格会产生几十个中间值，全发既排队又容易撞小米限流（70022），所以按 250ms 间隔发（`volumeSendDelayMs`，边界口径有单测）、松手必补发落点。点开时**先读一次状态**把起始值摆成音箱现在的音量 —— 起始值乱猜会拖出"往下拖反而变响"。
- **地址必须是音箱够得着的局域网地址**（面板项 `speakerServerHost`，落 `AppSetting`）：没填就拒绝推歌、填回环地址直接报错 —— 拼一个"我们这边能打开、音箱拉不到"的 URL 是这类功能最难查的失败形态。

### 4.7.2 投放态（G2）：本地静音、进度跟音箱、连续播放

设计定则只有一句：**换个执行者，不换状态源**。`player-store` 的 `isPlaying/currentTime/duration/seek/next()` 一个字段都不改，播放栏、歌词、队列、锁屏 MediaSession 照旧读写它们；投放态下这些动作落到 `/api/speaker`，本地 `<audio>` 完全不参与（`loadStreamUrl` 在投放态直接返回）。

四条实测事实决定了形状（真机 L05B，2026-10-08）：

- **网页标签页一隐藏，计时器被浏览器夹成一分钟才醒一次**（1s/5s 两个 `setInterval` 一起被夹；fetch 本身没问题，冻的是"唤醒"）。所以"提前 3 秒推下一首"这类亚分钟判据**不许放在前端**，连续播放由服务端 `cast-session` 的看门狗负责。
- **`player_play_music` 的 `audio_items` 是数组，设备会按顺序自己播完**（推 10 项实测严格按序，边界处新项已到 `pos=3s`）——连播整包交给设备；但**一批放完它从头循环**（`player_set_loop` 只有单曲/列表/随机，没有"不循环"），所以尾巴必须我们收：`advance()` 要么补下一窗，要么整条队列见底就 `stop`。
- **重推会让那一项从 0 起播**（拿同一条地址中段重推，192ms 后 `audio_id` 换新、`pos=0`）。所以补推只能卡在**边界**：判据是窗内最后一项 `剩余 ≤ 0.5s`（窗尾与"投放期间改过队列"两种情况都会动手，后者不必等整窗见底）。`play_behavior:'APPEND'` 是假的——云端 `code=0` 但设备当场播这一项、掐掉当前歌。
- **那 0.5 秒要定点睡过去，不靠定间隔去撞**（2026-10-09 真机：语音接管那一首放完从头循环）。做法（`tailDelayMs`）：剩余 `> 8s` 照常 5s 轮询，进了 8s 就按剩余**一次 `setTimeout` 睡到边界前 0.3s**，醒来正好落在窗口里（探针：改成恒定 5s 一轮，收口时刻从 299.7s 漂到 303.8s）。⚠ **真机那一拍到底为什么漏是推断、不是实测**：`remaining` 是外推的（上次读到的位置 + 墙钟），每一拍算出的数本身是准的，能想到的解释是"两拍之间设备已经放完转回头、下一读位置变成小值 ⇒ 剩余重新涨回去，从此再也撞不中"（只投一首时更致命：**没有下一窗来盖它**）—— 但把老写法（最后 5 秒 1 秒一轮）照这套机制放进模拟设备里**照样撞得中**，因为模拟里的节拍是整秒、真实轮询还带一两百毫秒的往返。所以这一条是按机制改的，**下面那条回跳兜底才是真把"漏了也能收口"钉住的东西**。
- **兜底是"位置大段回跳"**（`sawLoopRestart`）：睡过了边界（机器休眠、事件循环被卡住）或**元数据时长撒谎**（现成例子 `kw:440613 实际=224s 期望=304s`，按 304 算永远等不到边界）时，靠这一条立刻收口。闸门取"上一拍至少已经播了 30 秒"（`LOOP_MIN_PLAYED_MS`），**不取"离你以为的结尾多近"**（那条正好被撒谎的时长废掉），也不是"我们定点过才算"（那样撒谎那条就漏网）；30 秒的依据是那条 5.1 秒挂断重拉 —— 设备在**起播那阵子**拉不到字节会自己重拉、位置同样从 0 起，那时候绝不可能已经播了 30 秒，那种回跳该等它继续而不是停掉。这条只在 `mustAct`（窗尾或改过队列）那一拍被采纳；换窗/重推会把 `lastStatus` 清成 null、设备自己在窗内换项则 `audio_id` 会变，两种都比不出回跳；`loopOne` 压根不动手，"从头再来"正是要的效果。三条测试分别钉住：撒谎→收口、起播重拉→不许停、单曲循环→不许停。
- **`play_song_detail.audio_id` 原样回显我们填的值** ⇒ 它就是"播到窗里第几项"的游标，不需要任何新接口；设备报的 `duration` 是当前项的（seek 后就是剩余长度），所以界面总长取元数据 `interval`。

其余要点：

- **窗口 10 首**（报文 4KB；单项约 340 字符）。不一次推整张队列的三条硬理由：`st` 令牌只 2 小时（长队列后面全是死链）、ubus 表单体积没人试过（1200 首是 651KB）、队列会被用户改。播放顺序由前端 `lib/cast-queue.ts` 按播放模式算好交出去（随机在这里**冻结成一份确定列表**，服务端不再回头问）。
- **拖动定位**：出口 `/api/speaker/stream?seek=<秒>` 换算成字节偏移 —— `ID3v2 大小 + 秒 × 码率`（码率优先读第一帧头，不信音质档标签），再**往前对齐到真正的帧首**（`秒×码率` 几乎必然落在半帧上，设备解码器起手找不到同步字就会 330ms 内重拉 5 次然后一声不出），并且这条**按 200 整条发剩余部分**而不是 206（设备照惯例发的 `Range: bytes=0-` 对"从中间开始的一条流"没有意义）。重推必须带上剩余项一起排，否则连播丢失。
- **状态一致性**：`castStatus` 只读服务端会话（**一次都不打小米**），设备侧的读由看门狗按 5s 做（窗尾最后 8 秒不读第二遍，直接睡到边界），两次之间按 `position + 已过时间` 外推、每次轮询 snap 回真值；刚推完还没读到状态那一段服务端按"在播"报（否则客户端第一次轮询就把乐观态按回 false，出现"音箱在唱、按钮显示播放中"）。
- **音量**：面板与播放页共用 `lib/cast-queue.ts` 里那份节流口径（250ms + 松手补发）；**音量会自己变**（实测途中 44→32，我们没发指令），所以要用就现读，不许假设恒定。
- 会话是内存态且由**路由侧**持有（Next 的 instrumentation 是另一套模块副本，从它写进去的内存态路由读不到）：进程重启即丢（设备会循环最后一窗），这是有意接受的代价。

### 4.7.3 对话回显（G0.5）：G3 的输入源，先只量时序

`lib/services/xiaomi/conversation-monitor.ts` 按面板上的开关（`conversationEnabled`，默认关）每 `conversationPollSec` 秒（1~30，默认 2）拉一次小爱的对话记录，缓存在内存里给 admin 面板回显。它不改动任何东西、也不接管——G3 需要的"刚说了哪一句"以此为数据基础（回答只给回显看，**不参与判据**，见 §4.7.5）。

三条口径（错一条面板就会看着很对但数据是假的）：

- **基线只能用平台返回的 `record.time`，绝不能用 `Date.now()` 推**：本机时钟比小米快 ⇒ 启动后一段时间的真实对话被静默丢掉，比它慢 ⇒ 重放历史。首轮那批记录留着显示但标 `fromBaseline=true`，G3 的接管判据**不许吃这些**。
- **"这次没取到"与"确实没有记录"必须分开**：`fetchConversations` 抛错时不动基线、不清 `lastError`（单台软错要留着，早先收尾一律清成 null，出现过"每台每次都失败、面板显示一切正常"）；返回 `[]` 才算真没有。
- **平台会往回改写记录时间戳** ⇒ 只按"更大才收"会漏掉刚说的这句，留 10s 回退容忍，靠 `time|query` 去重键防重播。
- **回答是后补进同一条记录的**（2026-10-09 实测：同一行先是空、下一拍带回几十字回答）⇒ 去重键**不能含回答**，否则同一句话在面板上出现两行（先空后有）、接管也会收到两次。现在的做法是同一行**原地补全**（feed 里那个对象就是唯一一份），补上回答时面板那一行跟着变、一行不多。
- **硬错只认"票的事"，上游偶发拒绝算软错**：`mina-client` 把非鉴权的上游拒绝**也用同一个 `XiaomiAuthError` 抛**（带 `status=502`），所以轮询那边判的是 `status === 401` 而不是"是不是这个类"。原来按类判，一次 `code=999` 就把整条轮询打死且再也起不来（见下）。配套的一条：`schedule()` 的定时器**一触发就把句柄清成 null**，否则 `timer` 永远指向一个已响过的 Timeout，`ensureConversationMonitor()` 就分不出"还在等下一拍"和"已经停了"，那句"等面板来问时重新排程"等于没写。

真机实测（2026-10-09 更正，L05B）：**对话记录是拉得到的，前一个"平台回 0 条"的结论是错的** —— 根因是 **Cookie 里的 `deviceId` 必须填那台音箱的 `deviceID`**，我们一直填的是登录时用的那台设备（`creds.deviceId`）。填错时平台照回 `HTTP 200 / code=0 / message=Success`，但 `records` 恒为空 —— **静默的 0 条，一点错都不报**，所以我们连着一个错误的探针形状"实测"了两小时。对照（`my/conv-deviceid-variants.mjs`）：cookie 用音箱 deviceID ⇒ `records=7 / 3036 字节`；用登录 deviceId、或把 deviceID 补进查询串（`&deviceID=` / `&did=`）⇒ 一律 `records=0`；cookie 不带 deviceId ⇒ `code=601 MissingRequestCookie`。修完后面板当场收到 5 条真记录（含用户 12 分钟前那句，`query` 7 字 / `answer` 71 字，另有一条 3.4 天前的空回答被 `looksFailed` 认出来）。

面板仍把每台账目（`polls/seen/lastTs/primed`）如实摊开；**首轮那批一律标 `fromBaseline=true`**，G3 不许吃（进程重启/热重载后第一批都会算历史，所以要验"真实口令走到接管"得在轮询已经跑起来之后再说话）。

同日再实测：面板上出现过一次 `读取对话记录被拒绝（code=999）`，而同一时刻手工按同一份凭据打 15 次（400ms 与 3s 两种间隔）全是 `code=0 / records=0`。**999 的含义用对照探针问出来了**（`my/conv-hardware-control.mjs`）：`hardware` 是**被校验的**——假型号、空型号、拿设备名当型号，三种都稳定回 `code=999`；真型号 `L05B` 回 `code=0 / records=0 / bitSet=[0,1,1] / 93 字节`。所以 999 是"这个请求平台不接受"的通用码，**既不是限流也不是票失效**（我一度写成"偶发的一拍"，那是把它和"当时手工复现不出来"混在一起说过头了）。当时顺手写的那句"`records=0` 就此排除了参数传错" **也说过头了**：`hardware` 确实被校验（填错必 999），但 `records=0` 的真因在另一个参数上（见上一段），对照实验的覆盖面比我当时以为的窄得多。真正要修的缺陷是判错类：一次 999 把轮询打死且再也起不来（上面那两条），修完实测 6 秒内 `polls` 4→6、`lastError` 归 null。

**这一组的内存态挂在 `globalThis` 上（2026-10-09 实测出的缺陷）**：`feed`/`baselines`/定时器/`MonitorState` 装在一个 `MonitorRuntime` 里，`voice-takeover` 的账本与串行队列、`cast-session` 的会话表与 `audio_id` 计数同理各挂一份。原因是 **Next 的热重载会把模块再求值一遍，而旧副本里那条 `setTimeout` 链不会死** —— dev 上实测到同一句口令被并行的副本各判一次、同一首歌半秒内重推六条「投放窗口已推给音箱」。生产也不是天然免疫：`instrumentation` 拿到的就是另一套 lib 副本（见 §5 那条老教训）。测试里有一条反向钉住它：把状态改回每副本各一份，两秒一拍就会打出 4 次而不是 2 次。

**时钟偏移只做诊断**（`MonitorState.clockSkewMs`）：每拍取这批记录里最新的时间戳减本机此刻，**超前 >5 分钟**才写值，面板「对话回显」卡跟着显示一行"平台比本机快 X 分钟"。它**不参与任何判据**（基线一直用平台时间戳，那是对的），存在的意义是把"我们读早了"和"本机时钟偏了"这两种解释在面板上分得开——2026-10-09 就差点把前者归成后者。

**判定结果回填到那一行**（`AskRow.takeover`）：`submitAsk(row, done)` 判完把同一条 `TakeoverLogRow` 的 `{at,verdict,reason,acted}` 写回对话回显那一行，面板因此多一列「处置」，同一句话不用在"对话回显"和"接管账目"两张表之间对齐（今晚读 999、读 standby 时各踩了一次）。没递进判据的行（启动时那批历史 / 接管开关关着）那格显示"没递进判据"。接管账目那张表**照旧全量留着**（含合成行），瘦不瘦身待用户定。

### 4.7.4 为什么没有转码（G1.5 实现过，又整块撤掉）

库里近一半字节是 FLAC，而音箱听不懂 FLAC，所以看起来该有一层 ffmpeg 转码。实现完、真机也跑通了（70s FLAC → 8.5MB 的 320k MP3，≈39× 实时），然后判它没意义，撤了。**三条理由**：

- **在线那一档自带磁盘缓存**。`/api/speaker/stream` 遇非 MP3 会改走在线取 320k 档，而那份由 `audioServe` 落盘、第二次起就是直接发盘上的文件——跟"转一份产物复用"是同一件事的两种做法，前者还不要 CPU。
- **产物是同一首歌的第三份文件**，而且是**有损再编码**：拿库里的 FLAC 现转的 320k MP3，音质不会比平台那份 320k 更好，只会更差。盘上同时存着在线那份 8,940,938 字节和转出来的 8,941,191 字节，纯浪费。
- **它今天没有一件非它不可的活**：dev 库里 234 条非 MP3 全部来自 kw/tx/mg/wy/kg，都有在线档可退；"只有转码一条路"的是本地导入（`loc-`），而这类**一条都没有**，用户也明确说不往库里导 FLAC。生产镜像同样没有 ffmpeg（只装了 nginx/openssl），要用还得先决定二进制来源。

所以现在的规则就是 §4.7.1 那句：非 MP3 ⇒ 改走在线取档；在线也给不出 MP3 ⇒ 明确 415，不静默降档、不现场重编码。真要恢复这一层，被撤的实现里有一条**必须留下的教训**：设备**约 5.1 秒**拿不到字节就断开、0.1 秒后重拉同一地址，所以"转完才发"和"挂断就杀 ffmpeg"组合起来会让那首歌**永远**转不出来——转码只能做成"不阻塞、后台起一单"，并且并发名额要在返回前同步占掉（隔着 `await` 判满，十个并发请求能真起十个进程）。

### 4.7.5 语音接管（G3）：句子里有点歌触发词就由我们顶上整曲，不看小爱答了什么

`voice-control.ts`（词表与相似度，纯函数）+ `voice-takeover.ts`（判据与执行）。数据来自 §4.7.3 那份对话回显：**"刚说的话"（`fromBaseline=false`）当拍就递进判据，不等小爱的回答**。递给 `submitAsk` 的口令**排队串行**——连着说"下一首 下一首"时不许两条并发抢同一条 ubus 队；判定结果回填到对话那一行（`AskRow.takeover`，见 §4.7.3）。

**为什么把"看回答"那一道整层撤掉（2026-10-09 用户拍的）**：这台没音乐会员，点歌口令小爱总是接走并回「请欣赏X 试听版，手机打开小米音箱APP，开通音乐会员听全曲」——**它答得越顺，端上来的越是 30 秒片段**（真机两句都是这个形状，设备回读 `duration=30024ms`，而《七里香》整曲是 04:59）。于是"它答上了没"根本不是"它办成了"的证据，继续拿它当闸门等于**默认让它放片段**。原先为它配的两项（`takeoverWithoutEvidence`、`takeoverAnswerWaitSec`）随之失去对应判据，一起删掉（库里残留的键在 `readSpeakerConfig` 读取时 `delete`，同 §4.7.4 那次撤干净的做法）。

三层短路，顺序是有意的（越靠前越便宜、越确定）：

- **① 控制词表命中 ⇒ 照做**，零网络零模型。词表面板可改可落库（`操作=词,词` 一行一条，**顺序有意义：先具体后笼统**）。闸门写死：`暂停/继续/上一首/下一首/停止/音量` 这七件**只在这台正被我们投放时才动**——没会话时用户说"暂停"小米自己就暂停了，我们再插一条就是重复甚至打架，那种情况判完只记一句"交回小爱"。播放模式（随机·单曲循环）**不在这张表里**：它是前端 `player-store` 的概念，服务端会话没有对应物，硬加只会接一个假动作。
- **② 命中点歌触发词 ⇒ 去我们的曲库搜整曲顶上**。
  - `matchMusicTrigger`：**这句话里要含一个点歌触发词**（面板可改的 `takeoverTriggers`）才去搜歌。撤掉"看回答"之后，**这张表就是唯一的点歌判据**，词填宽了闲聊也会招来放歌：模拟时我说了句「今天天气怎么样」，酷我库里**真有一首就叫《今天天气怎么样》**，相似度 100%。默认表因此刻意不收单个"放"字（"放假""星期放"会误开）。已知的漏口：「我想听你说个笑话」这类**含触发词但不是点歌**的句子会去搜歌（多半 `no-hit` 不动），真撞上就把那个词从表里摘掉，不在这里堆黑名单。
  - 过了这道门才去 `takeoverSources` 那几台源搜（最多三台、一次 10 条，**用去掉触发词的那半句**去搜），候选曲名与这句话的相似度 `1 - 莱氏距离/较长串`，并且**互相包含即算同一首**（口令"稻香"vs 曲名"稻香 (Live)"时编辑距离会拖到阈值下；只认长度 ≥2 的一侧，**且长的那方不能比短的多出 4 个字以上** —— 实测过「播放 一首绝对不存在的歌名QQZXTY」靠"包含"配上真歌名《不存在的》打出 100%，那是抢播不是点歌）。低于 `fuzzyMatchCutoff` 就不投。
  - **门槛默认 0.75**（2026-10-09 用 16 条真实形状的口令在判据上扫出来的）：对的那些全是 100%（相等或包含命中），该拒的最高 67%（打错字的"喜欢您"→《喜欢你》），共用尾缀的垃圾 60%（"稻香这首歌"→《青春这首歌》）—— 分数分不开这两类，而**抢播错歌比不抢更糟**，所以取 0.75；0.85 在这批上结果一样。已知门槛救不了的一类：「放一首还没听过的歌」会配上真歌名《没听过的歌》打到 100%（那是语义问题，不在这里堆词表）。
  - **候选还要"像整曲"**（`takeoverMinTrackSec`，默认 90 秒，面板可改，**0 = 关掉这层**）：同名剪辑版/铃声版在我们候选里也会出现，先保证"手里这条是整曲"。判据**只用"过短就不选"，不用"时长不等就拒"**——我们自己元数据的时长也会错（现成例子：`试听片段不落库: kw:440613 实际=224s 期望=304s`），拿不到时长（0）也一律放过，宁可漏筛也不清空候选。被挡掉的条数会写进判据理由（"另有 N 条被'像整曲'的门槛挡掉"），否则面板上只显示"没搜到"，管理员分不清是真没有还是被自己填高的门槛清了。
- **③ 都对不上就什么都不做**。可选的 LLM 那层**没接**：AI 凭据现在只在浏览器 localStorage、服务端拿不到，要做得先把凭据落 `AppSetting`——那是另一件事，不在这里偷偷加。

**顶上那一首只放一遍**（2026-10-09）：接管走的是 `startCast({ current: {uid, durSec}, rest: [] })` —— `rest` 是空的，所以到边界没有下一窗来盖它，收口就是 `stop` + 清会话。`durSec` 必须一起传（来自搜索那条的 `interval`）：会话拿它算边界，拿不到才退化成"设备报的时长 > 兜底 240 秒"。不这么做的话它会**把这首歌从头循环**（真机就是这样，用户报"接管后默认是循环播放的"），成因与修法见 §4.7.2 那两条尾巴规则。想留循环仍然是可能的：前端按"单曲循环"模式投（`loopOne: true`），那条路径不定点、也不收口。

**真机验到哪一步**：早先这里写的"真实的一条口令至今没进过这条链"**已作废** —— 那是 Cookie `deviceId` 填错导致的假 0 条（§4.7.3）。修好后真口令走到了判据并落了账目：他连着说了两次「播放七里香」，两行都判 `answered`、"没动（它办成了）"，而设备当时正在放 `duration=30024ms` 的片段 —— **这一类旧判据看不见，也正是这次撤掉"看回答"的理由**。用它在他真机上验过的其余几条：控制词但无会话 ⇒ 判 `control`、"没动（交回小爱）"、一条指令都不发；有会话时"小声一点" ⇒ 音量 43→33、"音量调到 25" ⇒ 25（**起点是现读的**，音量会漂）；「稻香」+ 回答"没有找到" ⇒ 搜到 `kw-440613`、100% ⇒ `startCast` 顶上，设备 `status=1`、`posSec` 从 10 走到 13；「今天天气怎么样」⇒ `not-music`，一次搜索都不发。**改成"命中就抢"之后的这一版还没在他耳边验过。**

另外记两条**实测到的设备事实**（④B 要用）：小爱自己播歌那条路径上 `getPlayStatus` 回来的 **`title` 是空的**（两次读都空，所以"看标题里带不带试听版"这条便宜路不成立），而 `duration` 报得准（30024 / 221753 毫秒，位置 6 秒走 6.7 秒是实时的）、`audio_id` 是小米自己的长数字（能认"是不是我们推的那条"，判不了整曲）。

面板仍带**模拟口令**入口（`askSimulate`，只 admin）：把合成的"你说/小爱答"喂进同一条判据与执行链，账目里明确标 `合成`，开关关着时照样只判不动（模拟不是后门）。留着的理由不是"真话拉不到"，而是**"回答留空"这类形状在真话里再也复现不出来**，对照实验要做得靠它。

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
| GET/HEAD | `/api/audio?uid=&quality=` | **音频流主入口**：三级命中（库→缓存→回源），支持 Range，假地址自动换源 | opt（匿名仅放行分享 st token）；未认证+无 Range+像取图（`UA=Dalvik/*` 或 `Accept` 含 `image/`）的 GET → 302 到 `/api/cover/<uid>`，为车机卡片拿封面 |
| POST | `/api/music-url` | 获取播放直链（`{musicInfo, quality}`），带跨平台换源 toggle 信息 | user |
| GET | `/api/download?uid=&quality=` | 单曲下载（uid 模式，文件名后端组装） | user |
| POST | `/api/download` | url 模式下载兼容（`{url, filename?}`） | user |
| GET | `/api/download/batch?uids=&quality=` | 批量下载 ZIP（≤100 首，store 模式零压缩） | user |
| GET | `/api/random?size=30` | 从已入库曲目随机抽歌 | user |
| POST | `/api/recognize` | 听音识曲：body 为 PCM（Int16LE/48kHz/单声道/4~12s），返回前 3 候选 | user |

### 5.2 搜索与发现

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/api/search?source=&keyword=&page=&limit=` | 音乐搜索；`source=all` 五源并发汇聚，结果去重入库并附 uid。失败口径分两半：**上游把某个平台拒了 ⇒ 502 `SEARCH_FAILED`**（`source=all` 部分源失败仍是 200，另带 `failedSources`），**我们这边的基础故障（入库/参数/程序错）⇒ 500** | user |
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
| GET/POST | `/api/admin/sources/probe` | 周测状态 / 立即跑一批周测（POST 返回 202） |
| GET/POST | `/api/admin/source-advice` | 周测建议 / 固化所选（`action=apply`，只认 id）/ 撤销上次固化（`action=undo`，逐字节还原配置原文） |
| GET/POST/PUT | `/api/admin/source-discovery` | 候选列表 / 动作（`probe`、`probe-batch`、`import`（撞同名时 `mode`：`replace` 换掉库里那条 / `parallel` 并排装）、`dismiss`、`prune`、`crawl`、`drain`、`stop`、`search`、`freshness`）/ 扫描清单与 token |
| GET/POST | `/api/admin/speaker` | 小爱音箱网关：状态视图（只回脱敏尾巴）/ 动作（`qrStart` 出二维码、`qrPoll` 问一次扫码状态、`devices` 刷新设备列表、`setManaged`、`setEnabled`、`setHost`、`setQuality`、`status`、`control`、`volume`、`play` 试推、`convSet`/`convList` 对话轮询与回显（见 §4.7.3）、`askSet`/`askLog`/`askSimulate` 语音接管的设置·账目·模拟口令（见 §4.7.5）、`logout`） |
| GET/POST | `/api/speaker` | 登录用户级投放：`GET` 返回可投音箱、就绪位与**当前会话**；`POST` 的 `action` = 投放 `cast`/`castRest`/`castSkip`/`seek`/`castStatus`/`castStop`，遥控 `pause`/`resume`/`stop`/`volume`，单推与排障 `play`/`status`（见 §4.7.2） |
| GET/HEAD | `/api/speaker/stream?st=&uid=&quality=[&seek=秒]` | **只出 MP3** 的音箱流出口（`st` 必须第一位；`seek` 恒在最后，按帧对齐后整条 200 发剩余部分，见 §4.7.2）。库内不是 MP3 就改走在线取 MP3 档，在线也给不出就明确 415（不做转码，见 §4.7.4） |
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
- `components/admin/`：8 个 Panel 对应管理端 8 个 Tab（Users/LoginLocks/Sources/SourceDiscovery/Recommend/RecommendTask/Cache/Speaker），Tab 清单集中在 `frontend/src/routes/AdminPage.tsx` 的 `TABS` 数组里，有效 tab 值由它派生（加页签只改一处）。
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

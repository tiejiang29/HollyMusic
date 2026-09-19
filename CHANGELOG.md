# 更新日志

本项目所有重要变更均会记录在此文件中。自 v0.18.0 起由发布流水线基于提交记录自动生成并维护，无需手工更新；每个版本的完整说明也可在 [GitHub Releases](https://github.com/redcatH/HollyMusic/releases) 查看。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [v0.17.0] - 2026-08-06

首个提供 Docker 镜像与版本 tag 的发布，涵盖此前全部功能：

- **多源聚合播放**：QQ / 网易 / 酷我 / 酷狗 / 咪咕统一搜索，音质回退（`flac24bit → flac → 320k → 128k`），音源热重载
- **服务端磁盘缓存 + 边下边播**：音频服务端落盘，HTTP Range 支持，浏览器原生 seek / 暂停 / 恢复；多用户共享缓存，LRU 自动清理
- **用户系统**：多用户数据隔离、签名 Cookie（HMAC-SHA256）鉴权、admin 用户管理、登录安全加固
- **AI 能力**：AI 协助建歌单（用户侧）、AI 推荐任务（admin）
- **Subsonic 协议兼容**、**一键分享**、**PWA**、**Docker 一键部署**

> v0.17.0 之前的完整提交历史可执行 `git log v0.17.0` 查看。

## v2.1.1（2026-09-19）

**完整对比**：[v2.1.0 → v2.1.1](https://github.com/redcatH/HollyMusic/compare/v2.1.0...v2.1.1)

### 🔧 工程与依赖

- **release**：同步 v2.1.0 更新日志与版本号
- **release**：v2.1.1


### 🧩 其他变更

- 修掉分享页 500：读库边界的 MusicInfo 不再交出 undefined types

现象（NAS 生产日志）：GET /api/share?uid=tx-002NmjQb4DhZr6 → HTTP 500，
`TypeError: Cannot read properties of undefined (reading 'map')`，堆栈落在
app/api/share/route.js 的 pickShareQuality。

根因不在分享页一处：MusicInfo.types 在接口里声明为必填数组，但 data 列存的是上游原样
JSON，lib/db.ts 有 5 处 `JSON.parse(row.data) as MusicInfo` 盲转——重建索引、
scripts/push-music-info 批量导入、老版本写入的行都可能整个缺掉 types 键。于是任何
`mi.types.map(...)` 都会抛：/api/share 是其中一条，Subsonic stream（lib/subsonic-stream.ts
的 supportedQualities）同形。所以修在读库边界，而不是逐个调用点补 ?? []。

- lib/db.ts：新增 normalizeMusicInfo，仅在 types 不是数组时补 []（只动这一个字段——它是
  唯一被无条件解引用的；_types 声明是必填四项的 Record，补 {} 反而不合法也不诚实）
- app/api/share/route.ts：pickShareQuality 的参数改为可选并落 `types ?? []`，把函数自己
  注释里承诺的「无 types 信息时兜底 320k 交上游决定」真正兑现，不依赖调用方是否归一化
- 测试：lib/db.test.ts +2（缺 types 的行补空数组且其余字段原样透出；非数组同样归零、
  合法数组不动）；新增 app/api/share/route.test.ts（types 缺失/为空 → 200 且 quality=320k
  带 st；有 types 时 320k→128k→首个 的挑选顺序；查不到歌与无 uid 的降级页）
- 验证：typecheck 通过、60 文件 / 603 测试全绿、lint 0 error；dev server 实跑本地同类行
  tx-000cFsFl1o17jp / tx-003J6p942xp6ho → 分享页 200 + quality=320k，再按页内 st 拉流
  得 206 audio/flac（首块魔数 fLaC）
- 取址瀑布加单源累计预算，头源挂起不再让整首歌必败

实测出来的缺陷（HANDOFF「源可用性摸底实测」一节有全过程）：往 priority 0 插一个永不
返回的假音源，/api/audio 首字节 20030ms 后 502，两首样本全失败——排在后面的可用源
一次都没轮到。不是"多等一会才跳"，是这首歌必然播不出来。

根因是三处预算对不上：单次 getMusicUrl 15s、整条瀑布 45s（music-source-manager），
而外层 audio-serve 等解析结果只有 20s（AUDIO_CACHE_READINESS_TIMEOUT_MS）。挂起的源
能在 flac/320k/128k 三档上各烧 15s 吃满 45s，外层 20s 先炸。45s > 20s 意味着总预算
这个值一直形同不存在。

- 新增一级 perSourceMs（默认 8s，跨音质档累加）：一个源在一首歌上花完它就 continue outer
  换下一个源，而不是终止整条瀑布；单次调用的上限改为 min(urlMs, 本源剩余, 全程剩余)，
  所以"放弃"发生在预算点上，不会让在途调用再拖 15s
- 总预算 45s → 18s，让不变式成立且可读：单源 < 总预算 < 外层 20s。瀑布现在一定在外层
  判死之前自己给出结论
- 三个值改为 env 可读（SOURCE_URL_TIMEOUT_MS / _PER_SOURCE_TIMEOUT_MS / _TOTAL_TIMEOUT_MS），
  15s/45s 此前是硬编码常量——不可注入也就不可测，这正是预算错配能长期潜伏没人发现的原因。
  readUrlBudgets() 在 perSourceMs ≥ totalMs 时 warn：这种配法不会报错，只会悄悄让后面的
  源永远轮不到
- 测试：新增 lib/music-source-manager.test.ts（注入假实例与预算，不碰配置文件与 runner）。
  核心用例是头源挂起时断言「挂起源只被调用一次 + 第二源出货 + 远低于 20s」；另有一条钉住
  三级预算不变式。61 文件 / 607 测试、typecheck、lint 0 error 全过
- 真实 dev 复跑同一实验：挂起头源 20030ms/502/0-2 → 8833ms/206/2-2，日志「获取音乐URL超时:
  探针挂起源 - flac（8s）」

剩下的 8s 用户仍然感知得到，那是下一刀"早对冲"（同平台约 2s 无结果就并发下一源）要解决的。
- 源健康账本 3b-1：按 源×平台 记账 + /api/health 出口（纯观测，零行为变化）

运行时此前对"哪个源能用"是零记录：瀑布里每个源的成败只进日志（大半还是 debug 级，
生产看不到），成功路径连耗时都不记。于是"源可用性分析"没有地基——本提交只补地基，
不动任何取址决策（按档跳过属于 3c）。

- lib/server/source-health.ts：纯内存零依赖账本，键是 音源×平台（一个源对 kw 强对 tx 弱
  是常态，pt 白名单就是这个经验的粗粒度手工版；音质只记不排，样本太稀）。每键 50 样本
  滑动窗 + band 分档（no-data/healthy/degraded/cooling），延迟取窗口分位数。不落库：分钟级
  信号，重启清零本身就是最干净的紧急回滚，持久校准归周测
- 三条护栏（都是 2026-09-19 摸底换来的，任何一条失效 3c 就会误杀好源）：
  ① 版权/能力不符（pt 不含、脚本未声明平台或音质、返回空地址）不计坏，只累计 noMatch；
     且这类跳过连样本都不建，避免"版权面窄但音质好的源"被算成坏源
  ② 缓存与音乐库命中不入账——结构性保证：埋点只在瀑布和 openUpstream 里，两者都只在
     miss 路径执行；否则热门歌会被刷成 100% 并稀释真实信号
  ③ 本机网络故障（ENOTFOUND/EAI_AGAIN/ECONNREFUSED…，含 fetch 的 cause 包装）开 60s 豁免
     窗，期间"坏"直接丢弃、"好"照记；否则断一次网就把 10 个源一起冤枉熔断
- 一次播放里同一个源最多记一个坏样本：同一首歌会在多个音质档上重试同一个源，全记会把
  consecutiveBad 灌水成"一首歌 = 三次坏"
- 字节段是账本里唯一能识破"有地址但播不了"的一段，也是最高置信的坏证据。为此把 provider
  抬到 inflight entry 上，并给解析契约补 platform（跨平台换源后平台 ≠ cacheKey 里的 source，
  不回传就会把 tx 的失败记到 kw 头上）；四个入口经 manager 透传，无 provider 时不记账
- 出口复用现成的 getHealthStatus → /api/health 的 sources[].health（声明与实际并排），
  summary 加 degraded/cooling 两个计数；不新增端点、不动 schema、不动配置写路径
- 测试 +12（账本 11：维度隔离/滑窗出清/三条护栏/分档/空 provider 不建键/排序与分位数；
  埋点 1 + 既有断言加固：瀑布与假地址换源确实落账）。全量 62 文件 / 619 测试、typecheck、
  lint 0 error
- dev 实测：5 次真实取址后 /api/health 显示 长青SVIP×kw band=healthy 样本=5 p50=321ms
  p90=474ms；同时暴露出马太效应——10 个源里只有 1 个有数据，正是周测不可省略的证据
- 音源面板加"健康"列：把内存账本的运行实测显示出来（3b-2，仍零行为变化）

数据接口复用现成的 GET /api/admin/sources：listSourcesWithStatus 顺手挂上
sourceHealth.ofSource(...)，不新增端点、不加轮询接口。面板按 `源×平台` 显示分档色签
（正常/波动/冷却中/样本少），悬浮 title 给完整数字：窗口内出货/坏/无地址计数、
p50 与 p90 延迟、最近一次坏的原因。

两个坑都钉进测试与注释：
- 账本的键沿用 manager 的同一个回退 `name || path`。直接用可能为 undefined 的 name 会
  让面板对所有源都显示"无实测"——数据在账本里但界面上看不见（第一版就踩了这个，
  typecheck 抓到）
- "无实测"不等于"坏了"：健康路径下瀑布通常第一个源就出货，排在后面的源天然没有样本。
  列头 title 与组件注释都写明了，避免管理员把"没数据"读成"这源不行"顺手停用它

新增 lib/services/source-manager-service.test.ts：用真实 config + 造样本的方式验证键匹配
（含 name 缺省回退 path 的分支）。全量 63 文件 / 620 测试、typecheck、lint 0 error；
面板模块经 Vite 编译通过。注：数据通路已验证，界面像素级效果未经人眼确认（本地没有
管理员会话），下一个 admin 会话里扫一眼即可。
- 健康列补渲染测试：无管理员会话也能验证这一列显示对不对

上一笔只验到"数据通路 + Vite 能编译"，界面效果没确认（本地 admin 口令不是默认值，
没有管理员会话，也没去向你要密码）。这里用 react-dom/server 直接渲染 HealthCell，
把管理员最容易误读的三点钉成测试：
- 没数据 → 「无实测」，且不得出现任何坏暗示的文案/配色
- 四个分档各自的中文标签与配色类（正常/波动/冷却中/样本少）
- 悬浮 title 必须带上判定依据：窗口次数、出货/坏/无地址、p50 与 p90、最近一次坏的原因
再加一个多平台用例（kw 正常 + mg 冷却中 + tx 样本少 各自成签，互不覆盖）

为此把 HealthCell 导出（整页面板要 mock 异步加载，测渲染反而不如直接测这个单元格准）。
前端测试新增 4 条：11 passed。同时确认 frontend/vitest.config.ts 的 components/**/*.test.tsx
这条 include 一直是空跑的——现在有了第一个用例，路径约定也就落地了。
- 摸底工具：全矩阵探测「源×平台」的取址与首块真伪

实时账本是被动记账，瀑布止于首次成功，实测面板只有 1/31 格有数据——3c 要定的
阈值（连续坏几次跳、冷却多久、半开放几个）没有数据可依据。这个脚本把 62 格填出来。

判据口径与生产一致：取到地址后还要发一次 Range 首块请求，用 audio-sniff 的
CONTAINER_TESTS（不是管扩展生命名的 CONTAINER_TYPES）判真伪——只取址会漏掉「地址给了、
Content-Type 谎称 audio/mpeg、真取是 404 文本页」这一类最坑的故障。
- 3c：瀑布按健康账本跳过冷却中的源，排序不动、同平台保底留一个

账本从只观测变成会动作。参数来自全矩阵摸底 62 格：0 次取址超时，坏样 p50 1031ms/
max 2224ms，健康源取址 p50 0-1860ms、单次成功最大 4558ms——所以熔断只看跨歌连续坏次数
（2 次），不按延迟分位数（那会砍掉最慢但真出货的 gdstudio，而它是 mg 唯二来源之一）；
快速失败冷却 60s，挂起类 5min，半开失败 2^n 翻倍封顶 30min。

半开槽位是租约式的，且 no-address / unverified 也归还槽位：版权没命中不等于探测失败，
否则一次异常退出能把源永久锁死。

顺带修掉摸底暴露的一个真缺陷：单源预算耗尽后仍剩 0-1ms「尘埃预算」时照样又调了一次源，
生产上那是一次真实脚本调用，promise 被放弃而 runner slot 还占着。
- 修判序：容器魔数先于「整段可打印」的文本判据

isPrintableRun 的注释写着"已知容器在调用前已排除"，代码里却是 isTextLike 排在
detectContainer 前面。'fLaC' + ASCII 填充这种头 32 字节全可打印的载荷会被判成文本假地址
→ 真音频被误 reject，还连带触发一次无谓换源。真实文件头部一般带 0x00 才侥幸没炸。

写周测的首块验证时被这条咬到（测试夹具用 ASCII 填充），顺带确认生产路径同样会误判。
- 周测：主动探测「源×平台」全矩阵并落库，给 3c 提供跨重启的先验

3b 的账本是内存态、且只看得到被瀑布轮到的源（实测面板 1/31 格有数据），所以每次
重启 3c 都全盲。周测把这 62 格主动跑一遍写进 SourceProbeResult，启动时把 TTL 内
判坏的格子用 seedCooldown 注回账本——只设冷却、不伪造成功样本，到期照常半开，
一次真实成功即彻底解除，所以先验判错最多浪费一首歌。

探测走 manager 新增的 probeSourceUrl（单源、不写账本）：复用 excludeProviders 那条路
会把探测抖动记成用户遇到的坏，而且瀑布在头源出货后短路，被测源根本轮不到。每格都补一次
Range 首块验证——只取址漏掉「地址给了、CT 谎称 audio/mpeg、真取 404」这一类。

启动接线必须由取址侧模块实例做：Next 给 instrumentation 单独一套 lib 副本，从那边写
内存账本路由读不到（实测日志说注入 3 格而 /api/health 恒为 cooling:0），且它那份 manager
会再拉一个 runner 子进程。现挂在 MusicSourceManager.initialize() 末尾，每进程一次。

实测：一批 58 秒 / 62 格 / 56 出货 6 坏（6 坏全在聚合API，与摸底一致）；重启后
「聚合API × kw,tx,wy」以 cooling 出现在路由侧账本，剩 57.6s，出处写明来自周测。


## v2.1.0（2026-09-19）

**完整对比**：[v1.0.7 → v2.1.0](https://github.com/redcatH/HollyMusic/compare/v1.0.7...v2.1.0)

### ✨ 新增功能

- **stats**：播放统计 v2——画像按歌曲合并跨副本计数，新增 /api/stats/song-plays
- **album**：专辑搜索/详情/整张播放下载（一期 wy kw mg）
- **discovery**：歌单广场标签对齐洛雪（wy 分类目录/kw 标签树/默认排序）
- **frontend**：推荐页标签分类面板对齐洛雪
- **album**：专辑板块重构为本地中文专辑库
- **album**：本地专辑库随仓库分发并打包进 Docker 镜像
- **album**：专辑封面支持（本地库无封面数据的补偿方案）
- **album**：画像推荐每歌手最多 2 张，保证一屏歌手多样性
- **album**：热门专辑接口（热歌榜反推）+ 本地专辑匹配收紧
- **album**：专辑封面三级降级（CAA 权威封面→服务端推导→占位）
- **album**：取消推荐/随机/热门，专辑搜索本地未命中自动平台兜底
- **album**：专辑搜索兜底与封面/年份增强切换到 Apple（iTunes Search API）
- **search**：搜索接口类型化（歌曲/歌手/专辑）+ 歌手板块 + 维基简介
- **artist**：歌手头像从维基百科获取（服务端代理转发）
- **album**：专辑封面改服务端中转（字节缓存）
- **album**：Apple 专辑封面服务端中转接口 /api/album/apple/cover（字节直出+24h 缓存），歌手详情专辑网格/搜索平台卡/详情头图三处切换
- **artist,album**：Wikidata 结构化档案聚合（艺人+专辑）
- **artist**：Apple Music 官方歌手头像（国区直连，无需代理）


### 🛡️ 安全修复

- **security**：音源脚本子进程沙箱加固，回源 URL 增加 SSRF 校验


### 🐛 问题修复

- **cover**：库内空封面启动自动回填，封面缓存版本升到 3
- **guess**：画像稀疏榜单枯竭时用兜底池补足到请求数量
- **album**：专辑搜索质量优化（wy 端点/重排/跨源去重/kw 扩池）
- **discovery**：酷狗歌单完整标签树对齐洛雪
- **frontend**：分类标签面板改为下拉浮层交互
- **discovery**：QQ 隐私歌单详情返回明确的不可访问文案
- **album**：随机专辑池过滤杂牌
- **security,perf**：审查批次一至三修复（SSRF/句柄/背压/缓存上限/竞态/节流）
- **security,perf**：AI 歌单生成接口限速每用户每小时 10 次；getPic 在途合并 + 10 分钟短缓存防并发重复签名上游请求
- **frontend**：搜索联想按结果类型取对应语料（专辑=本地专辑库前缀、歌手=singer 联想、歌曲=原有）
- **album**：曲目匹配加歌名校验与专辑版本优先
- **album**：本地搜索标题噪声过滤 + 封面/详情缓存互通
- **wiki**：歌手国别 中华民国→中国台湾
- **wiki**：消歧义页检测与自动重搜（张杰等常见人名命中'可以指'页面时追加'歌手'精确定位）
- **artist**：同名歌手专辑列表精确到 artistId + 维基档案仅主结果展示


### ⚡ 性能优化

- **album,artist**：歌手/专辑详情并行化与维基链路提速
- **wiki**：限速按主机分开计时（wikipedia/wikidata 互不阻塞）+ 去除重复 polite 实现
- **album,artist**：曲目解析改批量写入（全并发搜索+单次入库）


### 📝 文档

- docs：新增系统架构与接口文档 ARCHITECTURE.md

面向未接触过代码的读者，按代码现状（v0.23.0 / 2026-09-19）整理：五个撑起架构的设计
决策、运行拓扑（dev 双进程 / 生产 nginx + Next standalone :3001）、分层与目录导览、
音源瀑布与假地址拦截时序、audio-serve 的三级命中与跟随交付语义、七类缓存一览、认证与
安全边界、83 个 route.ts 的完整接口参考、数据模型、测试与部署。

与既有文档的分工：接口增量契约看 docs/ANDROID_API.md，运维注意事项与待办看 HANDOFF.md。


### 🔧 工程与依赖

- **release**：同步 v1.0.7 更新日志与版本号
- **album**：画像推荐默认 12 张（上限 30），避免一次推送过多
- chore：忽略本地草稿目录 my/ 与工具产物 .qoder-credits/

my/ 是内置头像与个人主页原型的设计草稿，.qoder-credits/ 是会话 token 报告产物，
两者都不属于服务端代码。与 HANDOFF.md、docs/ANDROID_API.md 同类（本地维护、不进
公开仓库），归到同一段落下。
- **release**：v2.1.0


### 🧩 其他变更

- 三源架构一期：酷我全链（搜索/歌手/专辑）+ 本地专辑酷我快路径

- 新增 kw-chain-service：wapi 免鉴权主通道 + www Secret 备通道（LCG 异或）+ r.s 专辑详情，搜歌手/搜专辑/歌手详情三件套/专辑曲目全接口，热门歌 rid 直接可播
- /api/search type=artist/album 酷我优先、Apple 回退，卡片带 source 字段
- 新路由 /api/artist/kw/detail 与 /api/album/kw/tracks，失败按名字应急钥匙回落 Apple
- 本地专辑详情酷我快路径：一次拿整张 rid 按名+时长匹配本地曲目顺序，未命中回落五源 batch 兜底
- 前端 /artist/:source/:artistId 双链路由，歌手页酷我百科简介+官方头像+100 热门歌，专辑页三模式
- 播放自动换源复用既有跨源机制，kw uid 天然覆盖
- 酷我链修正：专辑卡片补 img 双口径字段（歌手页封面修复），热门歌分页加载

- KwAlbumCard 增加 img（与 pic 同值），前端统一消费 img；artistInfo/artistAlbums/artistDetail 缓存键升版
- 歌手页热门歌首屏 30 首逐次加载（kw 链单次 100 首，避免长列表一铺到底）
- 酷我专辑封面跨源降级：kw直链→服务端解析(kw专辑/搜索pic→Apple按名)→占位

- 新增 /api/album/kw/cover（字节代理+24h缓存），resolveKwAlbumCoverUrl 两级酷我解析，Apple 按名兜底
- 封面域名白名单补 kuwo 直域（img1/img4/star.kuwo.cn，原仅 kwcdn 段匹配不到实际域名）
- 前端 KwAlbumCover 组件两级 img（直链0成本→代理端点），接入搜索/歌手/专辑三页
- 歌手页热门歌改标准分页（每页30首，上一页/下一页），替代加载更多堆积
- 三源架构二期：咪咕全链（免登录）+ 搜索层三源编排

- 新增 mg-chain-service：咪咕全链适配器（搜歌手/搜专辑/歌手三件套/专辑两件套），
  全部免登录（网页登录墙仅为前端行为）；songId 与现有 mg 播放源同构直接可播，
  audioFormats 音质徽标现成；column id 假成功防御（专辑搜索过滤+详情按名降级兜底）
- 新增 source-chain 编排器：酷我无完全匹配自动切咪咕（完全匹配=繁简归一名字相等），
  两链均无走 Apple，全空回落模糊结果；type=artist 与专辑 platformList 接入
- 新路由 /api/artist/mg/detail、/api/album/mg/tracks、/api/album/mg/cover（跨源封面降级）
- 本地专辑快路径升双链 kw→mg→batch，共享曲目匹配器
- 前端 ChainAlbumCover 通用两级封面组件，三页 source 感知 mg，专辑页新增简介块
- 咪咕数字专辑（column）原生链：resourceinfo+by-contentids 两请求整张

- getMgAlbumDetail 对 6009 前缀 id 分流专栏链：resourceinfo.do 专辑元信息+
  曲目contentId（免登录）→ by-contentids 批量补全标准 songItem（时长/音质）
- column 卡不再依赖 kw 按名降级，曲序以专栏为准，假成功防御保留
- 实测太阳之子 464ms 13 曲全 mg-{songId} 直接可播
- 专辑封面端点统一：kw/mg 合并为 /api/album/cover?source=&albumid=&name=&singer=

- source 只决定第一跳（kw=r.s pic / mg=详情含column），内部跨源链：本源直查→kw按名→mg按名→Apple按名→404
- 删除未推送的 /api/album/kw/cover 与 /api/album/mg/cover，前端三页 proxySrc 同步替换
- apple 卡片仍走 /api/album/apple/cover（collectionId 直查）
- Apple tier 升级 amp-api 全链 + 歌手页 MV 区

- 新增 apple-amp-service：token 从网页 JS 包自动提取（401 续命）、amp 搜索
  （map 格式实体在 resources.artists，按精确名锚定）、歌手详情一发全包
  （官方头像/生日/24热歌/专辑/10MV，cn 目录 bio 为空仍走维基）、专辑乐评
- 接线：source-chain apple 层与歌手/专辑详情 amp 优先、老 iTunes API 回退，
  对外契约零变化
- 新端点 /api/artist/apple/mvs：30 秒预告 m4v 免鉴权直链，任何链歌手页可挂；
  前端 MV 区块+弹窗播放，无 hls.js 依赖
- 头像链升级：官方照直链（kw/mg/amp）→ apple SSR 端点 → 维基 → 占位
- TX 主链上线：QQ音乐全链，编排顺序 tx→kw→mg→apple

- 新增 tx-chain-service：smartbox 歌手卡（官方头像T001）+ App协议热门歌
  （singer mid 精确过滤，同名免疫）+ 专辑聚合（T002封面公式）+ GetAlbumSongList
  一次整张 + MV列表（fcg_singer_mv 免登录），全部接口实测免鉴权
- source-chain 三链并行预取 tx 优先；/api/artist/tx/detail 与 /api/album/tx/tracks
  降级链 kw→mg→apple；统一封面 tx 分支公式直出；本地专辑快路径 tx→kw→mg→batch
- 歌手简介维基兜底（musics.fcg 传输层已破但模块层登录门，预研结论存档）
- 前端三页 source 感知 tx，TX MV 区用自带列表免二次请求
- TX 主链简介提速：维基依赖移除，kw百科→mg summary 免代理快速简介 + 三路并行

- source-chain 新增 getFastArtistBio：酷我百科 → 咪咕搜索 summary（300ms 级，无代理依赖）
- tx 详情路由改三路并行（详情/简介/MV 同发），总延迟≈最慢一路
- 实测：林俊杰/陈奕迅冷启动 1.4s 带 60 热门歌+12MV+简介（原 2.2s+维基串行）
- 修复 TX 歌手页打不开：前端 artistId 校验放宽为字母数字（tx mid 如 0025NhlN2yWrP4 非纯数字）
- TX 主链原生简介补齐：fcg_get_singer_desc（XML）+ 专辑 v8 信息接口（desc/公司/发行日）

- 歌手简介：c.y.qq.com/splcloud/fcgi-bin/fcg_get_singer_desc.fcg（免登录，
  format=xml 才有数据；/base/ 路径已 404 是此前误判）——1455字百科全文+basic档案生日，
  路由改为原生简介优先、kw/mg 快速简介兜底（四路并行）
- 专辑详情：换 fcg_v8_album_info_cp.fcg 主路径（曲目+desc简介+公司+发行日一次全），
  GetAlbumSongList 降为兜底；playable 透出 bio/company/year/profile
- 感谢 sansenjian/qq-music-api 开源项目提供的正确接口路径线索
- 听音识曲上线：网易 shazam_v2 指纹引擎 + TX 可播匹配

- lib/recognize：指纹器（sandbox.bundle+afp.wasm，48kHz 输入）走 spawn 子进程
  （Next 打包破坏 wasm 路径），PCM 临时文件传递（Windows 管道截断）
- POST /api/recognize：Int16 PCM → 指纹 → 网易 match（免鉴权 form 格式）→
  前3候选 → TX 搜歌附可播 uid
- 前端 RecognizeDialog：麦克风 8 秒/文件上传双模式，候选列表点击播放，
  搜索页波形按钮入口；麦克风需 HTTPS（文件识曲不受限）
- 端到端：晴天副歌 3 候选全命中可播，正弦波正确空结果，~1.1s
- 识曲兼容任意采样率/声道：44.1k→48k 重采样 + 立体声归一（安卓实测场景）
- 识曲静音检测与错误细化：RMS<100 判静音给明确提示，避免'编码失败'误导
- 识曲结果歌名清洗：剥 DJ版/翻唱/AI/饭制/装饰括号，用干净歌名搜原曲提高命中率
- 识曲候选去翻唱化：歌名清洗后只搜歌名不搜翻唱歌手，展示 TX 真实命中结果

- findPlayable 只用清洗后歌名搜 TX（不带候选里的翻唱歌手名），TX 热门排序自然命中原曲
- 命中后用 TX 搜歌的真实歌手/专辑覆盖网易候选的翻唱信息
- 识曲候选去重：多候选搜到同一首歌（同uid）只保留第一个
- 识曲升级双引擎：酷我 8k PCM 主引擎（直接返回 kw-{rid}）+ 网易 shazam_v2 兜底

- 主引擎酷我：48k PCM 降采样 8k → base64 trait → discern/inner/info（免登录）
  → 直接返回 kw-{rid} 可播歌曲，与 kw 链完美对接
- 归一化系数无关紧要（实测 3 种幅度全部命中）
- 网易 shazam_v2 降为兜底引擎（酷我未命中时走原路径）
- 实测：晴天全曲 48k PCM → 酷我主引擎 1.5s 命中 kw-228908 周杰伦原曲
- 识曲弹窗文案去掉引擎来源描述
- 收藏歌单功能：复制公开歌单到自己名下

- POST /api/playlists/[id]/collect：复制歌单名+全部歌曲条目到自己名下，
  comment 标记来源（收藏自 xxx），原歌单删除不影响副本
- 前端歌单详情页：非 owner 显示收藏按钮（Bookmark），owner 显示删除按钮
- 权限：仅公开歌单可收藏，不能收藏自己的；删除/AI加歌按 owner 显示
- 端到端：test收藏admin公开歌单 → 副本75首带来源标记 → 重复收藏400
- 最近播放歌单/专辑功能：RecentContext 表 + 前端上报 + 首页入口

- RecentContext 模型（Prisma 迁移）：username + itemType(playlist|album) + itemId 唯一
- POST /api/recent-contexts：播放时上报上下文（歌单页/专辑页自动触发，fire-and-forget）
- GET /api/recent-contexts?type=playlist|album|all：分 type 查询最近记录
- 首页 RecentContexts 组件：歌单/专辑分 tab 横向卡片，点击直达歌单/专辑页
- 歌单页 playWithContext 包装播放上报；专辑页播放按钮内嵌上报
- 后端增强：内置头像 + Playlist.collected 字段区分收藏歌单

- User.avatar Int?（内置头像索引 1~10），PUT /api/auth/avatar 更新，
  GET /api/auth/me 透出 avatar
- Playlist.collected Boolean（收藏歌单标记），collectPlaylist 设 true，
  不再写 '收藏自 xxx' 前缀到 comment；PlaylistSummary 透出 collected
- 迁移 add_avatar_and_collected
- 收藏与专辑板块增强：专辑收藏 + 专辑详情契约修正 + 歌单 collected 口径

专辑收藏（新增功能）
- Favorite 表 +3 个可空列 name/singer/img 作展示快照——专辑不在本站曲库，无法像歌曲那样靠 id 回查富化，收藏时随行落快照供列表直接渲染；迁移 20260916150000_album_favorite_snapshot
- /api/favorites 系列新增 type=album 分支（POST/GET/DELETE/check），不传 type 仍是歌曲收藏，旧客户端零改动；重复收藏只刷新快照不新建
- Subsonic /rest/star|unstar 支持 albumId，快照由服务端按代表曲存储键回查；getStarred2 的 album 段与 getAlbumList2?type=starred 对站外专辑用快照补节点
- 修掉取消收藏只按 userId+itemId 删记录的缺陷：本站歌曲 id 与专辑 id 同为 source-{key} 形态可能是同一字符串，会误删另一类型收藏，现按 itemType 收窄
- 前端：专辑详情页收藏按钮（进页 check 定初始态）+「我的收藏」页歌曲/专辑双 tab

专辑详情契约修正
- /api/album/{tx,mg}/tracks 响应补 singer 字段。此前只有 kw 链做过 artist→singer 映射，tx/mg 直接下发上游原名，客户端按 singer 读到空——表现为专辑页标题只剩首数没有歌手名、封面兜底 URL 的 singer=undefined、最近播放上报 owner 为空、收藏快照 singer=null。现与 kw 对齐，singer/artist 同时下发；详情缓存键升版 tx:albumPlayable:v4 / mg:albumPlayable:v2

歌单 collected 口径
- POST /api/playlists 新增可选 collected 参数；Subsonic /rest/createPlaylist 建的表统一 collected=true；import 与 import-remote 创建的副本补齐 collected 标记（此前裸调 createPlaylist 漏标，副本落在「自建歌单」分组）
- 新增回填迁移 20260916141500_backfill_playlist_collected，按历史副本特有的「收藏自 」comment 前缀标回 true，幂等

专辑板块改平台链
- 专辑搜索链改为 TX → 酷我 → 咪咕 → Apple，新增 TX 专辑搜索；/api/search?type=album 的 list 恒为空、结果全在 platformList（卡片带 source）；suggest 联想语料改用 TX 专辑搜索
- 删除 /api/album/local/{search,suggest,cover,tracks} 四个端点与 album-db/ 两个库文件，及 ALBUM_DB_PATH / ALBUM_TRACKS_DB_PATH 环境变量
- 酷我链歌曲补齐音质元数据（此前 types/_types 恒空导致同平台取址必然失败）

测试：新增专辑收藏与歌单口径相关测试文件，全量 54 文件 / 498 测试通过
- 修复 CI lint 在配置解析阶段崩溃：react-hooks 覆盖规则缺 files 作用域

- eslint-config-next 的 next 预设只在 **/*.{js,jsx,mjs,ts,tsx,mts,cts} 内声明 react-hooks 插件，而 React Compiler 降级规则块未限定 files，规则会落到 .cjs 等预设未覆盖的文件上 → ESLint 报 "could not find plugin react-hooks" 并以 exit 2 中止，lint 起跑即挂，typecheck/test/build 全部跳过
- 触发条件是识曲功能引入的 lib/recognize/worker.js（CommonJS spawn 子进程脚本）；该文件与 sandbox.bundle.cjs（npm 包 ncm-audio-recognize 提取的 bundle）均不参与构建图，现加入 globalIgnores
- 本地全链验证：lint 0 error、typecheck、54 文件/498 测试、next build（Turbopack）与 frontend build 全部通过
- 源管理 3a：假地址拦截与音乐库入库门槛

音源瀑布只认「返回非空地址」为成功，部分音源对无版权/VIP 歌曲返回 HTTP 200 的
HTML/JSON/垃圾数据，被当成功遮蔽后面的好源；这类垃圾字节还会进缓存、并被「边听边
下」提升进永久音乐库（库优先于在线源且无自愈路径，一旦登记坏文件这首歌就永远播不
了）。对库内 302 个文件双判据实测：「时长探测失败」占 38.4% 但都能正常播，不能当
门槛；「容器魔数嗅探」只否掉那 1 个真坏文件，零误伤——故门槛建在魔数上。

- 新增 lib/server/audio-sniff.ts：三档判定 audio / reject / unverified，字节证据优先
  于 Content-Type（音源 CT 普遍不可信，实测有 audio/mpeg; charset=UTF-8 标 mp3、
  application/octet-stream 标真 flac 的情况）
- audio-serve 新增 openUpstream（解析 → fetch → 读首块 → 嗅探）：reject 时把该音源
  加入排除集重新解析，上限 AUDIO_FAKE_URL_RETRIES（默认 2），上游非 2xx 同样触发。
  关键时序是嗅探发生在 entry.size 置位之前，客户端响应要等 waitForReadiness 才构造，
  换源对播放器零感知；unverified 正常交付并进缓存，但跳过 post-cache 不入库
- music-source-manager 新增 getMusicUrlWithProvider 回传命中音源名，
  _getMusicUrlSamePlatform 支持 excludeProviders；getMusicUrl 签名不变，旧调用零改动
- music-library 的 ingestFromCache 与 rebuildLibraryIndex 都要求嗅探为 audio 才登记
- resolver 契约改为 (excludeProviders) => Promise<string | {url, provider}>，
  /api/audio、/api/download/batch、subsonic-stream 三个入口获得换源重试能力
- 测试：audio-sniff 59 项（含 200 组随机数据误判率 <10%）+ music-library 4 项
  （getAudioServeConfig/getLibraryConfig 是模块级单例，env 必须在 import 前设置）
  + audio-serve 补 5 项。单测顺带抓到 MPEG 帧同步的 `&` 与 `!==` 优先级 bug
  （(x>>3)&0x03!==0x01 被解析成 (x>>3)&(0x03!==0x01)，判据原本完全失效）

验证：typecheck 通过、59 文件 / 590 测试全绿
- 安全加固：scrypt 密码哈希 + Subsonic 独立令牌 + SSRF 逐跳护栏 + Prisma 单例收敛

Web/App 登录密码此前与 Subsonic 凭据是同一个字段（明文存 subsonicSecret，为了兼容
md5(secret+s)），等于登录口令以明文落库。本轮把两者拆开，并补上几处审计项。

- SEC-1 凭据分离：新增 User.passwordHash（scrypt，格式 scrypt$N$r$p$salt$hash，
  node:crypto 零新依赖，N=16384/r=8/p=1）+ 迁移 20260917120000；subsonicSecret 改为
  每用户随机令牌，仅供 /rest 的 t=md5(令牌+s)。新增 lib/server/credentials.ts
  （hashPassword/verifyPassword/verifyUserPassword/buildCredentials/generateSubsonicToken，
  用户不存在时烧等价耗时 scrypt 以防用户名枚举）。登录走惰性迁移——passwordHash 为空的
  老用户按明文校验通过后就地落哈希并轮换令牌；改密落哈希 + 轮换令牌 + sessionVersion+1。
  令牌唯一获取入口是新增的管理员接口 POST /api/admin/users/[id]/subsonic-token
  （只在响应里显示一次）。Web/安卓登录契约不变，Subsonic 客户端需改用令牌
- SEC-2 SSRF 逐跳护栏：新增 lib/server/url-guard.ts（isPublicIp/assertPublicHttpUrl 从
  source-manager-service 抽出 + safePublicFetch）。不可信来源的抓图抓文件一律改
  redirect:'manual' 逐跳校验——原 redirect:'follow' 可被「公网 URL 302 跳内网」绕过。
  接入 cover/subsonic-metadata/album-service/cover-backfill/image-proxy（白名单只约束
  首跳，CDN 换主是常态）/download/import-remote。播放热路径 audio-serve 与 wiki-service
  暂未套，需配合真源回归再做
- BUG-1/2：audio-serve 的 void ensureInitialized() 补 .catch（未处理拒绝会直接终止 Node
  进程）；/api/recognize 的 500 不再回传 error.message（会带出指纹器/子进程/文件路径）
- PERF-1：15 处各自 new PrismaClient() 收敛到 lib/db.ts 单一实例（globalThis 守卫让 dev
  热重载复用，避免连接池与句柄泄漏）
- PERF-2：setRecommendedBatch 由 Promise.all 逐条 update 改成分块 200 的 updateMany，
  消除 SQLite 写锁竞争下「成功数随机掉」
- 测试：新增 credentials(10)、url-guard(7)、login/route(6)，重写 change-password 测试
  （断言 scrypt 格式 + 令牌轮换 + 明文不出现在写入数据里）；README 安全说明同步

验证：typecheck 通过、59 文件 / 590 测试全绿
- 最近歌单支持平台歌单：itemId 前缀约定，后端零改动

此前只有专辑页和站内歌单页会上报「最近歌单」，从歌单广场打开平台歌单不留痕。定为
纯客户端方案：平台歌单上报时 itemId 用与专辑同款的 source-id 前缀形态（如
wy-18129092448），itemType 仍是 playlist——RecentContext.itemId 本就是自由字符串
（schema 注释里就写了该约定），upsert 键天然不与站内纯数字 id 撞。

- DiscoveryCollectionPage：进入 kind=playlists 的详情即上报（与站内 PlaylistDetailPage
  同款时机），img 用 detail.cover 上游原值——广场封面没有服务端相对路径形态
- RecentContexts.to()：playlist 分支识别前缀，纯数字 → /playlists/:id，带前缀 →
  /discover/playlists/:id?source=；否则安卓侧写入的行在 Web 上是点不开的死卡
- 榜单（toplist）刻意不报：打开路由是 /discover/toplists，报了会在历史里长出打不开的卡

验证：typecheck 通过、前端 7 测试通过
- 启动预热 trending，消掉首页冷启动第一跳

安卓侧建议给 /api/discover/trending 与 /api/recommend/guess 套 5 分钟 TTL 缓存，
核实后两个端点本来就有缓存（trending 是 searchCache 10 分钟，空结果刻意不缓存以便
上游抖动重试；guess 是按用户的当日缓存，画像+完整榜单每天只算一次、分页直接切片），
5 分钟 TTL 是 no-op。真正的痛点是内存缓存重启即空。

改为 instrumentation.ts 启动 5 秒后台拉一次 getTrending(20) 填掉第一跳：20 与两端默认
参数一致（缓存键含该值），delay 让路给启动期的迁移与 config-sync，失败静默——首开会
自然重试。实测重启后 [startup] trending 预热完成: 77 首，首开从秒级降为缓存命中。

遗留：guess 的当日缓存同样在内存里，每次重启后每用户首调仍要重建画像（实测约 1s）；
要彻底消掉需把当日缓存落库，未实施。
- 入库与响应 Content-Type 以嗅探容器为准，纠正音源谎报

全库实测：228 个 `.mp3` 命名的音乐库文件里 115 个（50%）真实容器是 FLAC（反向 0 例）。
根因是定名定头这条链完全依赖上游 Content-Type，而音源的 CT 会撒谎——3a 立论时已经知道
「字节证据优先于 Content-Type」，但那时只有真伪判定用了字节，命名仍照抄 CT。后果是库内
正本叫 .mp3 的 FLAC 文件成堆，库里 serve 时 contentTypeForFile 又按扩展名发头，一路把
audio/mpeg 发给客户端（Web 的 <audio> 自己嗅探所以听不出来，下载落地和按 MIME 选解封装
的客户端会受影响）。

- audio-sniff 新增 CONTAINER_TYPES（容器 → {mime, ext} 单一真源）与 extFromContainer /
  mimeFromContainer / extFromAudioMime / mimeFromAudioExt 四个导出。刻意不收 mp4/asf/
  avi/realmedia/midi：这些容器可能装视频（源会把 MV 当音频链路返回），不覆盖上游声明
- audio-serve 的 openUpstream 把 entry.contentType 改为字节 MIME 优先，认不出容器才回落
  上游声明，不符时记一条 info。这一处同时修好缓存文件名、AudioCache.contentType 行与响应
  头三处；extFromContentType 对本表不认识的 MIME 回落到容器表，免得两份表各说各话
- music-library 入库扩展名优先取嗅探到的容器：存量 AudioCache 记录里仍是假的 audio/mpeg，
  只改上游不够；contentTypeForFile 同样回落容器表，库内播 .ape/.dsf 不再发 audio/mpeg
- 副带：源常发的非规范 audio/x-flac 统一成 audio/flac
- 测试 +7（表覆盖 / 视频容器不覆盖 / null 回落 / MIME↔ext 同源 / FLAC 字节配 audio/mpeg
  三处一致 / mp4 字节不改声明 / 谎报记录入库 .flac）。全量 59 文件 597 测试、typecheck
  通过、lint 0 error；真机以未缓存的 kw-5035019 走通：响应头 audio/flac，入库
  Bandari - 初雪.flac（15,158,033B）

未做：那 115 个存量误命名文件的重命名回填（要动库里真实文件并改 LibrarySong.filePath）
- 新增存量回填脚本：音乐库正本按真实容器改名

上一笔只修好了往后的入库，修好之前已经入库的文件仍是假名字（本地实测 228 个
`.mp3` 命名的正本里 115 个真实容器是 FLAC）。

- 默认 dry-run，加 --apply 才落盘；幂等（名字已相符就是 no-op）
- 魔数表与 lib/server/audio-sniff.ts 的 CONTAINER_TYPES 一一对应，可承载视频的容器
  （mp4/asf/avi/realmedia）一律不动
- 改名同时迁移歌词边车（.lrc / .tlyric.lrc 与音频同目录同名）；EPERM/EBUSY 重试
  3 次（Windows 下 dev 或播放器正读着该文件）；登记行更新失败则把文件改回原名，
  不留指向旧名的死路径
- 目标名已被占用时只报告不改名——重复正本是要人看一眼的数据问题，不是命名问题
- 顺带审计（只报告）AudioCache 里谎报的 contentType：它只影响缓存命中时的响应头
- 裸 node 可跑（自动从 .env 补 DATABASE_URL），NAS 上同一个脚本直接执行即可

本地执行记录：303 条中 115 条 `.mp3`→`.flac`，零冲突/零占用失败/零缺失；改名前已复制
prisma/data/music.db.bak-20260919-153413。复验 kw-228908 从库播放返回 206 audio/flac
（此前是 audio/mpeg）。
- 回填脚本顺带纠正 AudioCache 谎报的 contentType

跑完库内改名后审计出 2 行缓存记录的 contentType 与字节不符（audio/x-ogg 标着 FLAC
字节）。同属「照抄上游 Content-Type」这一类缺陷，并到同一个脚本的 --apply 里，NAS
上一条命令即可两层都修。

- 只改 contentType 一列，不动缓存文件名：那名字是 cacheKey 哈希出来的，没有下游按它的
  扩展名取 MIME，改名反而会让并发的重下载算出新路径、把旧文件留成孤儿
- 同一次 --apply 仍保持 dry-run 默认与幂等：本地复跑为「库内 303/303 相符、缓存 0 条不符」
- 本地实测两行已纠正，tx-003Haf8k2E6fYX / tx-004WrpV81DMGHv 从缓存命中均返回 audio/flac


## v1.0.7（2026-09-09）

**完整对比**：[v1.0.2 → v1.0.7](https://github.com/redcatH/HollyMusic/compare/v1.0.2...v1.0.7)

### ✨ 新增功能

- **player**：频谱无分析数据时降级为合成动画
- security hardening + playlist import + cross-platform toggle
- Kugou gcid personal playlist import (cookie-based scraping)
- Kugou gcid import via signed mobile API (75/75 songs, no cookie needed)
- **player**：play mode popover menu + lyrics page redesign
- **leaderboard**：独立排行榜页，全量 180 榜单，收藏榜单为歌单
- **download**：下载入口补全 + 批量 ZIP 流式打包
- **library**：边听边下服务器音乐库（持久化 + 浏览页 + 本地优先播放）
- **library**：本地优先音质裁决纳入平台可用音质
- **ui**：加入歌单快捷入口（歌曲行/播放栏/移动端菜单）
- **library**：歌手列表纳入全部参与歌手
- **library**：歌曲行改标准布局 —— 封面前置 + 收藏/加歌单/播放按钮后置
- **library**：行内补齐单击播放 / 加入播放队列 / 下载
- **library**：批量下载 + 歌手字母序排列 + 歌手栏独立搜索
- **library**：专辑独立成列 + 搜索框入头部 + 拼音首字母搜索
- **search**：搜索联想（输入实时下拉，点选直接搜索）
- **search**：联想补艺人搜索源，短词多位歌手
- **player**：底栏当前歌词行 + 频谱降级为背景层
- **player**：底栏歌词行升级卡拉OK填充 + 字号加大 16/18
- **discover**：推荐页改为洛雪样式歌单广场
- **discover**：酷狗歌单广场补齐五档排序（推荐/最热/最新/热藏/飙升）
- **android**：一期 MVP 原生客户端（Compose+Media3），模拟器全链路验证通过
- **search**：/api/search 支持 source=all 五源服务端汇聚
- **android**：搜索默认全部档（对接服务端 source=all 五源汇聚）
- **android**：搜索结果提示失败音源（对接 v1.0.4 failedSources）
- **android**：音乐库频道改为服务端音乐库歌曲（/api/library，边听边下）
- **android**：音乐库歌手索引 + 搜索（歌手chips筛选、拼音首字母、300ms防抖）
- **search**：本地音乐库并入搜索（本地Tab + 顶部本地匹配区）
- **discover**：大家都在听 + 推荐歌单按类型聚合（移动端首页成型接口）
- **discover**：trending 提至每平台 20 首；groups 改跨平台类目聚合（含儿歌）
- **audio**：/api/audio 增加登录鉴权与分享页 st 匿名旁路
- **harvest**：本机采集导出 + 批量推送脚本与管理端导入接口
- **history**：播放历史增加 playCount 字段
- **recommend**：猜你喜欢——个性化推荐接口与 Web 首页区块
- **identity**：曲库同款歌分组，换源本地优先毫秒级命中
- **dedup**：搜索/随机/猜你喜欢同曲去重，猜你喜欢封面兜底


### 🛡️ 安全修复

- **security**：交接与接口文档停止入库，改本地维护


### 🐛 问题修复

- **player**：修复 iOS PWA 退后台停播
- **covers**：cross-platform cover fill + album name on import
- **sources**：repair mojibake script filenames, harden upload naming
- **docker**：compose healthcheck 改用 node fetch（新运行时镜像无 wget）
- **library**：多歌手合并名目录/去重键修复 + 存量迁移脚本
- **library**：登记时长以文件探测为准 + 扩展名按实际内容 + 存量时长修复
- **library**：歌手栏搜索支持拼音首字母
- **auth**：config-sync 移至服务端启动钩子（修复面板部署无法登录）
- **perf**：搜索页切回/导航数秒卡顿修复（实验定位 + 双修）
- **search**：联想歌手置顶，避免被歌曲挤出上限
- **android**：会话 Cookie 三件套持久化 + 播放改 /api/audio 代理流
- **android**：搜索框字被裁半——去掉硬压 46dp（M3 OutlinedTextField 最小高 56dp）
- **discover**：榜单封面全量抓取——tx/kw 去掉 common 过滤
- **discover**：kw 榜单封面兜底 v9_pic2——43 榜全量有图


### ⚡ 性能优化

- **docker**：shrink image ~1GB → ~300MB uncompressed


### 🎨 界面与样式

- prefer-const for wyTracks (fix CI lint)


### 📝 文档

- **compose**：修正示例注释（Docker Hub 镜像/版本 tag 示例过时）
- **api**：补猜你喜欢/随机/历史接口文档；忽略本地 dev 日志


### ✅ 测试

- 补 music-library mock（下载路由单测适配本地优先播放）


### 🔧 工程与依赖

- **deps**：升级 tailwindcss 4.3.3 + vitest 3.2.7
- 移除误提交的空 node.js 文件
- gitignore 忽略 Next.js dev 日志与 GUI 测试截图
- add GitHub Actions Docker build & push to Docker Hub
- **release**：v0.23.0 版本号管理
- **release**：v1.0.0 —— fork 版本线独立
- **release**：同步 v1.0.0 更新日志与版本号
- **release**：v1.0.1（config-sync 启动时机修复）
- **release**：同步 v1.0.1 更新日志与版本号
- **release**：同步 v1.0.1 更新日志与版本号
- **release**：v1.0.2
- **release**：同步 v1.0.2 更新日志与版本号
- **release**：v1.0.3 + Android 接口文档
- **release**：v1.0.4 预备 + 接口文档按版本写明更新记录
- **release**：同步 v1.0.3 更新日志与版本号
- **release**：同步 v1.0.4 更新日志与版本号
- Android 客户端拆分至独立仓库 HollyMusic-Android
- **release**：同步 v1.0.5 更新日志与版本号
- **release**：同步 v1.0.6 更新日志与版本号


### 🧩 其他变更

- **player**：取消卡拉OK逐字填充，歌词行改为加粗主题绿
- 同步 v1.0.3 更新日志（release bot）



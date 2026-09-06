# HollyMusic 开发交接文档（HANDOFF）

> 用途：新会话/新工作区接续开发时先读这份。读完可删除或保留。

## 项目概览

HollyMusic：自部署音乐服务器（tiejiang29/HollyMusic，fork 自 redcatH/HollyMusic）。
Next.js 16 后端（App Router, standalone 输出，需 --webpack 因 Turbopack regression）+ Vite 6/React 19 SPA（frontend/）+ SQLite/Prisma + LX Music 音源脚本。
别名：`@` → 仓库根，`@@` → frontend/src。包管理器 **pnpm**（不是 npm）。

## 本地开发环境（2026-09-06 迁移后）

- **仓库位置：`D:\dev\HollyMusic`**（从 C 盘 workspace 迁出，旧目录已删）
- 开发服务：`next start`（:3000）+ `frontend/ vite preview`（:4173），从 D 盘启动
- 版本：v1.0.2 已推送（tag 独立于上游 v0.24.x，走 v1.x 线）
- Android SDK：`D:\dev\android-sdk`（API 35，build-tools 35.0.0，default x86_64 镜像）
- JDK 17：`C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot`（JAVA_HOME 已持久化）
- Gradle 8.9：`D:\dev\gradle-8.9`
- 模拟器加速：AEHD 2.2 已装并运行（emulator -accel-check exit 0）
- AVD：medium_phone（API 35）
- android-emulator 插件已启用并验证可用（enabledPlugins + options 均已写入 ~/.zcode/cli/config.json；MCP server smoke test 通过，23 个工具）

## 工作规则（用户明确要求）

1. **不推送**：改完本地提交，等用户确认后再 push（"记住以后都先不上传，等我这边确认完了再上传"）
2. 推送时顺手打 `v*` tag（用户认可 v1.x 独立版本线）
3. 大功能先讨论再动手（"先讨论"是高频指令）
4. GitHub 有 release bot 会提交 CHANGELOG，push 被 reject 时先 `git fetch && git rebase origin/main`
5. **Web/服务端会话不得动 android/ 目录**（用户明确要求）：不修改、不格式化、不 stage 该目录下任何文件；git 操作避免 stash/checkout/reset 等会波及其工作区的命令（该目录已 .gitignore，属 Android 独立仓库）

## Android 原生客户端（一期 MVP 已跑通，已拆独立仓库）

**独立仓库：https://github.com/tiejiang29/HollyMusic-Android（私有）**——android/ 目录已从主库移除追踪（.gitignore），后续 Android 开发都在那边提交推送；主库只保留 design/（UI 设计规范与原型）与服务端。

用户决定：**Kotlin + Jetpack Compose + Material 3 原生开发，不用 WebView**（嫌 Web UI 上安卓难看）。

### v1.0.3 文档吸收（2026-09-06 完成，docs/ANDROID_API.md）

- **播放链路已改 `/api/audio?uid=&quality=` 代理流**（弃 music-url 直链）：服务端本地优先（音乐库→缓存→在线）+ Range/seek，ExoPlayer 经 OkHttp DataSource 带 Cookie 直播，实测 44.1kHz started
- **启动会话校验已用 `/api/auth/me`**：cookie 存在→联网校验→过期回登录页
- 文档与代码三处口径不符（以代码为准）：歌词参数实为 `?id=`（非 uid）、搜索无 `source=all`（只有 kw/kg/tx/wy/mg）、收藏 check 返回 `{starred}`（非 isFavorite）——客户端实现均已按代码口径

### MVP 状态（2026-09-06 模拟器全链路验证通过 ✅）

**工程**：`D:\dev\HollyMusic\android\`（包名 com.tiejiang.hollymusic，AGP 8.5.2 + Kotlin 2.0.21 + Compose BOM 2024.09 + Media3 1.4.1）
- 构建：`cd android && gradle assembleDebug`（JAVA_HOME=jdk-17、gradle=D:\dev\gradle-8.9\bin；wrapper 已生成，distributionUrl 指腾讯镜像——services.gradle.org 直连校验会失败）
- APK：`android/app/build/outputs/apk/debug/app-debug.apk`（约 22MB）

**已验证闭环**（模拟器 medium_phone + 本地 next start :3000，模拟器内用 http://10.0.2.2:3000 访问宿主）：
1. 登录（服务器/账号/密码，✕ 清空钮）→ Cookie 会话持久化（DataStore），重启免登录 ✅
2. 首页四频道：推荐（toplists common 卡+playlists 推荐歌单横滑）/ 音乐库（三色快捷卡+收藏）/ 排行榜（toplists full）/ 收藏 ✅
3. 搜索：5 音源 chips（kw/tx/wy/kg/mg）+ 结果（"jay"→酷我 3294 条真实结果）+ 联想 ✅
4. 播放：music-url → ExoPlayer（OkHttp DataSource 共享 Cookie）→ AudioTrack 44.1kHz 真实出声 ✅
5. 迷你播放条随播联动 → 播放页（Palette 封面取色魔法渐变+呼吸封面+进度+左右滑歌词 LRC 滚动）✅
6. MediaSessionService 前台服务已注册（通知栏/锁屏控制待真机验）

**关键坑（已修，新会话别再踩）**：
- **会话 Cookie 是三件套**：holly_user + **holly_sv**(sessionVersion) + holly_sig，缺 holly_sv 会 401（签名校验不过）。持久化/恢复必须三条全套
- **/api/auth/me 无会话也返回 200**（data.authenticated=false），判定登录态要看 username/authenticated 字段，不能只看 HTTP 码
- Compose `padding()` 不允许负值 → 色晕用 `offset()`
- ApiEnvelope.data 必须声明 `JsonElement?`（服务器 data 是对象，声明 String? 必 PARSE 失败）
- adb input text 的 `!` 会变形——测试密码避开特殊字符；DEL 连发清空不可靠，输入框一律带 ✕ 清空钮
- uiautomator dump 会给过期快照，验证以截图/服务器日志/dumpsys audio 为准
- **OkHttp 应用拦截器(addInterceptor)在 CookieJar 注入 Cookie 头之前执行**——看真实出网头要用 addNetworkInterceptor
- AGP 8 默认不生成 BuildConfig，要用需 buildFeatures { buildConfig = true }

**测试账号（用户指定，端到端测试一律用它）**：用户名 `test`，密码 `abcd=1234`（本地 :3000 已验证可登录；**NAS :3099 尚未建此账号**，真机验收连 NAS 前需先建号或用真实账号）。adb input text 密码含 `=` 可直传无变形。

### UI 设计（已定稿 v3.1）

- **UI 参照 QQ 音乐 11.0**（uisdc.com/qq-music-2 + 用户提供的两张 QQ 音乐真实截图）
- **v3 信息架构（用户指定）**：底部只留「首页/我的」双 tab；首页顶部横滑切换「推荐/音乐库/排行榜/收藏」+ 搜索框；「我的」= 用户卡（右上角齿轮进设置）；搜索为覆盖式二级页
- 设计语言：浅色通透 + 荧光绿渐变 #55E6A4→#1FC774 + 轻拟物 + 播放页/迷你条封面取色魔法渐变（androidx.palette 实现）
- 产物：`design/UI-DESIGN.md`（v3 规范）+ `design/prototype/index.html`（浏览器原型，双击即看）

### 客户端对接口径（与 docs/ANDROID_API.md 一致）

- 统一响应 `{success, data|error:{code,message}}`；登录 `POST /api/auth/login` → Set-Cookie holly_user/holly_sig（HttpOnly，30天）
- 搜索 `GET /api/search?source=&keyword=&page=&limit=`（source ∈ kw/kg/tx/wy/mg）；联想 `GET /api/search/suggest?keyword=`
- 播放 `POST /api/music-url {musicInfo, quality}` → `data.url`（相对路径拼 baseUrl）；歌词 `GET /api/lyrics?id=`（LRC 原文）
- 封面 `GET /api/cover/{uid}`（公开）；榜单 `GET /api/discover/toplists?scope=full`、详情 `/toplists/{id}?source=`
- 歌单 `GET /api/discover/playlists?limit=`、详情同款；收藏 `GET/POST/DELETE /api/favorites`
- 音质回退在服务端完成（quality 传首选档即可）

### 二期待做

歌单管理、下载到 Music/HollyMusic/、播放队列 Sheet、播放模式（顺序/单曲/随机）、深色主题、桌面小组件、CI 出 APK、真机验收后适配国产 ROM 后台策略
- 服务端可选改动：登录接口加发 Bearer token（当前 Cookie 方案已可用，非阻塞）

## Web 端近期完成（v1.0.2 已含）

- 底栏当前歌词行（加粗主题绿 16/18px，行切换动画，点击开歌词页；卡拉OK逐字填充试过已回退——LRC 行级时间戳含停顿导致滞后）
- 频谱降级为播放条背景层（footer 需 isolate 建层叠上下文，opacity 25% 有效值）
- 搜索联想（歌手置顶/艺人源 type=100/本地库，250ms 防抖，键盘导航）
- 搜索页导航秒卡修复（React 19 transition+大树 mount：客户端分页 30/页 + setTimeout 延迟导航）

## 服务器部署（用户 NAS）

- SSH root@172.16.1.7（BusyBox NAS），应用目录 /mnt/scsi0.1-1/Configs/hollymusic/（config、custom-sources、prisma_data）+ 数据卷 /mnt/scsi0.2-1/hollymusic/data，端口 3099
- config-sync 已改为启动时执行（instrumentation.ts），初始密码缺失类问题已修

## 坑位备忘

- Windows Git Bash 会吃 PowerShell 的 `$_`/`$var`——复杂 PS 逻辑一律写 .ps1 文件执行
- Git Bash 启动模拟器必须先 `export ANDROID_SDK_ROOT=D:\dev\android-sdk`，否则 FATAL "Cannot find AVD system path"（ANDROID_HOME 单独不够）
- MCP 工具集在会话启动时确定——新启用插件后必须重启/新开会话才能注入 `mcp__android_emulator__*`
- sdkmanager licenses 要 `yes |` 管道（逐个许可证提问）
- winget 已无 Gradle 包，从 services.gradle.org 直接下 zip
- 旧 Android 项目的残留 adb 在 workspace android_tools/（已被 SDK 版本取代）

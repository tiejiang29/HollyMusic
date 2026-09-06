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

## Android 原生客户端计划（进行中）

用户决定：**Kotlin + Jetpack Compose + Material 3 原生开发，不用 WebView**（嫌 Web UI 上安卓难看）。

### UI 设计阶段（2026-09-06 完成 v3，待用户确认）

- **UI 参照 QQ 音乐 11.0**（uisdc.com/qq-music-2 官方改版文章 + 用户提供的两张 QQ 音乐真实截图）
- **v3 信息架构（用户指定）**：底部只留「首页/我的」双 tab；首页顶部横滑切换「推荐/音乐库/排行榜/收藏」+ 搜索框；「我的」页 = 用户卡+四入口+最近播放横滑卡+自建/收藏歌单，**设置移到右上角齿轮**；搜索为覆盖式二级页
- 设计语言：浅色通透 + 荧光绿渐变 #55E6A4→#1FC774 + 轻拟物 + 播放页封面取色魔法渐变（迷你条也随歌取色）
- 产物：`design/UI-DESIGN.md`（v3 规范）+ `design/prototype/index.html`（原型，单文件双击即看；顶部按钮可切 10 个视图）
- 已浏览器逐屏截图验证渲染
- **尚未开始写 Android 工程代码**（用户要求先确认 UI 再动骨架，且"一页一页改"）；android/ 目录还不存在
- 本地预览：双击 design/prototype/index.html；或 `python -m http.server 8931 --directory design/prototype` → http://localhost:8931/index.html

- 播放内核：Media3/ExoPlayer + MediaSessionService（锁屏/通知栏/蓝牙线控/音频焦点全原生）
- 服务端唯一计划改动：登录接口加发 Bearer token（AUTH_SECRET 签发），中间件兼容 Cookie+Bearer；ExoPlayer 用 header
- 一期 MVP：服务器配置+登录 → 搜索（含联想）→ 播放页 → 锁屏通知 → 滚动歌词 → 排行榜 → 音乐库 → 收藏 → 单曲下载到 Music/HollyMusic/
- 二期：歌单管理、批量下载、历史、桌面小组件
- 里程碑策略：先出最小闭环（骨架+登录+搜索+播放+锁屏通知）真机验证手感，再铺开
- 包名 com.tiejiang.hollymusic，应用名 HollyMusic
- 项目放 `D:\dev\HollyMusic\android\`，CI 加 Android 构建出 APK
- 迭代方式：android-emulator MCP（android_preflight → create_app/build_and_run/screenshot/ui_tap）模拟器自测 → 用户真机验收
- 服务端 API 关键点：**完整接口文档见 `docs/ANDROID_API.md`**（v1.0.3 基线：搜索/联想/音频流/歌词/广场+标签+榜单/收藏/歌单/音乐库/下载，含参数与响应结构）

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

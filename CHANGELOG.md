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



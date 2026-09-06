# HollyMusic 服务端接口文档（Android 客户端用）

> 基线版本：v1.0.6。所有接口均需登录，未登录返回 HTTP 401 + `{"success":false,"error":{"code":"UNAUTHORIZED"}}`。
> 客户端收到 401 应统一引导到登录页。

## 通用约定

- **Base URL**：用户自配（如 `http://172.16.1.7:3099`），首次启动引导填写并持久化。
- **响应包装**：`{ "success": boolean, "data": T }`；失败为 `{ "success": false, "error": { "code": string, "message": string } }`。
- **认证**：登录成功后 Set-Cookie（HttpOnly 会话）。原生端用 OkHttp `CookieJar` 持久化即可跑通全部接口；ExoPlayer 拉音频流的鉴权改造（Bearer token）计划中，改造后中间件将兼容 Cookie 与 `Authorization: Bearer` 两种方式，客户端无需变更登录流程。
- **uid 格式**：`{source}-{songmid}`，如 `tx-0039MnYb0qxYhV1`。全站统一用它标识一首歌。
- **音质**：`'128k' | '320k' | 'flac' | 'flac24bit'`。
- **Song 结构**（搜索/歌单/收藏/随机等所有歌曲列表通用）：`{ uid, name, singer, albumName, source, interval(秒), img, qualitys?: string[], _types?: Record<音质, {size?: number, hash?: string}> }`。

## 1. 认证

| 接口 | 方法 | 参数 | 说明 |
|---|---|---|---|
| `/api/auth/login` | POST | body JSON `{username, password}` | 成功设会话 cookie；错误返回 `INVALID_PARAMS 用户名或密码错误` |
| `/api/auth/me` | GET | - | `{authenticated, username, mustChangePassword}`；**无会话时也返回 200**（`authenticated:false, username:null`），客户端必须看 `authenticated` 字段而非状态码 |
| `/api/auth/heartbeat` | POST | - | 保活 |
| `/api/auth/logout` | POST | - | 注销 |
| `/api/auth/change-password` | POST | `{oldPassword, newPassword}` | 改密后旧会话失效 |

## 2. 搜索

- **`GET /api/search?keyword=&source=&page=1&limit=30`**
  - `source`: `all | local | tx | wy | kw | kg | mg`
  - **`local` 只搜本地音乐库**（v1.0.5+）：name/singer/album contains 匹配，命中条目带 `local: true` 标记（客户端加"本地"徽标）；播放走本地文件不耗流量
  - **任何平台搜索（单源/all）响应都附带 `localList: Song[]`**（前 8 条本地库匹配，`local: true`）——客户端可在结果顶部展示"本地匹配"区；localList 每次实时查库不缓存，库增删立即可见
  - **`all` 为服务端五源汇聚**（v1.0.4+）：并发五源、按 tx→wy→kw→kg→mg 顺序拼接、单源失败自动跳过（至少一源成功即返回）、聚合结果整体缓存。部分源失败时响应含 `failedSources: string[]` 可提示"结果不含 xx"；全部失败返回 502。
  - 返回 `{list: Song[], total, allPage, page, limit, source, failedSources?}`
- **`GET /api/search/suggest?keyword=`**（v1.0.2+）
  - 输入联想，250ms 防抖由客户端控制；返回 `{text, type: 'singer'|'song'|'album'}[]`，歌手项已置顶
  - 点选歌手项 → 用歌手名再调 `/api/search`

## 3. 播放与歌词

- **`GET /api/audio?uid=&quality=320k`** —— 音频流（ExoPlayer 直接播）
  - 服务端本地优先（音乐库→缓存→在线），支持 Range/seek，自动试听检测
  - `quality` 缺省 320k；传用户偏好音质
- **`GET /api/track?uid=`** —— 单曲详情（含封面/可用音质）
- **`GET /api/music/alternatives?uid=`** —— 跨源替换候选（可选功能）
- **`GET /api/lyrics?id={uid}`** —— `{lyric: LRC文本|null, tlyric: 翻译LRC|null}`（注意参数名是 `id`，值传 uid）
  - LRC 行级时间戳，纯文本歌单（tx/kw/mg 部分歌曲）`lyric` 为 `[!text]` 前缀
- **`GET /api/cover/[id]`** / 封面代理；歌单/榜单封面字段给的是完整 URL，直接加载即可（RemoteCover 逻辑已在服务端处理被拦域名）

## 4. 发现页（v1.0.3 广场全量）

- **`GET /api/discover/playlists?source=tx&limit=24&page=1&tag=&sort=&keyword=`** —— 歌单广场列表
  - `source`: `tx|wy|kw|kg|mg`；`sort`: `recommend|hot|new|collect(热藏)|soar(飙升)`（各源支持档位不同：kg 五档、mg 三档、其余两档）
  - `tag` 取值来自标签接口的 `hotTag[].id`
  - 返回 `{id, name, author, description, cover, playCount, songCount?, source}[]`
- **`GET /api/discover/playlists/tags?source=`** —— 标签（v1.0.3+）
  - 返回 `{hotTag: {id,name}[], tags: {name, list:{id,name}[]}[]}`；`tags` 可为空数组（wy/kw/kg 只有热门）
- **`GET /api/discover/playlists/{id}?source=`** —— 歌单详情 `{..., tracks: Song[]}`，tracks 可直接进播放队列
- **`GET /api/discover/toplists?source=&scope=common|full`** —— 排行榜（full=180 榜全量，含 `common` 标记常用榜）
- **`GET /api/discover/toplists/{id}?source=`** —— 榜单详情 `{..., tracks: Song[]}`
- **`GET /api/random?size=30`** —— 本地音乐库随机歌曲（做"每日推荐/随便听听"）
- **`GET /api/discover/trending?topPerSource=20`**（v1.0.6+）—— **大家都在听**：五平台热歌榜各取前 N（默认 20，tx 热歌榜/wy 热歌榜/kw 热歌榜/kg TOP500/mg 尖叫热歌榜），跨平台去重（归一化歌名+主歌手）合成一张歌单，返回 `{list: Song[], updatedAt}`；全部带 uid 可直接进播放队列；单平台失败自动跳过
- **`GET /api/discover/playlists/groups?perPlatform=3`**（v1.0.6+）—— **推荐歌单按类型聚合（跨平台）**：固定 8 类目（流行/经典/儿歌/摇滚/民谣/电子/国风/ACG），每类从五平台各拉 N 张合并为 `{tag: {id,name}, playlists: DiscoveryPlaylist[]}[]`（歌单带 source 字段），移动端首页"分区卡片"成型接口；单平台/单类失败自动跳过

## 5. 收藏 / 歌单 / 音乐库

- **收藏**：
  - `GET /api/favorites?limit=200&offset=0` → `Song[]`
  - `POST /api/favorites` body `{id: uid}` 收藏；`DELETE /api/favorites?id=uid` 取消
  - `GET /api/favorites/check?id=uid` → `{starred: boolean}`
- **自建歌单**：
  - `GET /api/playlists` 列表；`POST /api/playlists` `{name}` 新建
  - `GET /api/playlists/{id}` 详情；`PATCH /api/playlists/{id}` 改名；`DELETE /api/playlists/{id}` 删除
  - `POST /api/playlists/{id}/songs` body `{uids: string[]}` 批量加歌；`DELETE` 同路径移除
- **音乐库（边听边下，服务端持久化）**：
  - `GET /api/library` 列表 + 统计（容量/歌曲数）；`GET /api/library?singerGroups=1` 按歌手分组
  - `DELETE /api/library/{id}` 删除
  - Android 下载到本地目录（`Music/HollyMusic/`）由客户端自行管理，不依赖此接口

## 6. 下载（服务端代理流）

- **`GET /api/download?uid=&quality=`** —— 单曲文件流（Content-Disposition 附件）
- **`GET /api/download/batch?uids=a,b,c`** —— ZIP 流（串行打包，429 表示已有任务进行中）

## 7. 其他

- `GET /api/version` → `{version: "1.0.3"}`（设置页"检查更新"对齐用）
- `GET /api/health` → 健康检查（配服务器地址时用来连通性测试）

## Android 端建议的请求封装

- 统一 `ApiResult<T>` 解包：`success` 才取 `data`，否则抛业务异常（带 code/message）
- 401 拦截器 → 跳登录
- 音频流不走统一解包（是二进制），直接把 URL 交给 ExoPlayer（`DefaultHttpDataSource` 挂同一 CookieJar 或后续的 token header）

## 版本更新记录（仅列 API 变化）

### v1.0.6（本地已提交，待发布）
- 新增 `GET /api/discover/trending`：大家都在听（五平台热歌榜默认各 20 首 + 跨平台去重，实测约 76 首）
- 新增 `GET /api/discover/playlists/groups`：推荐歌单跨平台按类目聚合（流行/经典/儿歌/摇滚/民谣/电子/国风/ACG 8 类，每类五平台各 N 张合并）
- 修复：tx/kw 榜单封面全量抓取（e061bc1）+ kw 封面 v9_pic2 兜底（43 榜全量有图）
- 修复：wy 歌单广场改走 weapi 通道（上游 order=new 当前恒空，自动回退 hot；明文 GET 在服务进程内被上游返回空）

### v1.0.5
- `GET /api/search` 新增 `source=local`：本地音乐库搜索（含 `local: true` 标记）
- 所有平台搜索响应新增 `localList: Song[]` 字段：服务端附带前 8 条本地库匹配，供"本地匹配"置顶区使用
- `MusicInfo` 类型新增可选 `local?: boolean`（仅运行时标记，不入库）

### v1.0.4
- `GET /api/search` 新增 `source=all`：**服务端五源汇聚**——并发扇出五源、按 tx→wy→kw→kg→mg 顺序拼接、单源失败自动跳过（至少一源成功即返回）、聚合结果整体缓存 210 分钟
  - 部分源失败时响应新增 `failedSources: string[]`（提示"结果不含 xx"用）
  - 全部源失败返回 502 `SEARCH_FAILED`
  - 客户端从此**无需自行聚合**，单源/全部统一走本接口

### v1.0.3
- 新增 `GET /api/discover/playlists/tags?source=`：歌单广场标签（五平台，热门 + 分组，缓存 1 小时）
- `GET /api/discover/playlists` 全参数开放：`tag`（取值来自标签接口）/`sort`/`keyword`
- 酷狗歌单广场排序补齐五档：`recommend|hot|new|collect(热藏)|soar(飙升)`（其余源两至三档）
- 新增本接口文档（`docs/ANDROID_API.md`）

### v1.0.2
- 新增 `GET /api/search/suggest?keyword=`：输入联想，返回 `{text, type: singer|song|album}[]`，歌手项置顶；250ms 防抖由客户端控制
- （无其他 API 变化；底栏歌词、导航性能均为前端改动）

### v1.0.1
- 修复 config-sync 启动时机（服务端部署层修复，无 API 变化）

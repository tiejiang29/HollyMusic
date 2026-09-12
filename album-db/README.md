# 本地中文专辑库（MusicBrainz 派生）

随仓库分发的只读 SQLite 库，供专辑板块（搜索/联想/随机/画像推荐/详情倒查）使用：
- `albums_cn_simp.db`：专辑表 albums(gid, title, artist)，2.4 万张简体中文专辑
- `album_tracks_cn_simp.db`：曲目表 album_tracks(rg_gid, disc, position, title, title_norm, length_ms, recording_id)

来源：MusicBrainz 官方 dump 派生（筛选中文 + 简体化 + 噪声过滤）。运行时只读打开，
服务默认路径为 `<项目根>/album-db/`，可用环境变量 `ALBUM_DB_PATH` / `ALBUM_TRACKS_DB_PATH` 覆盖。
Docker 镜像构建时由 Dockerfile COPY 进镜像（/app/album-db）。

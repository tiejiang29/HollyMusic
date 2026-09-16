-- 回填历史「收藏歌单」标记（collected）。
--
-- 背景：collected 列由 20260915151202_add_avatar_and_collected 引入，该迁移只加列、未回填；
-- 而「收藏歌单」功能（复制他人公开歌单）早于它约 22 小时上线——那批副本落库时列还不存在，
-- 取默认值 false，导致前端把它们与自建歌单混在一起显示（前端本已按 collected 分组）。
--
-- 识别依据：收藏功能早期会给副本 comment 写「收藏自 {原作者}」前缀；同一批后端改动中
-- 该写法已废弃（新副本只继承原歌单 comment，不再加前缀），所以这个前缀只会出现在历史副本上，
-- 用它回填不会误伤自建歌单（自建歌单的 comment 由用户自己填写，不会以「收藏自」开头）。
--
-- 幂等：仅更新 collected=false 且带前缀的行，重复执行无副作用。
UPDATE "Playlist"
SET "collected" = true
WHERE "collected" = false
  AND "comment" IS NOT NULL
  AND "comment" LIKE '收藏自%';

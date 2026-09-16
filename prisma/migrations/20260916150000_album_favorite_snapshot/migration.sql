-- 专辑收藏的展示快照列（name/singer/img）。
--
-- 背景：Favorite 表本来就支持 itemType='album'，读取侧（getStarred 的 album 段、
-- albumList?type=starred）也早就写了，但一直没有写入入口——客户端星标只写 'song'，
-- 于是那些读取分支恒为空。补上专辑收藏时发现一个结构性问题：专辑是平台数据
-- （tx/kw/mg/apple 的 albumId），不在本站 MusicInfo 库里，无法像歌曲那样靠 itemId
-- 回查富化。若不落快照，「我的收藏-专辑」列表每次都要回查上游（慢且可能失败），
-- 而 Subsonic 侧只能拿 id 当专辑名显示。
--
-- 因此把展示所需的三个字段随收藏一起落库（只对 album/artist 有意义，song 留空）。
-- 全为可空列，SQLite 的 ADD COLUMN 是元数据操作，对既有 55 条歌曲收藏零影响。
ALTER TABLE "Favorite" ADD COLUMN "name" TEXT;
ALTER TABLE "Favorite" ADD COLUMN "singer" TEXT;
ALTER TABLE "Favorite" ADD COLUMN "img" TEXT;

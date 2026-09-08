-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PlayHistory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "playlistId" INTEGER,
    "entryId" INTEGER,
    "musicInfoId" INTEGER,
    "songmid" TEXT,
    "username" TEXT,
    "playedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "playCount" INTEGER NOT NULL DEFAULT 1,
    "clientIp" TEXT,
    "userAgent" TEXT
);
INSERT INTO "new_PlayHistory" ("clientIp", "entryId", "id", "musicInfoId", "playedAt", "playlistId", "songmid", "userAgent", "username") SELECT "clientIp", "entryId", "id", "musicInfoId", "playedAt", "playlistId", "songmid", "userAgent", "username" FROM "PlayHistory";
DROP TABLE "PlayHistory";
ALTER TABLE "new_PlayHistory" RENAME TO "PlayHistory";
CREATE INDEX "PlayHistory_playedAt_idx" ON "PlayHistory"("playedAt");
CREATE INDEX "PlayHistory_username_idx" ON "PlayHistory"("username");
CREATE INDEX "PlayHistory_playlistId_idx" ON "PlayHistory"("playlistId");
CREATE UNIQUE INDEX "PlayHistory_username_songmid_key" ON "PlayHistory"("username", "songmid");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

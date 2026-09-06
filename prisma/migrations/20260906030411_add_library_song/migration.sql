-- CreateTable
CREATE TABLE "LibrarySong" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "dedupeKey" TEXT NOT NULL,
    "uid" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "singer" TEXT NOT NULL,
    "album" TEXT NOT NULL DEFAULT '',
    "quality" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "durationSec" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "LibrarySong_filePath_key" ON "LibrarySong"("filePath");

-- CreateIndex
CREATE INDEX "LibrarySong_dedupeKey_idx" ON "LibrarySong"("dedupeKey");

-- CreateIndex
CREATE INDEX "LibrarySong_uid_idx" ON "LibrarySong"("uid");

-- CreateIndex
CREATE INDEX "LibrarySong_singer_idx" ON "LibrarySong"("singer");

-- CreateTable
CREATE TABLE "RecentContext" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "img" TEXT,
    "owner" TEXT,
    "playedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "RecentContext_username_playedAt_idx" ON "RecentContext"("username", "playedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecentContext_username_itemType_itemId_key" ON "RecentContext"("username", "itemType", "itemId");

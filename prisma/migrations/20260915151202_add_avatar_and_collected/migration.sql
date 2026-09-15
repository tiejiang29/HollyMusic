-- AlterTable
ALTER TABLE "User" ADD COLUMN "avatar" INTEGER;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Playlist" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "comment" TEXT,
    "public" BOOLEAN NOT NULL DEFAULT false,
    "collected" BOOLEAN NOT NULL DEFAULT false,
    "songCount" INTEGER NOT NULL DEFAULT 0,
    "duration" INTEGER,
    "created" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changed" DATETIME NOT NULL,
    "owner" TEXT,
    "coverArt" TEXT,
    CONSTRAINT "Playlist_username_fkey" FOREIGN KEY ("username") REFERENCES "User" ("username") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Playlist" ("changed", "comment", "coverArt", "created", "duration", "id", "name", "owner", "public", "songCount", "username") SELECT "changed", "comment", "coverArt", "created", "duration", "id", "name", "owner", "public", "songCount", "username" FROM "Playlist";
DROP TABLE "Playlist";
ALTER TABLE "new_Playlist" RENAME TO "Playlist";
CREATE INDEX "Playlist_username_idx" ON "Playlist"("username");
CREATE INDEX "Playlist_public_idx" ON "Playlist"("public");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

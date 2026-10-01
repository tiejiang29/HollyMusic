-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT,
    "subsonicSecret" TEXT,
    "lastLogin" DATETIME,
    "lastSeen" DATETIME,
    "lastSeenIp" TEXT,
    "lastSeenUa" TEXT,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "avatar" INTEGER,
    "bluetoothLyric" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("avatar", "createdAt", "id", "lastLogin", "lastSeen", "lastSeenIp", "lastSeenUa", "mustChangePassword", "passwordHash", "sessionVersion", "subsonicSecret", "updatedAt", "username") SELECT "avatar", "createdAt", "id", "lastLogin", "lastSeen", "lastSeenIp", "lastSeenUa", "mustChangePassword", "passwordHash", "sessionVersion", "subsonicSecret", "updatedAt", "username" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

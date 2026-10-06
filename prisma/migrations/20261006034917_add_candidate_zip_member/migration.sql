-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SourceCandidate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "repo" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "rawUrl" TEXT NOT NULL,
    "blobSha" TEXT NOT NULL DEFAULT '',
    "assetDigest" TEXT NOT NULL DEFAULT '',
    "releaseTag" TEXT NOT NULL DEFAULT '',
    "zipMember" TEXT NOT NULL DEFAULT '',
    "scriptName" TEXT NOT NULL DEFAULT '',
    "nameKey" TEXT NOT NULL DEFAULT '',
    "contentHash" TEXT NOT NULL DEFAULT '',
    "upstreamAt" TEXT NOT NULL DEFAULT '',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "score" INTEGER NOT NULL DEFAULT 0,
    "verdict" TEXT NOT NULL DEFAULT 'pending',
    "state" TEXT NOT NULL DEFAULT 'new',
    "reason" TEXT,
    "probeJson" TEXT NOT NULL DEFAULT '',
    "probedAt" DATETIME,
    "importedPath" TEXT NOT NULL DEFAULT '',
    "checkedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_SourceCandidate" ("assetDigest", "blobSha", "checkedAt", "contentHash", "createdAt", "id", "importedPath", "nameKey", "path", "probeJson", "probedAt", "rawUrl", "reason", "releaseTag", "repo", "score", "scriptName", "sizeBytes", "state", "updatedAt", "upstreamAt", "verdict") SELECT "assetDigest", "blobSha", "checkedAt", "contentHash", "createdAt", "id", "importedPath", "nameKey", "path", "probeJson", "probedAt", "rawUrl", "reason", "releaseTag", "repo", "score", "scriptName", "sizeBytes", "state", "updatedAt", "upstreamAt", "verdict" FROM "SourceCandidate";
DROP TABLE "SourceCandidate";
ALTER TABLE "new_SourceCandidate" RENAME TO "SourceCandidate";
CREATE INDEX "SourceCandidate_contentHash_idx" ON "SourceCandidate"("contentHash");
CREATE INDEX "SourceCandidate_nameKey_idx" ON "SourceCandidate"("nameKey");
CREATE INDEX "SourceCandidate_verdict_score_idx" ON "SourceCandidate"("verdict", "score");
CREATE UNIQUE INDEX "SourceCandidate_repo_path_key" ON "SourceCandidate"("repo", "path");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

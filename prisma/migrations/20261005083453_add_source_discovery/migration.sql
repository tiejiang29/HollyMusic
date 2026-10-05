-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SourceCandidate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "repo" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "rawUrl" TEXT NOT NULL,
    "blobSha" TEXT NOT NULL DEFAULT '',
    "scriptName" TEXT NOT NULL DEFAULT '',
    "nameKey" TEXT NOT NULL DEFAULT '',
    "contentHash" TEXT NOT NULL DEFAULT '',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "score" INTEGER NOT NULL DEFAULT 0,
    "verdict" TEXT NOT NULL DEFAULT 'pending',
    "state" TEXT NOT NULL DEFAULT 'new',
    "reason" TEXT,
    "checkedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "SourceCandidate_contentHash_idx" ON "SourceCandidate"("contentHash");

-- CreateIndex
CREATE INDEX "SourceCandidate_nameKey_idx" ON "SourceCandidate"("nameKey");

-- CreateIndex
CREATE INDEX "SourceCandidate_verdict_score_idx" ON "SourceCandidate"("verdict", "score");

-- CreateIndex
CREATE UNIQUE INDEX "SourceCandidate_repo_path_key" ON "SourceCandidate"("repo", "path");

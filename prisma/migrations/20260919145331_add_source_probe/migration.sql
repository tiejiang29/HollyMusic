-- CreateTable
CREATE TABLE "SourceProbeRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "total" INTEGER NOT NULL DEFAULT 0,
    "probed" INTEGER NOT NULL DEFAULT 0,
    "okCount" INTEGER NOT NULL DEFAULT 0,
    "badCount" INTEGER NOT NULL DEFAULT 0,
    "samples" TEXT,
    "detail" TEXT
);

-- CreateTable
CREATE TABLE "SourceProbeResult" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runAt" DATETIME NOT NULL,
    "source" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "songmid" TEXT NOT NULL,
    "quality" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "reason" TEXT,
    "container" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "SourceProbeRun_startedAt_idx" ON "SourceProbeRun"("startedAt");

-- CreateIndex
CREATE INDEX "SourceProbeResult_source_platform_runAt_idx" ON "SourceProbeResult"("source", "platform", "runAt");

-- CreateIndex
CREATE INDEX "SourceProbeResult_runAt_idx" ON "SourceProbeResult"("runAt");

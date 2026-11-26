CREATE TABLE "ApiInterface" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "platform" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "requestShapeHash" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL DEFAULT '',
    "keyHash" TEXT,
    "sourcesJson" TEXT NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "callCount" INTEGER NOT NULL DEFAULT 0,
    "networkCount" INTEGER NOT NULL DEFAULT 0,
    "responseCount" INTEGER NOT NULL DEFAULT 0,
    "httpOkCount" INTEGER NOT NULL DEFAULT 0,
    "addressCount" INTEGER NOT NULL DEFAULT 0,
    "lastStatusCode" INTEGER,
    "lastContentType" TEXT,
    "lastBodyType" TEXT,
    "lastCode" TEXT,
    "lastMsg" TEXT,
    "lastUrlExists" BOOLEAN,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ApiInterface_platform_endpoint_idx" ON "ApiInterface"("platform", "endpoint");
CREATE INDEX "ApiInterface_lastSeenAt_idx" ON "ApiInterface"("lastSeenAt");

CREATE TABLE "ApiInterfaceProbe" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "interfaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "quality" TEXT NOT NULL,
    "songmid" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "statusCode" INTEGER,
    "code" TEXT,
    "msg" TEXT,
    "urlExists" BOOLEAN,
    "urlHost" TEXT,
    "container" TEXT,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiInterfaceProbe_interfaceId_fkey" FOREIGN KEY ("interfaceId") REFERENCES "ApiInterface"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ApiInterfaceProbe_interfaceId_createdAt_idx" ON "ApiInterfaceProbe"("interfaceId", "createdAt");

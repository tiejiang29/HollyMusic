-- AlterTable
ALTER TABLE "MusicInfo" ADD COLUMN "identity" TEXT;

-- CreateIndex
CREATE INDEX "MusicInfo_identity_idx" ON "MusicInfo"("identity");

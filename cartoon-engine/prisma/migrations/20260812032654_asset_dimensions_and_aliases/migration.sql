-- AlterTable
ALTER TABLE "assets" ADD COLUMN "height" INTEGER;
ALTER TABLE "assets" ADD COLUMN "width" INTEGER;

-- CreateTable
CREATE TABLE "asset_aliases" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetId" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "asset_aliases_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "asset_aliases_relativePath_key" ON "asset_aliases"("relativePath");

-- CreateIndex
CREATE INDEX "asset_aliases_assetId_idx" ON "asset_aliases"("assetId");

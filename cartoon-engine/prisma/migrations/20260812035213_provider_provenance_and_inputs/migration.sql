-- AlterTable
ALTER TABLE "provenances" ADD COLUMN "envFingerprint" TEXT;
ALTER TABLE "provenances" ADD COLUMN "envFingerprintHash" TEXT;
ALTER TABLE "provenances" ADD COLUMN "modelKey" TEXT;
ALTER TABLE "provenances" ADD COLUMN "modelVersion" TEXT;
ALTER TABLE "provenances" ADD COLUMN "parameters" TEXT;
ALTER TABLE "provenances" ADD COLUMN "prompt" TEXT;
ALTER TABLE "provenances" ADD COLUMN "providerId" TEXT;
ALTER TABLE "provenances" ADD COLUMN "providerRunRef" TEXT;
ALTER TABLE "provenances" ADD COLUMN "seed" TEXT;
ALTER TABLE "provenances" ADD COLUMN "spend" TEXT;
ALTER TABLE "provenances" ADD COLUMN "workflowHash" TEXT;

-- CreateTable
CREATE TABLE "asset_inputs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetId" TEXT NOT NULL,
    "inputAssetId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "asset_inputs_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "asset_inputs_inputAssetId_fkey" FOREIGN KEY ("inputAssetId") REFERENCES "assets" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "asset_inputs_inputAssetId_idx" ON "asset_inputs"("inputAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_inputs_assetId_inputAssetId_role_key" ON "asset_inputs"("assetId", "inputAssetId", "role");

-- CreateIndex
CREATE INDEX "provenances_providerRunRef_idx" ON "provenances"("providerRunRef");

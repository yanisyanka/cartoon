-- AlterTable
ALTER TABLE "assets" ADD COLUMN "cameraAngle" TEXT;

-- CreateIndex
CREATE INDEX "assets_characterId_role_cameraAngle_idx" ON "assets"("characterId", "role", "cameraAngle");

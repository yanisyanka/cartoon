-- CreateTable
CREATE TABLE "characters" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "nameRu" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "promptLine" TEXT NOT NULL,
    "colorAnchors" TEXT NOT NULL,
    "heightRatio" REAL NOT NULL,
    "frequency" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "canon_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_assets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "relativePath" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "role" TEXT,
    "characterId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedesId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "assets_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "assets_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "assets" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_assets" ("createdAt", "id", "mimeType", "relativePath", "sha256", "sizeBytes", "type") SELECT "createdAt", "id", "mimeType", "relativePath", "sha256", "sizeBytes", "type" FROM "assets";
DROP TABLE "assets";
ALTER TABLE "new_assets" RENAME TO "assets";
CREATE UNIQUE INDEX "assets_sha256_key" ON "assets"("sha256");
CREATE UNIQUE INDEX "assets_supersedesId_key" ON "assets"("supersedesId");
CREATE INDEX "assets_relativePath_idx" ON "assets"("relativePath");
CREATE INDEX "assets_characterId_role_idx" ON "assets"("characterId", "role");
CREATE UNIQUE INDEX "assets_relativePath_version_key" ON "assets"("relativePath", "version");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "characters_slug_key" ON "characters"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "characters_number_key" ON "characters"("number");

-- CreateIndex
CREATE UNIQUE INDEX "characters_sourcePath_key" ON "characters"("sourcePath");

-- CreateIndex
CREATE UNIQUE INDEX "canon_rules_code_key" ON "canon_rules"("code");

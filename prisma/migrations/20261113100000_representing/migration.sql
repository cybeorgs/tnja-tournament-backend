-- Who a player represents (a district or a unit), for the overall championship.
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Unit_name_key" ON "Unit"("name");

ALTER TABLE "Student"
    ADD COLUMN "representing" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "representingDistrict" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "representingUnit" TEXT NOT NULL DEFAULT '';

CREATE INDEX "Student_representing_representingDistrict_idx" ON "Student"("representing", "representingDistrict");
CREATE INDEX "Student_representingUnit_idx" ON "Student"("representingUnit");

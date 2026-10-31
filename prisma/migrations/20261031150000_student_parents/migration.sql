-- Photos and BPL proof are no longer collected.
DROP TABLE "StudentDocument";
ALTER TABLE "Student" DROP COLUMN "isBPL";

-- AlterTable
ALTER TABLE "Student"
    ADD COLUMN "fatherName" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "motherName" TEXT NOT NULL DEFAULT '';

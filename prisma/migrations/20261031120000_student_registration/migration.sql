-- Running number behind Student.studentNo (see src/lib/students.ts)
CREATE SEQUENCE "student_no_seq" START 1;

-- AlterTable
ALTER TABLE "Student"
    ADD COLUMN "studentNo" TEXT,
    ADD COLUMN "taluk" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "residingPincode" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "bloodGroup" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "aadhaarNumber" TEXT,
    ADD COLUMN "alternatePhone" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "email" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "nationality" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "address" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "city" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "state" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "pincode" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "annualIncome" INTEGER,
    ADD COLUMN "isBPL" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "institutionType" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "institutionName" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "grade" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "degreeDepartment" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "coachName" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "source" TEXT NOT NULL DEFAULT 'ADMIN';

-- Give students that already exist a permanent ID, oldest first.
UPDATE "Student" s
SET "studentNo" = numbered.prefix || '-S-' || lpad(numbered.n::text, 6, '0')
FROM (
    SELECT st."id",
           nextval('student_no_seq') AS n,
           coalesce(nullif(upper(regexp_replace((SELECT "orgShortName" FROM "Settings" WHERE "id" = 'default'), '[^A-Za-z0-9]', '', 'g')), ''), 'STU') AS prefix
    FROM (SELECT "id" FROM "Student" ORDER BY "createdAt") st
) numbered
WHERE s."id" = numbered."id";

ALTER TABLE "Student" ALTER COLUMN "studentNo" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Student_studentNo_key" ON "Student"("studentNo");
CREATE UNIQUE INDEX "Student_aadhaarNumber_key" ON "Student"("aadhaarNumber");

-- CreateTable
CREATE TABLE "StudentDocument" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StudentDocument_studentId_kind_key" ON "StudentDocument"("studentId", "kind");

ALTER TABLE "StudentDocument" ADD CONSTRAINT "StudentDocument_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

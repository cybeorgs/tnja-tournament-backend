-- Students outside Tamil Nadu wait for approval before they get a permanent ID.
ALTER TABLE "Student" ALTER COLUMN "studentNo" DROP NOT NULL;
ALTER TABLE "Student"
    ADD COLUMN "status" TEXT NOT NULL DEFAULT 'APPROVED',
    ADD COLUMN "outsideTamilNadu" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "reviewNote" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "reviewedAt" TIMESTAMP(3),
    ADD COLUMN "isBPL" BOOLEAN NOT NULL DEFAULT false;

-- Emails are the login, compared lower-case.
UPDATE "Student" SET "email" = lower(trim("email"));

CREATE INDEX "Student_email_idx" ON "Student"("email");
CREATE INDEX "Student_status_idx" ON "Student"("status");

-- CreateTable
CREATE TABLE "StudentDocument" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentDocument_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StudentDocument_studentId_kind_key" ON "StudentDocument"("studentId", "kind");
ALTER TABLE "StudentDocument" ADD CONSTRAINT "StudentDocument_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "StudentAccount" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StudentAccount_email_key" ON "StudentAccount"("email");

-- A student may now enter several age groups of one tournament.
DROP INDEX "Registration_tournamentId_studentId_key";
CREATE UNIQUE INDEX "Registration_tournamentId_studentId_ageGroup_key" ON "Registration"("tournamentId", "studentId", "ageGroup");
CREATE INDEX "Registration_razorpayOrderId_idx" ON "Registration"("razorpayOrderId");

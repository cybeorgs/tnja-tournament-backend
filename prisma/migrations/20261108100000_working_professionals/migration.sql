-- Working professionals register alongside students. Existing records are students.
ALTER TABLE "Student"
    ADD COLUMN "participantType" TEXT NOT NULL DEFAULT 'STUDENT',
    ADD COLUMN "employmentType" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "organisationName" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "occupation" TEXT NOT NULL DEFAULT '';

CREATE INDEX "Student_participantType_idx" ON "Student"("participantType");

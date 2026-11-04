-- Parent and emergency contact numbers for each student.
ALTER TABLE "Student"
    ADD COLUMN "parentPhone" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "emergencyPhone" TEXT NOT NULL DEFAULT '';

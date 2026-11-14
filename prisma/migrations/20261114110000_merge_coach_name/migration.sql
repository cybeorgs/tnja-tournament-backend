-- "Coach name" and "Root coach" are the same person: keep one field (rootCoach).
-- Copy existing coach names first, so nothing is lost, then drop the old column.
UPDATE "Student" SET "rootCoach" = "coachName" WHERE "rootCoach" = '' AND "coachName" <> '';
ALTER TABLE "Student" DROP COLUMN "coachName";

-- Registration runs on a schedule instead of manual switches:
--   registrationOpensAt → registrationClosesAt : regular fee
--   registrationClosesAt → startDate           : late registration at 2 × the entry fee
--   from startDate                             : closed
ALTER TABLE "Tournament"
    ADD COLUMN "registrationOpensAt" TIMESTAMP(3),
    ADD COLUMN "registrationClosesAt" TIMESTAMP(3);

-- Start dates were stored as dates only (midnight UTC). Give them a start time of 09:00 IST (03:30 UTC).
UPDATE "Tournament" SET "startDate" = date_trunc('day', "startDate") + interval '3 hours 30 minutes'
WHERE "startDate" = date_trunc('day', "startDate");

-- Keep each tournament in the state its manual switches had put it in:
--   open                 → open from creation until the start (no late window)
--   late registration    → regular registration ended now; late until the start
--   closed               → opening moved to the start, so it never opens again
UPDATE "Tournament" SET
    "registrationOpensAt"  = CASE WHEN "registrationOpen" OR "lateRegistrationOpen" THEN LEAST("createdAt", "startDate") ELSE "startDate" END,
    "registrationClosesAt" = CASE WHEN "registrationOpen" THEN "startDate"
                                  WHEN "lateRegistrationOpen" THEN LEAST(GREATEST(now(), LEAST("createdAt", "startDate")), "startDate")
                                  ELSE "startDate" END;

ALTER TABLE "Tournament"
    ALTER COLUMN "registrationOpensAt" SET NOT NULL,
    ALTER COLUMN "registrationClosesAt" SET NOT NULL,
    DROP COLUMN "registrationOpen",
    DROP COLUMN "lateRegistrationOpen",
    DROP COLUMN "lateEntryFee";

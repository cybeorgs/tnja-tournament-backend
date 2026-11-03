-- Automated emails: registration confirmation, deadline reminder (admin-scheduled), payment success.
ALTER TABLE "Tournament" ADD COLUMN "reminderAt" TIMESTAMP(3);

-- Each entry records which emails it has had, so none is sent twice.
ALTER TABLE "Registration"
    ADD COLUMN "confirmationSentAt" TIMESTAMP(3),
    ADD COLUMN "reminderSentAt" TIMESTAMP(3);
-- Existing entries were confirmed by the emails of the time; don't confirm them again.
UPDATE "Registration" SET "confirmationSentAt" = "createdAt";

-- Accounts that already exist are treated as having a password (older ones were emailed one).
ALTER TABLE "StudentAccount" ADD COLUMN "passwordSetAt" TIMESTAMP(3);
UPDATE "StudentAccount" SET "passwordSetAt" = "createdAt";

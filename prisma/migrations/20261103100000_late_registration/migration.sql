-- Late registration: once regular registration closes, entries can still be taken at a separate fee.
ALTER TABLE "Tournament"
    ADD COLUMN "lateEntryFee" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lateRegistrationOpen" BOOLEAN NOT NULL DEFAULT false;

-- Each entry remembers whether it was late and what it costs.
ALTER TABLE "Registration"
    ADD COLUMN "isLate" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "fee" INTEGER NOT NULL DEFAULT 0;

-- Existing entries cost the tournament's entry fee (what was charged before this change).
UPDATE "Registration" r SET "fee" = t."entryFee" FROM "Tournament" t WHERE r."tournamentId" = t."id";

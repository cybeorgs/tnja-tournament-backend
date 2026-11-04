-- A lower fee for each further category (age group) a player enters in the same tournament.
ALTER TABLE "Tournament" ADD COLUMN "additionalEntryFee" INTEGER NOT NULL DEFAULT 0;

-- Existing tournaments keep charging every category the same.
UPDATE "Tournament" SET "additionalEntryFee" = "entryFee";

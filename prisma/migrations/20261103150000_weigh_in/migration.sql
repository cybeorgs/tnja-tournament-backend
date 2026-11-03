-- Weigh-in: every entrant must be weighed (or disqualified) before their category's draw is generated.
ALTER TABLE "Registration"
    ADD COLUMN "weighInStatus" TEXT NOT NULL DEFAULT 'PENDING',
    ADD COLUMN "weighInKg" DOUBLE PRECISION,
    ADD COLUMN "weighedAt" TIMESTAMP(3);

-- Entries already in a generated draw went through the old process; count them as weighed in so
-- existing draws aren't held up.
UPDATE "Registration" r SET "weighInStatus" = 'CLEARED', "weighInKg" = r."weightKg"
WHERE EXISTS (
    SELECT 1 FROM "Draw" d, jsonb_array_elements(d."entrants") e
    WHERE d."tournamentId" = r."tournamentId" AND e->>'id' = r."id"
);

CREATE INDEX "Registration_tournamentId_weighInStatus_idx" ON "Registration"("tournamentId", "weighInStatus");

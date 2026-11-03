-- The late entry fee is set by the admin (higher than the regular fee) instead of always being 2×.
ALTER TABLE "Tournament" ADD COLUMN "lateEntryFee" INTEGER NOT NULL DEFAULT 0;
UPDATE "Tournament" SET "lateEntryFee" = "entryFee" * 2;

-- The amount each entry was charged in its payment order, checked against the gateway on verification.
ALTER TABLE "Registration" ADD COLUMN "orderFee" INTEGER;

-- Delivery log of tournament emails.
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "studentId" TEXT,
    "kind" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'AUTO',
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmailLog_tournamentId_createdAt_idx" ON "EmailLog"("tournamentId", "createdAt");
CREATE INDEX "EmailLog_tournamentId_studentId_idx" ON "EmailLog"("tournamentId", "studentId");
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

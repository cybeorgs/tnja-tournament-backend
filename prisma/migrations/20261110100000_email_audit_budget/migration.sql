-- One row per email the app tries to send (audit log + duplicate guard). No bodies, codes or links.
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "kind" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT '',
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "studentId" TEXT,
    "tournamentId" TEXT,
    "registrationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL,
    "messageId" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailMessage_idempotencyKey_key" ON "EmailMessage"("idempotencyKey");
CREATE INDEX "EmailMessage_createdAt_idx" ON "EmailMessage"("createdAt");
CREATE INDEX "EmailMessage_status_createdAt_idx" ON "EmailMessage"("status", "createdAt");
CREATE INDEX "EmailMessage_category_createdAt_idx" ON "EmailMessage"("category", "createdAt");
CREATE INDEX "EmailMessage_toEmail_idx" ON "EmailMessage"("toEmail");

-- Daily email counts per budget category (India date), updated atomically.
CREATE TABLE "EmailDailyUsage" (
    "day" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "extraAllowance" INTEGER NOT NULL DEFAULT 0,
    "extraGrantedBy" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailDailyUsage_pkey" PRIMARY KEY ("day", "category")
);

-- Emailed verification codes, stored (as an HMAC only) so resend cooldowns and limits survive restarts.
CREATE TABLE "EmailOtpChallenge" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "ip" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "deliveryStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "messageId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailOtpChallenge_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmailOtpChallenge_email_createdAt_idx" ON "EmailOtpChallenge"("email", "createdAt");
CREATE INDEX "EmailOtpChallenge_ip_createdAt_idx" ON "EmailOtpChallenge"("ip", "createdAt");

-- Addresses that must not be emailed (hard bounces, blocked, spam complaints, unsubscribes).
CREATE TABLE "EmailSuppression" (
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("email")
);

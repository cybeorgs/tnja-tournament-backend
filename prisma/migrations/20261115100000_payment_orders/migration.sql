-- Every Razorpay order, kept for good, so a payment is always matched to the entries it paid for
-- (see lib/payments.ts). Nothing existing changes: older orders are recovered by "Sync with Razorpay".
CREATE TABLE "PaymentOrder" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "paymentId" TEXT,
    "paidAt" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentOrder_paymentId_key" ON "PaymentOrder"("paymentId");
CREATE INDEX "PaymentOrder_tournamentId_studentId_idx" ON "PaymentOrder"("tournamentId", "studentId");
CREATE INDEX "PaymentOrder_status_createdAt_idx" ON "PaymentOrder"("status", "createdAt");

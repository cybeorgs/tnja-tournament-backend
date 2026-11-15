import { checkMailSetup } from "./lib/mailer.js";
import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { ensureFirstAdmin } from "./lib/admins.js";
import prisma from "./db.js";
import { onlinePaymentEnabled, startPaymentReconciler } from "./lib/payments.js";

async function main() {
  await prisma.$connect();
  await ensureFirstAdmin(env.adminUsername, env.adminPassword);
  createApp().listen(env.port, () => {
    console.log(`Tournament API listening on http://localhost:${env.port}`);
    checkMailSetup();
    // Safety net for online payments whose browser confirmation and webhook were both missed.
    startPaymentReconciler();
    if (onlinePaymentEnabled() && !env.razorpayWebhookSecret) {
      console.warn("[payments] RAZORPAY_WEBHOOK_SECRET is not set: payments are confirmed by the browser and the 5-minute check only. Add the webhook in the Razorpay dashboard.");
    }
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});

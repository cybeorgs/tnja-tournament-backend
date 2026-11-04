import { checkMailSetup } from "./lib/mailer.js";
import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { ensureFirstAdmin } from "./lib/admins.js";
import prisma from "./db.js";

async function main() {
  await prisma.$connect();
  await ensureFirstAdmin(env.adminUsername, env.adminPassword);
  createApp().listen(env.port, () => {
    console.log(`Tournament API listening on http://localhost:${env.port}`);
    checkMailSetup();
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});

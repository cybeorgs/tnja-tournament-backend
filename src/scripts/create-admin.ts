// Create an admin, or reset an existing admin's password.
//   npm run admin:create -- <username> <password>
// Falls back to ADMIN_USERNAME / ADMIN_PASSWORD from .env.
import "dotenv/config";
import { upsertAdmin } from "../lib/admins.js";
import prisma from "../db.js";

const [username = process.env.ADMIN_USERNAME, password = process.env.ADMIN_PASSWORD] = process.argv.slice(2);

if (!username || !password) {
  console.error("Usage: npm run admin:create -- <username> <password>");
  process.exit(1);
}
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

const admin = await upsertAdmin(username, password);
console.log(`Admin "${admin.username}" is ready.`);
await prisma.$disconnect();

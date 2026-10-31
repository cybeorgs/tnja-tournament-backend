import bcrypt from "bcrypt";
import prisma from "../db.js";

export async function upsertAdmin(username: string, password: string) {
  const passwordHash = await bcrypt.hash(password, 12);
  const name = username.charAt(0).toUpperCase() + username.slice(1);
  return prisma.admin.upsert({
    where: { username: username.toLowerCase() },
    update: { passwordHash },
    create: { username: username.toLowerCase(), passwordHash, name },
  });
}

/** On first boot, create the admin from ADMIN_USERNAME / ADMIN_PASSWORD if there are no admins yet. */
export async function ensureFirstAdmin(username: string, password: string) {
  if ((await prisma.admin.count()) > 0) return;
  if (!username || !password) {
    console.warn("[setup] No admin account exists. Set ADMIN_USERNAME and ADMIN_PASSWORD in .env, or run `npm run admin:create -- <username> <password>`.");
    return;
  }
  if (password.length < 8) {
    console.warn("[setup] ADMIN_PASSWORD must be at least 8 characters; admin account not created.");
    return;
  }
  await upsertAdmin(username, password);
  console.log(`[setup] Created admin account "${username.toLowerCase()}".`);
}

import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import prisma from "../db.js";
import { requireAdmin, signToken } from "../middleware/auth.js";
import { HttpError } from "../middleware/errors.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = Router();

// Compared against when the username doesn't exist, so response time doesn't reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

const loginSchema = z.object({
  username: z.string().trim().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

router.post("/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }), async (req, res) => {
  const { username, password } = loginSchema.parse(req.body);
  const admin = await prisma.admin.findUnique({ where: { username: username.toLowerCase() } });
  const ok = await bcrypt.compare(password, admin?.passwordHash || DUMMY_HASH);
  if (!admin || !ok) throw new HttpError(401, "Incorrect username or password.");

  const token = signToken({ adminId: admin.id, username: admin.username });
  res.json({ token, admin: { id: admin.id, username: admin.username, name: admin.name } });
});

router.get("/me", requireAdmin, async (req, res) => {
  const admin = await prisma.admin.findUnique({ where: { id: req.admin!.adminId } });
  if (!admin) throw new HttpError(401, "Account no longer exists.");
  res.json({ id: admin.id, username: admin.username, name: admin.name });
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

router.post("/change-password", requireAdmin, async (req, res) => {
  const { currentPassword, newPassword } = passwordSchema.parse(req.body);
  const admin = await prisma.admin.findUnique({ where: { id: req.admin!.adminId } });
  if (!admin || !(await bcrypt.compare(currentPassword, admin.passwordHash))) {
    throw new HttpError(400, "Current password is incorrect.");
  }
  await prisma.admin.update({ where: { id: admin.id }, data: { passwordHash: await bcrypt.hash(newPassword, 12) } });
  res.json({ message: "Password changed." });
});

export default router;

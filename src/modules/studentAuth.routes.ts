// Student (and parent) logins. One account per email covers every student registered with it.
// The account is created when a student registers.
// Passwords are never emailed: the welcome email and "forgot password" both send a one-time link
// to set one. A logged-in student sees their registration details and tournament entries.
import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import prisma from "../db.js";
import { requireStudent, signStudentToken } from "../middleware/auth.js";
import { HttpError, notFound } from "../middleware/errors.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { accountFromPasswordToken, hashPassword, passwordLink, unusablePasswordHash } from "../lib/accounts.js";
import { sendPasswordReset } from "../lib/mailer.js";
import { tempIdOf } from "../lib/registrationEmails.js";

const email = z.email("Enter a valid email address").transform((e) => e.trim().toLowerCase());
const newPassword = z.string().min(8, "Password must be at least 8 characters").max(200);

// Compared against when the email has no account, so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export const studentAuthRouter = Router();

/**
 * The email a login name belongs to: the email itself, a permanent student ID (TNJA-S-000123) or the
 * temporary ID given to applicants waiting for approval (TMP-1A2B3C4D).
 */
async function emailForLogin(login: string): Promise<string | null> {
  const value = login.trim();
  if (value.includes("@")) return value.toLowerCase();
  const upper = value.toUpperCase();
  const temp = /^TMP-([0-9A-F]{8})$/.exec(upper);
  if (temp) {
    const hex = temp[1]!.toLowerCase();
    const matches = await prisma.student.findMany({ where: { id: { startsWith: hex } }, select: { email: true }, take: 2 });
    return matches.length === 1 ? matches[0]!.email.toLowerCase() : null;
  }
  const student = await prisma.student.findUnique({ where: { studentNo: upper }, select: { email: true } });
  return student?.email.toLowerCase() ?? null;
}

studentAuthRouter.post("/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }), async (req, res) => {
  const input = z
    .object({
      /** Email, student ID or temporary ID (older clients send "email") */
      login: z.string().trim().min(3, "Enter your email or student ID").max(254).optional(),
      email: z.string().trim().max(254).optional(),
      password: z.string().min(1, "Password is required"),
    })
    .refine((v) => v.login || v.email, { message: "Enter your email or student ID", path: ["login"] })
    .parse(req.body);
  const accountEmail = await emailForLogin(input.login ?? input.email!);
  const account = accountEmail ? await prisma.studentAccount.findUnique({ where: { email: accountEmail } }) : null;
  const ok = await bcrypt.compare(input.password, account?.passwordHash || DUMMY_HASH);
  if (!account || !ok) throw new HttpError(401, "Incorrect username or password. Use the username and password from your registration email, or “Forgot password”.");
  res.json({ token: signStudentToken({ accountId: account.id, email: account.email }) });
});

/**
 * Email a link to choose a new password. Nothing changes until the link is used, so a stranger
 * typing someone's email can't lock them out. Also creates the login for students registered
 * before logins existed. Always answers the same way, so it doesn't reveal which emails are registered.
 */
studentAuthRouter.post("/forgot-password", rateLimit({ windowMs: 60 * 60 * 1000, max: 5 }), async (req, res) => {
  const input = z.object({ email }).parse(req.body);
  if (await prisma.student.count({ where: { email: input.email } })) {
    const account =
      (await prisma.studentAccount.findUnique({ where: { email: input.email } })) ??
      (await prisma.studentAccount.create({ data: { email: input.email, passwordHash: await unusablePasswordHash() } }));
    await sendPasswordReset(input.email, passwordLink(account, "reset"));
  }
  res.json({ message: "If this email is registered, we've sent a link to set a new password." });
});

/** Set the password from an emailed link (welcome or reset), then log straight in. The link then stops working. */
studentAuthRouter.post("/set-password", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }), async (req, res) => {
  const input = z.object({ token: z.string().min(1), password: newPassword }).parse(req.body);
  const account = await accountFromPasswordToken(input.token);
  if (!account) throw new HttpError(400, "This link has expired or has already been used. Use “Forgot password” on the login page to get a new one.");
  await prisma.studentAccount.update({ where: { id: account.id }, data: { passwordHash: await hashPassword(input.password), passwordSetAt: new Date() } });
  res.json({ email: account.email, token: signStudentToken({ accountId: account.id, email: account.email }) });
});

// ─── Logged-in student ───────────────────────────────────────────────────────

export const studentRouter = Router();
studentRouter.use(requireStudent);

/** The account and every student registered with its email: their registration details and tournament entries. */
studentRouter.get("/me", async (req, res) => {
  const students = await prisma.student.findMany({
    where: { email: req.student!.email },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, studentNo: true, fullName: true, gender: true, dob: true, status: true, reviewNote: true, outsideTamilNadu: true, createdAt: true,
      fatherName: true, motherName: true, bloodGroup: true, aadhaarNumber: true, phone: true, alternatePhone: true, email: true, nationality: true,
      residingPincode: true, district: true, taluk: true, address: true, city: true, state: true, pincode: true,
      institutionType: true, institutionName: true, grade: true, degreeDepartment: true, club: true, coachName: true, belt: true,
      registrations: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true, ageGroup: true, gender: true, weightCategory: true, weightKg: true, placement: true, isLate: true, weighInStatus: true,
          tournament: { select: { id: true, slug: true, title: true, startDate: true, endDate: true, venue: true, city: true, status: true } },
        },
      },
    },
  });
  // Only the last 4 Aadhaar digits leave the server.
  res.json({ email: req.student!.email, students: students.map((s) => ({ ...s, tempId: s.studentNo ? null : tempIdOf(s), aadhaarNumber: s.aadhaarNumber ? `XXXX XXXX ${s.aadhaarNumber.slice(-4)}` : null })) });
});

studentRouter.post("/change-password", async (req, res) => {
  const input = z.object({ currentPassword: z.string().min(1, "Current password is required"), newPassword }).parse(req.body);
  const account = await prisma.studentAccount.findUnique({ where: { id: req.student!.accountId } });
  if (!account || !(await bcrypt.compare(input.currentPassword, account.passwordHash))) {
    throw new HttpError(400, "Current password is incorrect.");
  }
  await prisma.studentAccount.update({ where: { id: account.id }, data: { passwordHash: await hashPassword(input.newPassword), passwordSetAt: new Date() } });
  res.json({ message: "Password changed." });
});


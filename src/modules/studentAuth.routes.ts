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
import { entryPassPdf, entryPassReady, loadEntryPass } from "../lib/entryPass.js";
import { confirmPayment, createOrder, verifySchema } from "../lib/payments.js";
import { sendPdf } from "./certificates.js";

const email = z.email("Enter a valid email address").transform((e) => e.trim().toLowerCase());
// bcrypt only reads the first 72 bytes, so longer passwords would silently be cut short.
const newPassword = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .refine((p) => Buffer.byteLength(p, "utf8") <= 72, "Password must be at most 72 characters")
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), "Use at least one letter and one number");

// Compared against when the login has no account, so response time doesn't reveal which emails exist.
// Same cost as real hashes (hashPassword uses 12), or the faster compare would give it away.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 12);

/** The login name as typed, normalised, for counting attempts per account (not just per IP). */
const loginKey = (req: { body?: { login?: unknown; email?: unknown } }) => {
  const value = req.body?.login ?? req.body?.email;
  return typeof value === "string" && value.trim() ? `login:${value.trim().toLowerCase()}` : undefined;
};
const emailKey = (req: { body?: { email?: unknown } }) =>
  typeof req.body?.email === "string" && req.body.email.trim() ? `reset:${req.body.email.trim().toLowerCase()}` : undefined;

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

// Per IP, and per account: guessing one account's password from many IPs is limited too.
const loginPerIp = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const loginPerAccount = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, key: loginKey, message: "Too many login attempts for this account." });

studentAuthRouter.post("/login", loginPerIp, loginPerAccount, async (req, res) => {
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
  res.json({ token: signStudentToken(account) });
});

/**
 * Email a link to choose a new password. Nothing changes until the link is used, so a stranger
 * typing someone's email can't lock them out. Also creates the login for students registered
 * before logins existed. Always answers the same way, so it doesn't reveal which emails are registered.
 */
// Per IP, and per email address, so nobody can flood someone's inbox with reset emails from many IPs.
const resetPerIp = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });
const resetPerEmail = rateLimit({ windowMs: 60 * 60 * 1000, max: 3, key: emailKey, message: "A reset link was already sent to this email." });

studentAuthRouter.post("/forgot-password", resetPerIp, resetPerEmail, async (req, res) => {
  const input = z.object({ email }).parse(req.body);
  // Answer straight away and send in the background: waiting for the mail server would make the
  // reply slower for registered emails, revealing which ones are registered.
  void (async () => {
    if (!(await prisma.student.count({ where: { email: input.email } }))) return;
    const account =
      (await prisma.studentAccount.findUnique({ where: { email: input.email } })) ??
      (await prisma.studentAccount.create({ data: { email: input.email, passwordHash: await unusablePasswordHash() } }));
    await sendPasswordReset(input.email, passwordLink(account, "reset"));
  })().catch((err) => console.error("[forgot password] failed:", err));
  res.json({ message: "If this email is registered, we've sent a link to set a new password." });
});

/** Set the password from an emailed link (welcome or reset), then log straight in. The link then stops working. */
studentAuthRouter.post("/set-password", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }), async (req, res) => {
  const input = z.object({ token: z.string().min(1), password: newPassword }).parse(req.body);
  const account = await accountFromPasswordToken(input.token);
  if (!account) throw new HttpError(400, "This link has expired or has already been used. Use “Forgot password” on the login page to get a new one.");
  // The new password ends every other session; this one starts fresh.
  const updated = await prisma.studentAccount.update({ where: { id: account.id }, data: { passwordHash: await hashPassword(input.password), passwordSetAt: new Date() } });
  res.json({ email: updated.email, token: signStudentToken(updated) });
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
      fatherName: true, motherName: true, bloodGroup: true, aadhaarNumber: true, phone: true, alternatePhone: true, parentPhone: true, emergencyPhone: true, email: true, nationality: true,
      residingPincode: true, district: true, taluk: true, address: true, city: true, state: true, pincode: true,
      participantType: true, employmentType: true, organisationName: true, occupation: true,
      institutionType: true, institutionName: true, grade: true, degreeDepartment: true, club: true, coachName: true, belt: true,
      registrations: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true, ageGroup: true, gender: true, weightCategory: true, weightKg: true, placement: true, weighInStatus: true, fee: true, paymentStatus: true, amountPaid: true, paidAt: true,
          tournament: { select: { id: true, slug: true, title: true, startDate: true, endDate: true, venue: true, city: true, status: true } },
        },
      },
    },
  });
  // Only the last 4 Aadhaar digits leave the server.
  res.json({ email: req.student!.email, students: students.map((s) => ({ ...s, tempId: s.studentNo ? null : tempIdOf(s), aadhaarNumber: s.aadhaarNumber ? `XXXX XXXX ${s.aadhaarNumber.slice(-4)}` : null })) });
});

/** The Tournament Entry Pass of one event of one of the account's students, once that event is paid (or free). */
studentRouter.get("/students/:studentId/entries/:registrationId/entry-pass", async (req, res) => {
  const student = await prisma.student.findFirst({ where: { id: String(req.params.studentId), email: req.student!.email }, select: { id: true } });
  if (!student) throw notFound("Student");
  const data = await loadEntryPass(String(req.params.registrationId));
  if (!data || data.student.id !== student.id) throw notFound("Entry");
  if (!entryPassReady(data.entry)) throw new HttpError(409, "Your entry pass is issued once this event is paid.");
  const pdf = await entryPassPdf(data);
  sendPdf(res, pdf.content, pdf.filename, req.query.download === "1");
});

/** One of the account's students, or 404. */
async function ownStudent(email: string, studentId: string) {
  const student = await prisma.student.findFirst({ where: { id: studentId, email }, select: { id: true } });
  if (!student) throw notFound("Student");
  return student;
}

// ─── Paying later ────────────────────────────────────────────────────────────
// Unpaid entries can be paid from the account any time before the tournament starts.

studentRouter.post("/students/:studentId/tournaments/:tournamentId/pay", async (req, res) => {
  const student = await ownStudent(req.student!.email, String(req.params.studentId));
  res.json({ order: await createOrder(String(req.params.tournamentId), student.id) });
});

studentRouter.post("/students/:studentId/tournaments/:tournamentId/pay/verify", async (req, res) => {
  const student = await ownStudent(req.student!.email, String(req.params.studentId));
  await confirmPayment(String(req.params.tournamentId), student.id, verifySchema.parse(req.body));
  res.json({ message: "Payment received. Your Tournament Entry Passes are on their way to your email." });
});

studentRouter.post("/change-password", async (req, res) => {
  const input = z.object({ currentPassword: z.string().min(1, "Current password is required"), newPassword }).parse(req.body);
  const account = await prisma.studentAccount.findUnique({ where: { id: req.student!.accountId } });
  if (!account || !(await bcrypt.compare(input.currentPassword, account.passwordHash))) {
    throw new HttpError(400, "Current password is incorrect.");
  }
  if (input.currentPassword === input.newPassword) throw new HttpError(400, "Choose a new password that's different from the current one.");
  // Other devices are logged out; this one carries on with the new token.
  const updated = await prisma.studentAccount.update({ where: { id: account.id }, data: { passwordHash: await hashPassword(input.newPassword), passwordSetAt: new Date() } });
  res.json({ message: "Password changed. You've been logged out on other devices.", token: signStudentToken(updated) });
});


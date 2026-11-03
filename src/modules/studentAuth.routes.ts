// Student (and parent) logins. One account per email covers every student registered with it.
// The account is created when a student registers — before, and independent of, any payment.
// Passwords are never emailed: the welcome email and "forgot password" both send a one-time link
// to set one. A logged-in student sees their registration details and can pay pending entry fees.
import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import prisma from "../db.js";
import { requireStudent, signStudentToken } from "../middleware/auth.js";
import { HttpError, notFound } from "../middleware/errors.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { accountFromPasswordToken, hashPassword, passwordLink, unusablePasswordHash } from "../lib/accounts.js";
import { sendPasswordReset } from "../lib/mailer.js";
import { confirmOrderPayment, createEntryOrder, getRazorpay, verifySchema } from "../lib/payments.js";
import { param } from "../lib/helpers.js";
import { registrationPhase, repriceUnpaid } from "../lib/fees.js";

const email = z.email("Enter a valid email address").transform((e) => e.trim().toLowerCase());
const newPassword = z.string().min(8, "Password must be at least 8 characters").max(200);

// Compared against when the email has no account, so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export const studentAuthRouter = Router();

studentAuthRouter.post("/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }), async (req, res) => {
  const input = z.object({ email, password: z.string().min(1, "Password is required") }).parse(req.body);
  const account = await prisma.studentAccount.findUnique({ where: { email: input.email } });
  const ok = await bcrypt.compare(input.password, account?.passwordHash || DUMMY_HASH);
  if (!account || !ok) throw new HttpError(401, "Incorrect email or password. If you haven't set a password yet, use the link in your registration email or “Forgot password”.");
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
  // Unpaid entries show the fee that applies now (the late fee once the regular deadline has passed).
  const owing = await prisma.registration.findMany({ where: { paymentStatus: "PENDING", student: { email: req.student!.email } }, select: { tournament: true }, distinct: ["tournamentId"] });
  for (const { tournament } of owing) await repriceUnpaid(tournament);
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
          id: true, ageGroup: true, gender: true, weightCategory: true, paymentStatus: true, placement: true, fee: true, isLate: true, amountPaid: true,
          tournament: { select: { id: true, slug: true, title: true, startDate: true, endDate: true, venue: true, city: true, status: true } },
        },
      },
    },
  });
  // Only the last 4 Aadhaar digits leave the server.
  res.json({ email: req.student!.email, students: students.map((s) => ({ ...s, aadhaarNumber: s.aadhaarNumber ? `XXXX XXXX ${s.aadhaarNumber.slice(-4)}` : null })) });
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

// ─── Paying later ────────────────────────────────────────────────────────────
// Entries stay "pending" when the fee isn't paid at registration. The student pays them from their
// dashboard any time before the tournament starts (when registration and its payments close). Each
// entry costs the fee stored when it was made — a regular entry paid during late registration still
// costs the regular fee.

const paymentLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

/** One payment order for all of a student's unpaid entries in a tournament. */
studentRouter.post("/tournaments/:tournamentId/payment", paymentLimiter, async (req, res) => {
  const { studentId } = z.object({ studentId: z.string().uuid() }).parse(req.body);
  const tournament = await prisma.tournament.findUnique({ where: { id: param(req, "tournamentId") } });
  if (!tournament) throw notFound("Tournament");
  if (registrationPhase(tournament) === "CLOSED") throw new HttpError(409, "This tournament has started, so entry fees can no longer be paid online. Please contact the organiser.");
  // The student must belong to the logged-in account.
  const student = await prisma.student.findFirst({ where: { id: studentId, email: req.student!.email }, select: { id: true } });
  if (!student) throw notFound("Student");
  const pending = await prisma.registration.findMany({
    where: { tournamentId: tournament.id, studentId: student.id, paymentStatus: "PENDING" },
    include: { student: true },
  });
  if (!pending.length) throw new HttpError(409, "There's nothing left to pay for this tournament.");
  try {
    getRazorpay();
  } catch {
    throw new HttpError(503, "Online payment isn't available right now. Please contact the organiser.");
  }
  const order = await createEntryOrder(pending, tournament);
  if (!order) throw new HttpError(409, "This has already been paid — refresh the page to see it.");
  res.json(order);
});

/** Razorpay hands back a signed payment; confirm it and mark those entries paid. */
studentRouter.post("/tournaments/:tournamentId/payment/verify", paymentLimiter, async (req, res) => {
  const paid = await confirmOrderPayment(param(req, "tournamentId"), verifySchema.parse(req.body));
  res.json({ paid: paid.length });
});

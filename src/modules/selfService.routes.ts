// Public self-service: students register themselves (and get a permanent student ID
// straight away — no approval, no fee), then use that ID to enter a tournament and pay
// its entry fee. An entry only counts once it is paid (or the tournament is free).
import { Router } from "express";
import { z } from "zod";
import prisma from "../db.js";
import { HttpError, notFound } from "../middleware/errors.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { eligibleAgeGroups } from "../lib/categories.js";
import { newCertificateNo, param } from "../lib/helpers.js";
import { createStudent, studentSchema } from "../lib/students.js";
import { TN_LOCATIONS, lookupPincode } from "../lib/locations.js";
import { confirmEntryPayment, createEntryOrder, getRazorpay, verifySchema } from "../lib/payments.js";
import { resolveCategory } from "./tournaments.routes.js";

const router = Router();

// ─── Student registration ────────────────────────────────────────────────────

const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });

const registerSchema = studentSchema.and(
  z.object({ agreedToTerms: z.literal(true, { error: "Please agree to the terms and privacy policy" }) }),
);

router.post("/students/register", registerLimiter, async (req, res) => {
  const { agreedToTerms: _agreed, ...input } = registerSchema.parse(req.body);
  // Don't reveal someone else's student ID to whoever types their Aadhaar number.
  if (await prisma.student.findUnique({ where: { aadhaarNumber: input.aadhaarNumber }, select: { id: true } })) {
    throw new HttpError(409, "This Aadhaar number is already registered. If you have lost your student ID, contact the organiser.");
  }
  const student = await prisma.$transaction((tx) => createStudent(tx, input, "SELF"));
  res.status(201).json({ studentNo: student.studentNo, fullName: student.fullName, email: student.email });
});

// ─── Locations ───────────────────────────────────────────────────────────────

router.get("/locations", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.json(TN_LOCATIONS);
});

const pincodeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120 });

router.get("/locations/pincode/:pincode", pincodeLimiter, async (req, res) => {
  res.json(await lookupPincode(param(req, "pincode")));
});

// ─── Tournament entry ────────────────────────────────────────────────────────

const entryLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });

const identifySchema = z.object({
  studentNo: z.string().trim().min(3, "Enter your student ID").transform((s) => s.toUpperCase()),
  dob: z.coerce.date({ error: "Enter your date of birth" }),
});

const sameDay = (a: Date, b: Date) => a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);

async function openTournament(slug: string) {
  const tournament = await prisma.tournament.findFirst({ where: { slug, status: "PUBLISHED" } });
  if (!tournament) throw notFound("Tournament");
  if (!tournament.registrationOpen) throw new HttpError(409, "Entries for this tournament are closed.");
  return tournament;
}

/** The student proves who they are with their ID and date of birth. */
async function identify(input: z.infer<typeof identifySchema>) {
  const student = await prisma.student.findUnique({ where: { studentNo: input.studentNo } });
  if (!student || !sameDay(student.dob, input.dob)) {
    throw new HttpError(404, "No student matches that ID and date of birth. Check both and try again.");
  }
  return student;
}

const entryView = (r: { id: string; ageGroup: string; gender: string; weightCategory: string; weightKg: number; paymentStatus: string }) => ({
  id: r.id, ageGroup: r.ageGroup, gender: r.gender, weightCategory: r.weightCategory, weightKg: r.weightKg, paymentStatus: r.paymentStatus,
});

/** Step 1: look the student up and tell them which age groups they can enter. */
router.post("/tournaments/:slug/entry/check", entryLimiter, async (req, res) => {
  const tournament = await openTournament(param(req, "slug"));
  const student = await identify(identifySchema.parse(req.body));
  const existing = await prisma.registration.findUnique({ where: { tournamentId_studentId: { tournamentId: tournament.id, studentId: student.id } } });
  res.json({
    student: { studentNo: student.studentNo, fullName: student.fullName, gender: student.gender },
    genderAllowed: tournament.gender === "BOTH" || tournament.gender === student.gender,
    ageGroups: eligibleAgeGroups(student.dob, tournament.startDate, tournament.ageGroups),
    entryFee: tournament.entryFee,
    entry: existing ? entryView(existing) : null,
  });
});

const enterSchema = identifySchema.extend({
  ageGroup: z.string().min(1, "Choose an age group"),
  weightKg: z.coerce.number().min(10, "Weight looks too low").max(250, "Weight looks too high"),
});

/** Step 2: create (or update) the entry and, if there is a fee, open a payment order. */
router.post("/tournaments/:slug/entry", entryLimiter, async (req, res) => {
  const tournament = await openTournament(param(req, "slug"));
  const input = enterSchema.parse(req.body);
  const student = await identify(input);
  // Fail before saving anything if online payment isn't set up.
  if (tournament.entryFee > 0) {
    try {
      getRazorpay();
    } catch {
      throw new HttpError(503, "Online payment isn't available for this tournament yet. Please contact the organiser to enter.");
    }
  }

  const category = await resolveCategory(tournament, student, { ...input, overrideAge: false });
  const existing = await prisma.registration.findUnique({ where: { tournamentId_studentId: { tournamentId: tournament.id, studentId: student.id } } });
  if (existing && existing.paymentStatus !== "PENDING") {
    throw new HttpError(409, `You are already entered in ${existing.ageGroup} ${existing.weightCategory}. Contact the organiser to change it.`);
  }

  const registration = existing
    ? await prisma.registration.update({ where: { id: existing.id }, data: category, include: { student: true } })
    : await prisma.registration.create({
        data: { tournamentId: tournament.id, studentId: student.id, ...category, certificateNo: await newCertificateNo(), paymentStatus: tournament.entryFee > 0 ? "PENDING" : "WAIVED" },
        include: { student: true },
      });

  res.json({
    entry: entryView(registration),
    payment: tournament.entryFee > 0 ? await createEntryOrder(registration, tournament) : null,
  });
});

/** Step 3: Razorpay hands back a signed payment; confirm it and the entry is in. */
router.post("/tournaments/:slug/entry/:regId/verify", entryLimiter, async (req, res) => {
  const tournament = await prisma.tournament.findFirst({ where: { slug: param(req, "slug"), status: "PUBLISHED" } });
  if (!tournament) throw notFound("Tournament");
  const registration = await prisma.registration.findFirst({ where: { id: param(req, "regId"), tournamentId: tournament.id } });
  if (!registration) throw notFound("Entry");
  const paid = await confirmEntryPayment(registration, tournament.entryFee, verifySchema.parse(req.body));
  res.json({ entry: entryView(paid) });
});

export default router;

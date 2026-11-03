// Public self-service.
// Students register themselves (email verified by OTP; registration is free). Tamil Nadu residents
// get their permanent student ID straight away; anyone else uploads proof (e.g. a nativity
// certificate) and waits for an admin to approve it. Every registration gets a login (one per email),
// emailed to them. Approved students enter tournaments in one or more age groups (e.g. a cadet in
// Cadet, Junior and Senior), usually in the registration form itself. Entering is free.
// Referees register themselves as officials of a tournament the same way (no fee).
import { Router } from "express";
import { z } from "zod";
import prisma from "../db.js";
import { HttpError, notFound } from "../middleware/errors.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { REFEREE_ROLES, eligibleAgeGroups } from "../lib/categories.js";
import { newCertificateNo, param } from "../lib/helpers.js";
import { confirmResidency, createStudent, decodeUpload, studentSchema, type StudentUpload } from "../lib/students.js";
import { ensureAccount } from "../lib/accounts.js";
import { TN_LOCATIONS, lookupPincode } from "../lib/locations.js";
import { emailRegistrationLater, tempIdOf } from "../lib/registrationEmails.js";
import { assertEmailVerified, checkEmailOtp, createEmailOtp, createEmailVerifiedToken } from "../lib/emailOtp.js";
import { sendEmailOtp } from "../lib/mailer.js";
import { assertAadhaarVerified } from "../lib/aadhaar.js";
import { closedReason, newEntryTerms, registrationPhase } from "../lib/fees.js";
import { competeAsSchema, resolveCategory } from "./tournaments.routes.js";
import { refereeSchema } from "./people.routes.js";

const router = Router();

/** resolveCategory, with its messages worded for the player (the admin-only age override isn't offered here). */
async function playerCategory(...args: Parameters<typeof resolveCategory>) {
  try {
    return await resolveCategory(...args);
  } catch (err) {
    if (err instanceof HttpError && /birth year is outside/.test(err.message)) {
      throw new HttpError(400, `You can't play ${args[2].ageGroup} at your age. Choose from the events listed for you.`);
    }
    throw err;
  }
}

// ─── Student registration ────────────────────────────────────────────────────

const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });

const registerSchema = studentSchema.and(
  z.object({
    agreedToTerms: z.literal(true, { error: "Please agree to the terms and privacy policy" }),
    /** From POST /email-otp/verify (the Verify button next to the email) */
    emailVerificationToken: z.string({ error: "Please verify your email address." }).min(1, "Please verify your email address."),
    /** From POST /aadhaar/digilocker/check: Aadhaar verified, with its address in the residing pincode */
    aadhaarVerificationToken: z.string().optional(),
    /** data: URLs. BPL proof for Tamil Nadu BPL families; proof of nativity for everyone outside Tamil Nadu. */
    bplProof: z.string().optional(),
    nativityProof: z.string().optional(),
    nativityProofLabel: z.string().trim().max(80).default("Nativity certificate"),
    /** The events (age groups) to play in a tournament, entered together with the registration */
    entry: z
      .object({
        slug: z.string().min(1),
        ageGroups: z.array(z.string().min(1)).min(1, "Choose the events you will play").max(8),
        weightKg: z.coerce.number().min(10, "Weight looks too low").max(250, "Weight looks too high"),
        competeAs: competeAsSchema,
      })
      .optional(),
  }),
);

router.post("/students/register", registerLimiter, async (req, res) => {
  const { agreedToTerms: _agreed, emailVerificationToken, aadhaarVerificationToken, bplProof, nativityProof, nativityProofLabel, entry, ...form } = registerSchema.parse(req.body);
  assertEmailVerified(emailVerificationToken, form.email);
  assertAadhaarVerified(aadhaarVerificationToken, form.aadhaarNumber, form.residingPincode);
  const data = await confirmResidency(form);

  const documents: StudentUpload[] = [];
  if (data.outsideTamilNadu) {
    if (!nativityProof) throw new HttpError(400, "Please upload a nativity certificate or other proof — your address is outside Tamil Nadu.");
    documents.push({ kind: "NATIVITY_PROOF", label: nativityProofLabel || "Nativity certificate", ...decodeUpload(nativityProof, "The proof document") });
  } else if (data.isBPL) {
    if (!bplProof) throw new HttpError(400, "Please upload your BPL card or certificate.");
    documents.push({ kind: "BPL_PROOF", label: "BPL proof", ...decodeUpload(bplProof, "The BPL proof") });
  }

  // Don't reveal someone else's student ID to whoever types their Aadhaar number.
  if (await prisma.student.findUnique({ where: { aadhaarNumber: data.aadhaarNumber }, select: { id: true } })) {
    throw new HttpError(409, "This Aadhaar number is already registered. Log in with your email to register for tournaments.");
  }

  // The events chosen in the form are checked before anything is saved. Applicants outside Tamil Nadu
  // wait for approval and choose their events afterwards (by logging in).
  const enterNow = entry && !data.outsideTamilNadu ? entry : undefined;
  const tournament = enterNow ? await openTournament(enterNow.slug) : null;
  const categories = tournament && enterNow
    ? await Promise.all([...new Set(enterNow.ageGroups)].map((ageGroup) => playerCategory(tournament, data, { ageGroup, weightKg: enterNow.weightKg, competeAs: enterNow.competeAs, overrideAge: false })))
    : [];
  const certificateNos = await Promise.all(categories.map(() => newCertificateNo()));

  // The student, their account and their entries are created together.
  const { student, account } = await prisma.$transaction(async (tx) => {
    const created = await createStudent(tx, data, { source: "SELF", documents });
    if (tournament && created.status === "APPROVED") {
      for (const [i, category] of categories.entries()) {
        await tx.registration.create({ data: { tournamentId: tournament.id, studentId: created.id, ...category, ...tournament.terms, certificateNo: certificateNos[i]! } });
      }
    }
    return { student: created, account: await ensureAccount(tx, created.email) };
  });
  const entered = tournament && student.status === "APPROVED" ? await studentEntries(tournament.id, student.id) : [];
  // The registration email: username and password (Tamil Nadu: with the registration PDF; others: a temporary ID).
  emailRegistrationLater(student);
  res.status(201).json({
    status: student.status, studentNo: student.studentNo, tempId: student.studentNo ? null : tempIdOf(student), fullName: student.fullName, email: student.email, newAccount: account.created,
    entries: entered.map(entryView),
  });
});

// ─── Email verification ──────────────────────────────────────────────────────
// The Verify button next to the email: a 6-digit code is emailed, and checking it returns a token that
// the registration must carry.

const otpSendLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8 });
const otpVerifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const otpEmail = z.email("Enter a valid email address").max(254);

/** Email a 6-digit code; the returned token goes back with the code to /verify. */
router.post("/email-otp/send", otpSendLimiter, async (req, res) => {
  const address = otpEmail.parse(req.body?.email);
  const { otp, token } = createEmailOtp(address);
  await sendEmailOtp(address, otp);
  res.json({ token });
});

router.post("/email-otp/verify", otpVerifyLimiter, async (req, res) => {
  const { email: address, otp, token } = z.object({ email: otpEmail, otp: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"), token: z.string() }).parse(req.body);
  const problem = checkEmailOtp(token, address, otp);
  if (problem) throw new HttpError(400, problem);
  res.json({ verificationToken: createEmailVerifiedToken(address) });
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
  // Regular or late registration, by the schedule.
  const terms = newEntryTerms(tournament);
  if (!terms) throw new HttpError(409, closedReason(tournament));
  return { ...tournament, terms };
}

/** Referees can sign up as officials any time before the tournament starts. */
async function upcomingTournament(slug: string) {
  const tournament = await prisma.tournament.findFirst({ where: { slug, status: "PUBLISHED" } });
  if (!tournament) throw notFound("Tournament");
  if (registrationPhase(tournament) === "CLOSED") throw new HttpError(409, "This tournament has already started.");
  return tournament;
}

/** The student proves who they are with their ID and date of birth. */
async function identify(input: z.infer<typeof identifySchema>) {
  const student = await prisma.student.findUnique({ where: { studentNo: input.studentNo } });
  if (!student || !sameDay(student.dob, input.dob)) {
    throw new HttpError(404, "No student matches that ID and date of birth. Check both and try again.");
  }
  if (student.status !== "APPROVED") throw new HttpError(409, "This registration hasn't been approved yet.");
  return student;
}

const entryView = (r: { id: string; ageGroup: string; gender: string; weightCategory: string; weightKg: number; isLate: boolean }) => ({
  id: r.id, ageGroup: r.ageGroup, gender: r.gender, weightCategory: r.weightCategory, weightKg: r.weightKg, isLate: r.isLate,
});

const studentEntries = (tournamentId: string, studentId: string) =>
  prisma.registration.findMany({ where: { tournamentId, studentId }, orderBy: { createdAt: "asc" } });

/** Step 1: look the student up and tell them which age groups they can enter (e.g. a cadet: Cadet, Junior and Senior). */
router.post("/tournaments/:slug/entry/check", entryLimiter, async (req, res) => {
  const tournament = await openTournament(param(req, "slug"));
  const student = await identify(identifySchema.parse(req.body));
  res.json({
    student: { studentNo: student.studentNo, fullName: student.fullName, gender: student.gender },
    genderAllowed: tournament.gender === "BOTH" || student.gender === "OTHER" || tournament.gender === student.gender,
    ageGroups: eligibleAgeGroups(student.dob, tournament.startDate, tournament.ageGroups),
    lateRegistration: tournament.terms.isLate,
    entries: (await studentEntries(tournament.id, student.id)).map(entryView),
  });
});

const enterSchema = identifySchema.extend({
  ageGroups: z.array(z.string().min(1)).min(1, "Choose at least one category").max(8),
  weightKg: z.coerce.number().min(10, "Weight looks too low").max(250, "Weight looks too high"),
  competeAs: competeAsSchema,
});

/** Step 2: enter the chosen age groups (one entry each). Entering is free and confirmed straight away. */
router.post("/tournaments/:slug/entry", entryLimiter, async (req, res) => {
  const tournament = await openTournament(param(req, "slug"));
  const input = enterSchema.parse(req.body);
  const student = await identify(input);

  const already = new Set((await studentEntries(tournament.id, student.id)).map((r) => r.ageGroup));
  const ageGroups = [...new Set(input.ageGroups)].filter((g) => !already.has(g));
  if (!ageGroups.length) throw new HttpError(409, "You're already registered in these events.");
  const categories = await Promise.all(ageGroups.map((ageGroup) => playerCategory(tournament, student, { ...input, ageGroup, overrideAge: false })));
  const certificateNos = await Promise.all(categories.map(() => newCertificateNo()));
  await prisma.$transaction(async (tx) => {
    for (const [i, category] of categories.entries()) {
      await tx.registration.create({ data: { tournamentId: tournament.id, studentId: student.id, ...category, ...tournament.terms, certificateNo: certificateNos[i]! } });
    }
  });

  res.json({ entries: (await studentEntries(tournament.id, student.id)).map(entryView) });
});

// ─── Referee registration ────────────────────────────────────────────────────

const officialSchema = refereeSchema.extend({
  role: z.enum(REFEREE_ROLES).default("REFEREE"),
});

/**
 * A referee signs up as an official of a tournament. Their verified email identifies them, so a
 * referee who registered before is reused (and their details refreshed) instead of duplicated.
 * The organiser sets their mat later.
 */
router.post("/tournaments/:slug/officials", registerLimiter, async (req, res) => {
  const tournament = await upcomingTournament(param(req, "slug"));
  const { role, ...details } = officialSchema.parse(req.body);

  const official = await prisma.$transaction(async (tx) => {
    const known = await tx.referee.findFirst({ where: { email: { equals: details.email, mode: "insensitive" } } });
    const referee = known ? await tx.referee.update({ where: { id: known.id }, data: details }) : await tx.referee.create({ data: details });
    const already = await tx.tournamentReferee.findUnique({ where: { tournamentId_refereeId: { tournamentId: tournament.id, refereeId: referee.id } } });
    if (already) throw new HttpError(409, "You're already registered as an official for this tournament.");
    return tx.tournamentReferee.create({
      data: { tournamentId: tournament.id, refereeId: referee.id, role, certificateNo: await newCertificateNo() },
      include: { referee: true },
    });
  });
  res.status(201).json({ fullName: official.referee.fullName, role: official.role });
});

export default router;

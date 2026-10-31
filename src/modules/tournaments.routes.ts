import { Router } from "express";
import { z } from "zod";
import prisma from "../db.js";
import { HttpError, notFound } from "../middleware/errors.js";
import {
  AGE_GROUP_NAMES, REFEREE_ROLES, TOURNAMENT_LEVELS, eligibleAgeGroups, weightCategoryFor, weightClasses, type Gender,
} from "../lib/categories.js";
import type { Entrant } from "../lib/bracket.js";
import { categoryKey, findTournament, newCertificateNo, param, slugify } from "../lib/helpers.js";
import { confirmEntryPayment, createEntryOrder, verifySchema } from "../lib/payments.js";
import { createStudent, studentSchema } from "../lib/students.js";

const router = Router();

// ─── Tournaments ─────────────────────────────────────────────────────────────

const tournamentSchema = z
  .object({
    title: z.string().trim().min(3, "Title is required").max(150),
    description: z.string().trim().max(5000).default(""),
    venue: z.string().trim().min(2, "Venue is required").max(200),
    city: z.string().trim().max(80).default(""),
    startDate: z.coerce.date({ error: "Start date is required" }),
    endDate: z.coerce.date().nullable().optional(),
    level: z.enum(TOURNAMENT_LEVELS),
    gender: z.enum(["MALE", "FEMALE", "BOTH"]),
    ageGroups: z.array(z.enum(AGE_GROUP_NAMES as [string, ...string[]])).min(1, "Pick at least one age group"),
    entryFee: z.coerce.number().int().min(0).max(100000).default(0),
    numberOfMats: z.coerce.number().int().min(1).max(20).default(1),
    registrationOpen: z.boolean().default(true),
  })
  .refine((t) => !t.endDate || t.endDate >= t.startDate, { message: "End date cannot be before the start date", path: ["endDate"] });

router.get("/", async (_req, res) => {
  const tournaments = await prisma.tournament.findMany({
    orderBy: { startDate: "desc" },
    include: { _count: { select: { registrations: true, referees: true, draws: true } } },
  });
  const concluded = await prisma.draw.groupBy({ by: ["tournamentId"], where: { isConcluded: true }, _count: true });
  const concludedBy = new Map(concluded.map((c) => [c.tournamentId, c._count]));
  res.json(tournaments.map((t) => ({ ...t, concludedDraws: concludedBy.get(t.id) || 0 })));
});

router.post("/", async (req, res) => {
  const data = tournamentSchema.parse(req.body);
  const tournament = await prisma.tournament.create({ data: { ...data, endDate: data.endDate ?? null, slug: slugify(data.title) } });
  res.status(201).json(tournament);
});

router.get("/:id", async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  const [registrations, referees, draws] = await Promise.all([
    prisma.registration.findMany({ where: { tournamentId: tournament.id }, select: { ageGroup: true, gender: true, weightCategory: true, paymentStatus: true, amountPaid: true } }),
    prisma.tournamentReferee.count({ where: { tournamentId: tournament.id } }),
    prisma.draw.findMany({ where: { tournamentId: tournament.id }, select: { isConcluded: true } }),
  ]);
  const categories = new Set(registrations.map(categoryKey));
  res.json({
    ...tournament,
    stats: {
      registrations: registrations.length,
      paid: registrations.filter((r) => r.paymentStatus === "PAID").length,
      collected: registrations.reduce((sum, r) => sum + r.amountPaid, 0),
      referees,
      categories: categories.size,
      draws: draws.length,
      concludedDraws: draws.filter((d) => d.isConcluded).length,
    },
  });
});

router.put("/:id", async (req, res) => {
  const existing = await findTournament(param(req, "id"));
  const data = tournamentSchema.parse(req.body);
  if (existing.gender !== data.gender && data.gender !== "BOTH") {
    const clash = await prisma.registration.count({ where: { tournamentId: existing.id, gender: { not: data.gender } } });
    if (clash) throw new HttpError(409, `${clash} registered student(s) don't match the new gender. Remove them first.`);
  }
  const removedGroups = existing.ageGroups.filter((g) => !data.ageGroups.includes(g));
  if (removedGroups.length) {
    const clash = await prisma.registration.count({ where: { tournamentId: existing.id, ageGroup: { in: removedGroups } } });
    if (clash) throw new HttpError(409, `Students are registered in ${removedGroups.join(", ")}. Remove them before dropping that age group.`);
  }
  const tournament = await prisma.tournament.update({ where: { id: existing.id }, data: { ...data, endDate: data.endDate ?? null } });
  res.json(tournament);
});

router.delete("/:id", async (req, res) => {
  await findTournament(param(req, "id"));
  await prisma.tournament.delete({ where: { id: param(req, "id") } });
  res.json({ message: "Tournament deleted." });
});

const statusSchema = z.object({ action: z.enum(["publish", "unpublish", "complete", "reopen", "publishResults", "hideResults"]) });

/** Publishing workflow. Nothing here needs anyone else's approval. */
router.post("/:id/status", async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  const { action } = statusSchema.parse(req.body);
  let data: Record<string, unknown> = {};
  switch (action) {
    case "publish":
      data = { status: "PUBLISHED", publishedAt: tournament.publishedAt ?? new Date() };
      break;
    case "unpublish":
      data = { status: "DRAFT", resultsPublished: false };
      break;
    case "complete":
      data = { status: "COMPLETED", publishedAt: tournament.publishedAt ?? new Date(), registrationOpen: false };
      break;
    case "reopen":
      data = { status: "PUBLISHED" };
      break;
    case "publishResults": {
      const concluded = await prisma.draw.count({ where: { tournamentId: tournament.id, isConcluded: true } });
      if (!concluded) throw new HttpError(400, "Conclude at least one category before publishing results.");
      data = { resultsPublished: true, status: tournament.status === "DRAFT" ? "PUBLISHED" : tournament.status, publishedAt: tournament.publishedAt ?? new Date() };
      break;
    }
    case "hideResults":
      data = { resultsPublished: false };
      break;
  }
  res.json(await prisma.tournament.update({ where: { id: tournament.id }, data }));
});

// ─── Registrations ───────────────────────────────────────────────────────────

/** Which categories a student of gender OTHER competes in (judo categories are boys' or girls'). */
export const competeAsSchema = z.enum(["MALE", "FEMALE"]).optional();

const registrationSchema = z
  .object({
    studentId: z.string().uuid().optional(),
    student: studentSchema.optional(),
    /** Proof the new student's email was verified (POST /public/email-otp/verify) */
    emailVerificationToken: z.string().optional(),
    ageGroup: z.string().min(1, "Age group is required"),
    weightKg: z.coerce.number().min(10, "Weight looks too low").max(250, "Weight looks too high"),
    /** Leave empty to work it out from the weight */
    weightCategory: z.string().optional(),
    /** Skip the birth-year check for this age group */
    overrideAge: z.boolean().default(false),
    competeAs: competeAsSchema,
  })
  .refine((r) => r.studentId || r.student, { message: "Pick a student or enter new student details", path: ["studentId"] });

/** Draws that already contain this registration (it can't change category or be removed while drawn). */
async function drawsContaining(tournamentId: string, regId: string) {
  const draws = await prisma.draw.findMany({ where: { tournamentId }, select: { id: true, entrants: true, ageGroup: true, weightCategory: true } });
  return draws.filter((d) => (d.entrants as unknown as Entrant[]).some((e) => e.id === regId));
}

export async function resolveCategory(
  tournament: Awaited<ReturnType<typeof findTournament>>,
  student: { dob: Date; gender: string },
  input: { ageGroup: string; weightKg: number; weightCategory?: string | undefined; overrideAge: boolean; competeAs?: Gender | undefined },
) {
  const gender: Gender | undefined = student.gender === "OTHER" ? input.competeAs : (student.gender as Gender);
  if (!gender) throw new HttpError(400, "Choose whether to compete in the boys' or girls' categories.");
  if (tournament.gender !== "BOTH" && gender !== tournament.gender) {
    throw new HttpError(400, `This tournament is for ${tournament.gender === "MALE" ? "boys/men" : "girls/women"} only.`);
  }
  if (!tournament.ageGroups.includes(input.ageGroup)) throw new HttpError(400, `${input.ageGroup} is not an age group in this tournament.`);
  if (!input.overrideAge && !eligibleAgeGroups(student.dob, tournament.startDate, [input.ageGroup]).length) {
    throw new HttpError(400, `The student's birth year is outside ${input.ageGroup}. Tick "override age check" to enter them anyway.`);
  }
  const weightCategory = input.weightCategory || weightCategoryFor(input.weightKg, input.ageGroup, gender);
  if (!weightClasses(input.ageGroup, gender).includes(weightCategory)) throw new HttpError(400, `${weightCategory} is not a weight class for ${input.ageGroup}.`);
  return { ageGroup: input.ageGroup, gender, weightKg: input.weightKg, weightCategory };
}

router.get("/:id/registrations", async (req, res) => {
  const tournamentId = param(req, "id");
  await findTournament(tournamentId);
  const registrations = await prisma.registration.findMany({
    where: { tournamentId },
    include: { student: true },
    orderBy: [{ ageGroup: "asc" }, { gender: "asc" }, { weightCategory: "asc" }, { student: { fullName: "asc" } }],
  });
  res.json(registrations);
});

router.post("/:id/registrations", async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  if (!tournament.registrationOpen) throw new HttpError(409, "Registration is closed for this tournament. Reopen it from the Overview tab first.");
  const input = registrationSchema.parse(req.body);

  const student = input.studentId
    ? await prisma.student.findUnique({ where: { id: input.studentId } })
    : input.student!;
  if (!student) throw notFound("Student");

  const category = await resolveCategory(tournament, student, input);
  const certificateNo = await newCertificateNo();

  const registration = await prisma.$transaction(async (tx) => {
    const studentId = input.studentId ?? (await createStudent(tx, input.student!, input.emailVerificationToken)).id;
    return tx.registration.create({
      data: { tournamentId: tournament.id, studentId, ...category, certificateNo, paymentStatus: tournament.entryFee > 0 ? "PENDING" : "WAIVED" },
      include: { student: true },
    });
  });
  res.status(201).json(registration);
});

const updateRegistrationSchema = z.object({
  ageGroup: z.string().min(1),
  weightKg: z.coerce.number().min(10).max(250),
  weightCategory: z.string().optional(),
  overrideAge: z.boolean().default(false),
  competeAs: competeAsSchema,
});

router.put("/:id/registrations/:regId", async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  const existing = await prisma.registration.findFirst({ where: { id: param(req, "regId"), tournamentId: tournament.id }, include: { student: true } });
  if (!existing) throw notFound("Registration");
  const input = updateRegistrationSchema.parse(req.body);
  // An OTHER student keeps the categories they entered in unless told otherwise.
  const category = await resolveCategory(tournament, existing.student, { ...input, competeAs: input.competeAs ?? (existing.gender as Gender) });

  const categoryChanged = categoryKey(category) !== categoryKey(existing);
  if (categoryChanged && (await drawsContaining(tournament.id, existing.id)).length) {
    throw new HttpError(409, "This student is already in a draw. Delete that category's draw before changing their category.");
  }
  const registration = await prisma.registration.update({ where: { id: existing.id }, data: category, include: { student: true } });
  res.json(registration);
});

router.delete("/:id/registrations/:regId", async (req, res) => {
  const tournamentId = param(req, "id");
  const regId = param(req, "regId");
  const existing = await prisma.registration.findFirst({ where: { id: regId, tournamentId } });
  if (!existing) throw notFound("Registration");
  if ((await drawsContaining(tournamentId, regId)).length) {
    throw new HttpError(409, "This student is already in a draw. Delete that category's draw before removing them.");
  }
  await prisma.registration.delete({ where: { id: regId } });
  res.json({ message: "Registration removed." });
});

// ─── Payments ────────────────────────────────────────────────────────────────

async function findRegistration(tournamentId: string, regId: string) {
  const registration = await prisma.registration.findFirst({ where: { id: regId, tournamentId }, include: { student: true, tournament: true } });
  if (!registration) throw notFound("Registration");
  return registration;
}

router.post("/:id/registrations/:regId/payment/order", async (req, res) => {
  const registration = await findRegistration(param(req, "id"), param(req, "regId"));
  if (registration.tournament.entryFee <= 0) throw new HttpError(400, "This tournament has no entry fee.");
  if (registration.paymentStatus === "PAID") throw new HttpError(409, "This entry is already paid.");
  res.json(await createEntryOrder(registration, registration.tournament));
});

router.post("/:id/registrations/:regId/payment/verify", async (req, res) => {
  const registration = await findRegistration(param(req, "id"), param(req, "regId"));
  res.json(await confirmEntryPayment(registration, registration.tournament.entryFee, verifySchema.parse(req.body)));
});

const manualPaymentSchema = z.object({
  status: z.enum(["PENDING", "PAID", "WAIVED"]),
  mode: z.enum(["CASH", "UPI", "OTHER"]).optional(),
});

router.patch("/:id/registrations/:regId/payment", async (req, res) => {
  const registration = await findRegistration(param(req, "id"), param(req, "regId"));
  const { status, mode } = manualPaymentSchema.parse(req.body);
  if (registration.paymentMode === "RAZORPAY" && registration.paymentStatus === "PAID" && status !== "PAID") {
    throw new HttpError(409, "This entry was paid online through Razorpay. Refund it from the Razorpay dashboard first.");
  }
  const updated = await prisma.registration.update({
    where: { id: registration.id },
    data: status === "PAID"
      ? { paymentStatus: "PAID", paymentMode: mode ?? "CASH", amountPaid: registration.tournament.entryFee, paidAt: new Date() }
      : { paymentStatus: status, paymentMode: null, amountPaid: 0, paidAt: null },
    include: { student: true },
  });
  res.json(updated);
});

// ─── Referees / officials ────────────────────────────────────────────────────

const assignmentSchema = z.object({
  refereeId: z.string().uuid(),
  role: z.enum(REFEREE_ROLES),
  matNumber: z.coerce.number().int().min(1).max(20).nullable().optional(),
});

router.get("/:id/officials", async (req, res) => {
  const tournamentId = param(req, "id");
  await findTournament(tournamentId);
  const officials = await prisma.tournamentReferee.findMany({
    where: { tournamentId }, include: { referee: true }, orderBy: [{ role: "asc" }, { referee: { fullName: "asc" } }],
  });
  res.json(officials);
});

router.post("/:id/officials", async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  const data = assignmentSchema.parse(req.body);
  if (data.matNumber && data.matNumber > tournament.numberOfMats) throw new HttpError(400, `This tournament only has ${tournament.numberOfMats} mat(s).`);
  const official = await prisma.tournamentReferee.create({
    data: { tournamentId: tournament.id, refereeId: data.refereeId, role: data.role, matNumber: data.matNumber ?? null, certificateNo: await newCertificateNo() },
    include: { referee: true },
  });
  res.status(201).json(official);
});

router.put("/:id/officials/:officialId", async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  const data = assignmentSchema.omit({ refereeId: true }).parse(req.body);
  if (data.matNumber && data.matNumber > tournament.numberOfMats) throw new HttpError(400, `This tournament only has ${tournament.numberOfMats} mat(s).`);
  const existing = await prisma.tournamentReferee.findFirst({ where: { id: param(req, "officialId"), tournamentId: tournament.id } });
  if (!existing) throw notFound("Official");
  const official = await prisma.tournamentReferee.update({ where: { id: existing.id }, data: { role: data.role, matNumber: data.matNumber ?? null }, include: { referee: true } });
  res.json(official);
});

router.delete("/:id/officials/:officialId", async (req, res) => {
  const tournamentId = param(req, "id");
  const existing = await prisma.tournamentReferee.findFirst({ where: { id: param(req, "officialId"), tournamentId } });
  if (!existing) throw notFound("Official");
  await prisma.tournamentReferee.delete({ where: { id: existing.id } });
  res.json({ message: "Official removed." });
});

export default router;

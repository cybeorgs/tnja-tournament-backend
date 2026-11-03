import { Router } from "express";
import { z } from "zod";
import prisma from "../db.js";
import { HttpError, notFound } from "../middleware/errors.js";
import {
  AGE_GROUP_NAMES, REFEREE_ROLES, TOURNAMENT_LEVELS, eligibleAgeGroups, weightCategoryFor, weightClasses, type Gender,
} from "../lib/categories.js";
import type { Entrant } from "../lib/bracket.js";
import { categoryKey, findTournament, newCertificateNo, param, slugify } from "../lib/helpers.js";
import { confirmOrderPayment, createEntryOrder, verifySchema } from "../lib/payments.js";
import { ensureAccount } from "../lib/accounts.js";
import { confirmEntriesLater, resendPaymentReceipt, sendEntryConfirmations, sendRemindersNow } from "../lib/notifications.js";
import { confirmResidency, createStudent, studentSchema } from "../lib/students.js";
import { closedReason, newEntryTerms, repriceUnpaid } from "../lib/fees.js";

const router = Router();

// ─── Tournaments ─────────────────────────────────────────────────────────────

const tournamentSchema = z
  .object({
    title: z.string().trim().min(3, "Title is required").max(150),
    description: z.string().trim().max(5000).default(""),
    venue: z.string().trim().min(2, "Venue is required").max(200),
    city: z.string().trim().max(80).default(""),
    /** Date and time the tournament starts; registration closes at this moment */
    startDate: z.coerce.date({ error: "Start date and time are required" }),
    endDate: z.coerce.date().nullable().optional(),
    registrationOpensAt: z.coerce.date({ error: "Registration opening date and time are required" }),
    /** End of regular registration; late registration (at the late entry fee) runs from here until the start */
    registrationClosesAt: z.coerce.date({ error: "Regular registration closing date and time are required" }),
    /** When to email the deadline reminder to players with unpaid entries; null = don't send one */
    reminderAt: z.coerce.date().nullable().default(null),
    level: z.enum(TOURNAMENT_LEVELS),
    gender: z.enum(["MALE", "FEMALE", "BOTH"]),
    ageGroups: z.array(z.enum(AGE_GROUP_NAMES as [string, ...string[]])).min(1, "Pick at least one age group"),
    /** Regular entry fee */
    entryFee: z.coerce.number().int().min(0).max(100000).default(0),
    /** Late entry fee, set by the admin; not lower than the regular fee */
    lateEntryFee: z.coerce.number({ error: "Enter the late entry fee" }).int().min(0).max(100000),
    // Set on the tournament page (Officials tab), not the create/edit form. Left out, a new
    // tournament gets 1 mat and an edit keeps the current count.
    numberOfMats: z.coerce.number().int().min(1).max(20).optional(),
  })
  // The end date is a date only, so compare whole days (the start has a time of day).
  .refine((t) => !t.endDate || t.endDate.getTime() > t.startDate.getTime() - 24 * 60 * 60 * 1000, { message: "End date cannot be before the start date", path: ["endDate"] })
  .refine((t) => t.registrationOpensAt < t.registrationClosesAt, { message: "Regular registration must close after it opens", path: ["registrationClosesAt"] })
  .refine((t) => t.registrationClosesAt <= t.startDate, { message: "Regular registration must close before the tournament starts", path: ["registrationClosesAt"] })
  .refine((t) => t.lateEntryFee >= t.entryFee, { message: "The late entry fee can't be lower than the regular entry fee", path: ["lateEntryFee"] })
  .refine((t) => !t.reminderAt || (t.reminderAt > t.registrationOpensAt && t.reminderAt < t.registrationClosesAt), {
    message: "The reminder must be sent after registration opens and before regular registration closes",
    path: ["reminderAt"],
  });

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
  // A new tournament is live on the public site straight away; there is no draft stage.
  const tournament = await prisma.tournament.create({
    data: { ...data, endDate: data.endDate ?? null, slug: slugify(data.title), status: "PUBLISHED", publishedAt: new Date() },
  });
  res.status(201).json(tournament);
});

router.get("/:id", async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  await repriceUnpaid(tournament); // so amounts due are current
  const [registrations, referees, draws] = await Promise.all([
    prisma.registration.findMany({
      where: { tournamentId: tournament.id },
      select: { studentId: true, ageGroup: true, gender: true, weightCategory: true, paymentStatus: true, amountPaid: true, fee: true, isLate: true },
    }),
    prisma.tournamentReferee.count({ where: { tournamentId: tournament.id } }),
    prisma.draw.findMany({ where: { tournamentId: tournament.id }, select: { isConcluded: true } }),
  ]);
  const categories = new Set(registrations.map(categoryKey));
  const sum = (rows: typeof registrations, pick: (r: (typeof registrations)[number]) => number) => rows.reduce((total, r) => total + pick(r), 0);
  const paidEntries = registrations.filter((r) => r.paymentStatus === "PAID");
  const pendingEntries = registrations.filter((r) => r.paymentStatus === "PENDING");
  const players = new Set(registrations.map((r) => r.studentId));
  const playersOwing = new Set(pendingEntries.map((r) => r.studentId));
  res.json({
    ...tournament,
    stats: {
      registrations: registrations.length,
      paid: paidEntries.length,
      collected: sum(paidEntries, (r) => r.amountPaid),
      // Players (a player may enter several age groups)
      players: players.size,
      /** Players with every entry settled (paid or free) */
      paidPlayers: [...players].filter((id) => !playersOwing.has(id)).length,
      playersOwing: playersOwing.size,
      // Entries
      pendingPayments: pendingEntries.length,
      pendingAmount: sum(pendingEntries, (r) => r.fee),
      regularEntries: registrations.filter((r) => !r.isLate).length,
      lateEntries: registrations.filter((r) => r.isLate).length,
      regularRevenue: sum(paidEntries.filter((r) => !r.isLate), (r) => r.amountPaid),
      lateRevenue: sum(paidEntries.filter((r) => r.isLate), (r) => r.amountPaid),
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
  // Unpaid entries follow the fee policy (current period's fee); paid entries keep what they paid.
  await repriceUnpaid(tournament);
  res.json(tournament);
});

/** Change the number of mats. Can't drop a mat that a referee or a draw is still assigned to. */
router.patch("/:id/mats", async (req, res) => {
  const existing = await findTournament(param(req, "id"));
  const { numberOfMats } = z.object({ numberOfMats: z.coerce.number().int().min(1, "At least 1 mat").max(20, "At most 20 mats") }).parse(req.body);
  if (numberOfMats < existing.numberOfMats) {
    const onDropped = { tournamentId: existing.id, matNumber: { gt: numberOfMats } };
    const [officials, draws] = await Promise.all([prisma.tournamentReferee.count({ where: onDropped }), prisma.draw.count({ where: onDropped })]);
    if (officials || draws) {
      const what = [officials && `${officials} referee(s)`, draws && `${draws} draw(s)`].filter(Boolean).join(" and ");
      throw new HttpError(409, `${what} are on mat ${numberOfMats + 1} or higher. Move them to another mat first.`);
    }
  }
  res.json(await prisma.tournament.update({ where: { id: existing.id }, data: { numberOfMats } }));
});

router.delete("/:id", async (req, res) => {
  await findTournament(param(req, "id"));
  await prisma.tournament.delete({ where: { id: param(req, "id") } });
  res.json({ message: "Tournament deleted." });
});

const statusSchema = z.object({ action: z.enum(["complete", "reopen", "publishResults", "hideResults"]) });

/** Tournaments are published when created; this completes/reopens them and shows or hides results. */
router.post("/:id/status", async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  const { action } = statusSchema.parse(req.body);
  let data: Record<string, unknown> = {};
  switch (action) {
    case "complete":
      // A completed tournament takes no entries or payments (see registrationPhase).
      data = { status: "COMPLETED", publishedAt: tournament.publishedAt ?? new Date() };
      break;
    case "reopen":
      data = { status: "PUBLISHED" };
      break;
    case "publishResults": {
      const concluded = await prisma.draw.count({ where: { tournamentId: tournament.id, isConcluded: true } });
      if (!concluded) throw new HttpError(400, "Conclude at least one category before publishing results.");
      data = { resultsPublished: true, publishedAt: tournament.publishedAt ?? new Date() };
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
export async function drawsContaining(tournamentId: string, regId: string) {
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
  await repriceUnpaid(await findTournament(tournamentId)); // amounts due are current
  const registrations = await prisma.registration.findMany({
    where: { tournamentId },
    include: { student: true },
    orderBy: [{ ageGroup: "asc" }, { gender: "asc" }, { weightCategory: "asc" }, { student: { fullName: "asc" } }],
  });
  res.json(registrations);
});

router.post("/:id/registrations", async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  // Admin entries follow the same schedule: regular fee, then the late fee, none after the start.
  const terms = newEntryTerms(tournament);
  if (!terms) throw new HttpError(409, `${closedReason(tournament)} To change this, edit the registration dates.`);
  const input = registrationSchema.parse(req.body);

  const newStudent = input.student ? await confirmResidency(input.student) : null;
  const student = input.studentId ? await prisma.student.findUnique({ where: { id: input.studentId } }) : newStudent;
  if (!student) throw notFound("Student");
  if ("status" in student && student.status !== "APPROVED") throw new HttpError(409, "This student's application hasn't been approved yet.");
  if (input.studentId && (await prisma.registration.findUnique({ where: { tournamentId_studentId_ageGroup: { tournamentId: tournament.id, studentId: input.studentId, ageGroup: input.ageGroup } } }))) {
    throw new HttpError(409, `This student is already entered in ${input.ageGroup}.`);
  }

  const category = await resolveCategory(tournament, student, input);
  const certificateNo = await newCertificateNo();

  const registration = await prisma.$transaction(async (tx) => {
    let studentId = input.studentId;
    if (!studentId) {
      const created = await createStudent(tx, newStudent!, input.emailVerificationToken);
      await ensureAccount(tx, created.email);
      studentId = created.id;
    }
    return tx.registration.create({
      data: { tournamentId: tournament.id, studentId, ...category, ...terms, certificateNo },
      include: { student: true },
    });
  });
  // One email: the registration confirmation, which also carries the username and set-password link of a new account.
  confirmEntriesLater(tournament.id, registration.studentId);
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
  if (registration.fee <= 0) throw new HttpError(400, "This entry has no fee to pay.");
  if (registration.paymentStatus === "PAID") throw new HttpError(409, "This entry is already paid.");
  const order = await createEntryOrder([registration], registration.tournament);
  if (!order) throw new HttpError(409, "This entry has already been paid (an earlier online payment went through). Refresh the list.");
  res.json(order);
});

router.post("/:id/registrations/:regId/payment/verify", async (req, res) => {
  const registration = await findRegistration(param(req, "id"), param(req, "regId"));
  const paid = await confirmOrderPayment(registration.tournamentId, verifySchema.parse(req.body));
  res.json(paid.find((r) => r.id === registration.id) ?? paid[0]);
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
      ? { paymentStatus: "PAID", paymentMode: mode ?? "CASH", amountPaid: registration.fee, paidAt: new Date() }
      : { paymentStatus: status, paymentMode: null, amountPaid: 0, paidAt: null },
    include: { student: true },
  });
  res.json(updated);
});

// ─── Emails ──────────────────────────────────────────────────────────────────
// The three tournament emails: delivery log, and sending one on purpose (e.g. after fixing an email
// address). Automatic sends never repeat; a send from here is a deliberate one.

router.get("/:id/emails", async (req, res) => {
  const tournamentId = param(req, "id");
  await findTournament(tournamentId);
  const logs = await prisma.emailLog.findMany({ where: { tournamentId }, orderBy: { createdAt: "desc" }, take: 300 });
  const students = await prisma.student.findMany({ where: { id: { in: [...new Set(logs.map((l) => l.studentId).filter((id): id is string => !!id))] } }, select: { id: true, fullName: true } });
  const names = new Map(students.map((s) => [s.id, s.fullName]));
  res.json(logs.map((l) => ({ ...l, studentName: l.studentId ? names.get(l.studentId) ?? null : null })));
});

const sendEmailSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CONFIRMATION"), studentId: z.string().uuid() }),
  z.object({ kind: z.literal("REMINDER"), studentId: z.string().uuid().optional() }),
  z.object({ kind: z.literal("PAYMENT"), studentId: z.string().uuid() }),
]);

/** Send one of the three emails now. A reminder without a player goes to everyone unpaid who hasn't had one. */
router.post("/:id/emails", async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  const input = sendEmailSchema.parse(req.body);
  if (input.kind === "REMINDER") return res.json({ sent: await sendRemindersNow(tournament.id, input.studentId) });
  const delivery = input.kind === "CONFIRMATION" ? await sendEntryConfirmations(tournament.id, input.studentId, "MANUAL") : await resendPaymentReceipt(tournament.id, input.studentId);
  res.json({ sent: delivery ? 1 : 0, status: delivery?.status ?? null, error: delivery?.error ?? "" });
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

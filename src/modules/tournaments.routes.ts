import { Router } from "express";
import { z } from "zod";
import prisma from "../db.js";
import { HttpError, notFound } from "../middleware/errors.js";
import {
  AGE_GROUP_NAMES, REFEREE_ROLES, TOURNAMENT_LEVELS, eligibleAgeGroups, weightCategoryFor, weightClasses, type Gender,
} from "../lib/categories.js";
import type { Entrant } from "../lib/bracket.js";
import { categoryKey, findTournament, newCertificateNo, param, slugify } from "../lib/helpers.js";
import { ensureAccount } from "../lib/accounts.js";
import { adminActor, entryLabel, recordEntriesAdded, recordEntryUpdated, recordPaymentAudit, recordStudentAudit } from "../lib/audit.js";
import { emailRegistrationLater } from "../lib/registrationEmails.js";
import { confirmResidency, createStudent, studentSchema } from "../lib/students.js";
import { closedReason, newEntryTerms, repriceEntries } from "../lib/fees.js";
import { entryPassPdf, entryPassReady, loadEntryPass, sendEntryPassesLater } from "../lib/entryPass.js";
import { sendPdf } from "./certificates.js";
import { DATE, DATE_TIME, maskAadhaar, sendWorkbook, yearAge, type Column } from "../lib/excel.js";

const router = Router();

// ─── Tournaments ─────────────────────────────────────────────────────────────

/** An empty box is "not entered", not 0 (coercing "" would quietly make a fee free). */
const blankToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);

const tournamentSchema = z
  .object({
    title: z.string().trim().min(3, "Title is required").max(150),
    description: z.string().trim().max(5000).default(""),
    venue: z.string().trim().min(2, "Venue is required").max(200),
    city: z.string().trim().max(80).default(""),
    /** Date and time the tournament starts */
    startDate: z.coerce.date({ error: "Start date and time are required" }),
    endDate: z.coerce.date().nullable().optional(),
    registrationOpensAt: z.coerce.date({ error: "Registration opening date and time are required" }),
    /** Registration closes here. There is no late registration. */
    registrationClosesAt: z.coerce.date({ error: "Registration closing date and time are required" }),
    /** Fee for a player's first category (age group), in rupees; 0 = free */
    entryFee: z.preprocess(blankToUndefined, z.coerce.number({ error: "Enter the first category fee" }).int("Use whole rupees").min(0, "The fee can't be negative").max(100000)),
    /** Fee for each further category the same player enters; at most entryFee */
    additionalEntryFee: z.preprocess(blankToUndefined, z.coerce.number({ error: "Enter the fee for each additional category" }).int("Use whole rupees").min(0, "The fee can't be negative").max(100000)),
    level: z.enum(TOURNAMENT_LEVELS),
    gender: z.enum(["MALE", "FEMALE", "BOTH"]),
    ageGroups: z.array(z.enum(AGE_GROUP_NAMES as [string, ...string[]])).min(1, "Pick at least one age group"),
    // Set on the tournament page (Officials tab), not the create/edit form. Left out, a new
    // tournament gets 1 mat and an edit keeps the current count.
    numberOfMats: z.coerce.number().int().min(1).max(20).optional(),
  })
  // The end date is a date only, so compare whole days (the start has a time of day).
  .refine((t) => !t.endDate || t.endDate.getTime() > t.startDate.getTime() - 24 * 60 * 60 * 1000, { message: "End date cannot be before the start date", path: ["endDate"] })
  .refine((t) => t.registrationOpensAt < t.registrationClosesAt, { message: "Registration must close after it opens", path: ["registrationClosesAt"] })
  .refine((t) => t.registrationClosesAt <= t.startDate, { message: "Registration must close before the tournament starts", path: ["registrationClosesAt"] })
  .refine((t) => t.additionalEntryFee <= t.entryFee, { message: "The additional category fee can't be more than the first category fee", path: ["additionalEntryFee"] });

/** Late registration and payment reminders are gone: these old columns always stay empty. */
const noLate = { lateEntryFee: 0, reminderAt: null };

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
    data: { ...data, ...noLate, endDate: data.endDate ?? null, slug: slugify(data.title), status: "PUBLISHED", publishedAt: new Date() },
  });
  res.status(201).json(tournament);
});

router.get("/:id", async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  const [registrations, referees, draws] = await Promise.all([
    prisma.registration.findMany({
      where: { tournamentId: tournament.id },
      select: { studentId: true, ageGroup: true, gender: true, weightCategory: true, weighInStatus: true, paymentStatus: true, fee: true, amountPaid: true },
    }),
    prisma.tournamentReferee.count({ where: { tournamentId: tournament.id } }),
    prisma.draw.findMany({ where: { tournamentId: tournament.id }, select: { isConcluded: true } }),
  ]);
  const categories = new Set(registrations.map(categoryKey));
  const players = new Set(registrations.map((r) => r.studentId));
  res.json({
    ...tournament,
    stats: {
      registrations: registrations.length,
      // Players (a player may enter several age groups)
      players: players.size,
      paidEntries: registrations.filter((r) => r.paymentStatus === "PAID").length,
      unpaidEntries: registrations.filter((r) => r.paymentStatus === "PENDING").length,
      amountCollected: registrations.reduce((n, r) => n + (r.paymentStatus === "PAID" ? r.amountPaid : 0), 0),
      amountDue: registrations.reduce((n, r) => n + (r.paymentStatus === "PENDING" ? r.fee : 0), 0),
      weighedIn: registrations.filter((r) => r.weighInStatus === "CLEARED").length,
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
  const tournament = await prisma.$transaction(async (tx) => {
    const updated = await tx.tournament.update({ where: { id: existing.id }, data: { ...data, ...noLate, endDate: data.endDate ?? null } });
    if (data.entryFee !== existing.entryFee || data.additionalEntryFee !== existing.additionalEntryFee) {
      // Unpaid entries owe the new fees (first category full, the rest the additional fee). Paid entries keep what they paid.
      await repriceEntries(tx, existing.id);
    }
    return updated;
  });
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
    ageGroup: z.string().min(1).optional(),
    /** Enter several age groups at once (e.g. a cadet in Cadet, Junior and Senior): one entry each */
    ageGroups: z.array(z.string().min(1)).max(8).optional(),
    weightKg: z.coerce.number().min(10, "Weight looks too low").max(250, "Weight looks too high"),
    /** Leave empty to work it out from the weight (only used when entering a single age group) */
    weightCategory: z.string().optional(),
    /** Skip the birth-year check for this age group */
    overrideAge: z.boolean().default(false),
    competeAs: competeAsSchema,
  })
  .refine((r) => r.studentId || r.student, { message: "Pick a student or enter new student details", path: ["studentId"] })
  .refine((r) => r.ageGroup || r.ageGroups?.length, { message: "Choose at least one age group", path: ["ageGroups"] });

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

/** Every entry in the tournament with the student's details, as an Excel sheet. Aadhaar numbers are masked. */
router.get("/:id/registrations/export", async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  const rows = await prisma.registration.findMany({
    where: { tournamentId: tournament.id },
    include: { student: true },
    orderBy: [{ ageGroup: "asc" }, { gender: "asc" }, { weightCategory: "asc" }, { student: { fullName: "asc" } }],
  });
  type R = (typeof rows)[number];
  const label = (v: string | null | undefined, map: Record<string, string>) => (v ? map[v] ?? v : "");
  const columns: Column<R>[] = [
    { header: "Student ID", width: 16, value: (r) => r.student.studentNo },
    { header: "Full name", width: 26, value: (r) => r.student.fullName },
    { header: "Gender", value: (r) => r.student.gender },
    { header: "Date of birth", value: (r) => r.student.dob, format: DATE },
    { header: "Age", value: (r) => yearAge(r.student.dob, tournament.startDate) },
    { header: "Age group", width: 18, value: (r) => r.ageGroup },
    { header: "Category", value: (r) => (r.gender === "MALE" ? "Boys" : "Girls") },
    { header: "Weight class", value: (r) => r.weightCategory },
    { header: "Weight entered (kg)", value: (r) => r.weightKg },
    { header: "Weigh-in", value: (r) => label(r.weighInStatus, { PENDING: "Not weighed", CLEARED: "Cleared", DISQUALIFIED: "Disqualified" }) },
    { header: "Scale weight (kg)", value: (r) => r.weighInKg },
    { header: "Weighed at", value: (r) => r.weighedAt, format: DATE_TIME },
    { header: "Club", width: 22, value: (r) => r.student.club },
    { header: "Root coach", width: 20, value: (r) => r.student.rootCoach },
    { header: "Belt", value: (r) => r.student.belt },
    { header: "District", width: 16, value: (r) => r.student.district },
    { header: "State", width: 16, value: (r) => r.student.state },
    { header: "Phone", width: 14, value: (r) => r.student.phone },
    { header: "Parent / emergency contact", width: 16, value: (r) => r.student.parentPhone || r.student.emergencyPhone },
    { header: "Email", width: 28, value: (r) => r.student.email },
    { header: "Father's name", width: 22, value: (r) => r.student.fatherName },
    { header: "Blood group", value: (r) => r.student.bloodGroup },
    { header: "Aadhaar", width: 18, value: (r) => maskAadhaar(r.student.aadhaarNumber) },
    { header: "Type", value: (r) => (r.student.participantType === "PROFESSIONAL" ? "Working professional" : "Student") },
    { header: "Institution / organisation", width: 28, value: (r) => (r.student.participantType === "PROFESSIONAL" ? r.student.organisationName : r.student.institutionName) },
    { header: "Fee (₹)", value: (r) => r.fee },
    { header: "Payment", value: (r) => label(r.paymentStatus, { PENDING: "Unpaid", PAID: "Paid", WAIVED: "Free" }) },
    { header: "Amount paid (₹)", value: (r) => r.amountPaid },
    { header: "Paid on", value: (r) => r.paidAt, format: DATE_TIME },
    { header: "Placement", value: (r) => label(r.placement, { FIRST: "1st", SECOND: "2nd", THIRD: "3rd", PARTICIPATION: "Participation" }) },
    { header: "Certificate no.", width: 18, value: (r) => r.certificateNo },
    { header: "Registered on", value: (r) => r.createdAt, format: DATE_TIME },
  ];
  await sendWorkbook(res, `${tournament.slug}_entries.xlsx`, "Entries", columns, rows);
});

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
  // Admin entries follow the same schedule and are charged the same entry fee.
  const terms = newEntryTerms(tournament);
  if (!terms) throw new HttpError(409, `${closedReason(tournament)} To change this, edit the registration dates.`);
  const input = registrationSchema.parse(req.body);

  const newStudent = input.student ? await confirmResidency(input.student) : null;
  const student = input.studentId ? await prisma.student.findUnique({ where: { id: input.studentId } }) : newStudent;
  if (!student) throw notFound("Student");
  if ("status" in student && student.status !== "APPROVED") throw new HttpError(409, "This student's application hasn't been approved yet.");
  const ageGroups = [...new Set(input.ageGroups?.length ? input.ageGroups : [input.ageGroup!])];
  if (input.studentId) {
    const taken = await prisma.registration.findMany({ where: { tournamentId: tournament.id, studentId: input.studentId, ageGroup: { in: ageGroups } }, select: { ageGroup: true } });
    if (taken.length) throw new HttpError(409, `This student is already entered in ${taken.map((r) => r.ageGroup).join(", ")}.`);
  }

  // A hand-picked weight class only makes sense for a single age group; otherwise each comes from the weight.
  const categories = await Promise.all(ageGroups.map((ageGroup) =>
    resolveCategory(tournament, student, { ...input, ageGroup, weightCategory: ageGroups.length === 1 ? input.weightCategory : undefined }),
  ));
  const certificateNos = await Promise.all(categories.map(() => newCertificateNo()));

  // All or nothing: the student (if new) and every entry are created together.
  let createdStudent: Awaited<ReturnType<typeof createStudent>> | null = null;
  const registrations = await prisma.$transaction(async (tx) => {
    let studentId = input.studentId;
    if (!studentId) {
      const created = await createStudent(tx, newStudent!, { actor: adminActor(req) });
      await ensureAccount(tx, created.email);
      studentId = created.id;
      createdStudent = created;
    }
    const ids = [];
    for (const [i, category] of categories.entries()) {
      ids.push((await tx.registration.create({ data: { tournamentId: tournament.id, studentId, ...category, ...terms, certificateNo: certificateNos[i]! } })).id);
    }
    // The player's first category pays the full fee, further ones the additional fee.
    await repriceEntries(tx, tournament.id, studentId);
    const created = await tx.registration.findMany({ where: { id: { in: ids } }, include: { student: true }, orderBy: { createdAt: "asc" } });
    if (created[0]) await recordEntriesAdded(tx, created[0].student, tournament.title, created, adminActor(req));
    return created;
  });
  // A student created here gets the registration email (username, password, PDF). In a free
  // event the Tournament Entry Pass is emailed now; otherwise once it is paid.
  if (createdStudent) emailRegistrationLater(createdStudent, { trigger: "ADMIN", actor: req.admin?.username || "admin" });
  if (registrations[0]) sendEntryPassesLater(tournament.id, registrations[0].studentId, { trigger: "ADMIN", actor: req.admin?.username || "admin" });
  res.status(201).json(input.ageGroups ? registrations : registrations[0]);
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
  // A weigh-in only holds for the category it was checked against.
  const weighIn = categoryChanged && existing.weighInStatus !== "PENDING" ? { weighInStatus: "PENDING", weighInKg: null, weighedAt: null } : {};
  // The change and its audit entry are saved together.
  const registration = await prisma.$transaction(async (tx) => {
    const updated = await tx.registration.update({ where: { id: existing.id }, data: { ...category, ...weighIn }, include: { student: true } });
    await recordEntryUpdated(tx, existing.student, tournament.title, existing, updated, adminActor(req));
    return updated;
  });
  res.json(registration);
});

// ─── Weigh-in ────────────────────────────────────────────────────────────────
// Every entrant is weighed before their category's draw is made (draws.routes refuses to draw a
// category while anyone in it is still PENDING). The scale weight must fall in the registered weight
// class; if it doesn't, the admin moves the player to the class the scale says, or disqualifies them.

const weighInSchema = z.discriminatedUnion("action", [
  /** Record the scale weight; it must be within the registered class */
  z.object({ action: z.literal("RECORD"), weightKg: z.coerce.number().min(10, "Weight looks too low").max(250, "Weight looks too high") }),
  /** Scale weight is in another class: move the player there (cleared) */
  z.object({ action: z.literal("MOVE"), weightKg: z.coerce.number().min(10).max(250) }),
  /** Leave the player out of the draw */
  z.object({ action: z.literal("DISQUALIFY"), weightKg: z.coerce.number().min(10).max(250).optional() }),
  /** Undo: back to not weighed */
  z.object({ action: z.literal("RESET") }),
]);

router.patch("/:id/registrations/:regId/weigh-in", async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  const existing = await prisma.registration.findFirst({ where: { id: param(req, "regId"), tournamentId: tournament.id }, include: { student: true } });
  if (!existing) throw notFound("Registration");
  const input = weighInSchema.parse(req.body);
  if ((await drawsContaining(tournament.id, existing.id)).length) {
    throw new HttpError(409, "This player is already in a generated draw. Delete that category's draw before changing the weigh-in.");
  }

  const now = new Date();
  let data: Record<string, unknown>;
  if (input.action === "RESET") {
    data = { weighInStatus: "PENDING", weighInKg: null, weighedAt: null };
  } else if (input.action === "DISQUALIFY") {
    data = { weighInStatus: "DISQUALIFIED", weighInKg: input.weightKg ?? existing.weighInKg, weighedAt: now };
  } else {
    const scaleClass = weightCategoryFor(input.weightKg, existing.ageGroup, existing.gender as Gender);
    if (input.action === "RECORD") {
      if (scaleClass !== existing.weightCategory) {
        throw new HttpError(409, `${input.weightKg} kg is in the ${scaleClass} class, not ${existing.weightCategory}. Move the player to ${scaleClass} or disqualify them.`);
      }
      data = { weighInStatus: "CLEARED", weighInKg: input.weightKg, weighedAt: now };
    } else {
      // MOVE: the class the scale says (same age group and gender); the entry's weight becomes the scale weight.
      data = { weighInStatus: "CLEARED", weighInKg: input.weightKg, weighedAt: now, weightKg: input.weightKg, weightCategory: scaleClass };
    }
  }
  // The weigh-in and its audit entry are saved together.
  res.json(await prisma.$transaction(async (tx) => {
    const updated = await tx.registration.update({ where: { id: existing.id }, data, include: { student: true } });
    await recordEntryUpdated(tx, existing.student, tournament.title, existing, updated, adminActor(req));
    return updated;
  }));
});

const PAY_MODE_LABEL = { CASH: "cash", UPI: "UPI", OTHER: "other" } as const;

const paymentSchema = z.object({
  /** PAID: payment received outside the website (cash, UPI…). PENDING: undo that. */
  status: z.enum(["PAID", "PENDING"]),
  mode: z.enum(["CASH", "UPI", "OTHER"]).default("CASH"),
  /** Why the status is being changed (e.g. the UPI reference, or why it's being undone); kept in the audit log */
  remark: z.string().trim().min(3, "Enter a remark (at least 3 characters).").max(500, "Keep the remark under 500 characters."),
});

/** Record a payment taken by hand (or undo it). Paying an event emails its Tournament Entry Pass. */
router.patch("/:id/registrations/:regId/payment", async (req, res) => {
  const tournamentId = param(req, "id");
  const existing = await prisma.registration.findFirst({ where: { id: param(req, "regId"), tournamentId }, include: { tournament: { select: { title: true } } } });
  if (!existing) throw notFound("Registration");
  const input = paymentSchema.parse(req.body);
  if (existing.paymentStatus === "WAIVED") throw new HttpError(409, "This entry is free — there is nothing to pay.");
  if (input.status === "PENDING" && existing.paymentMode === "RAZORPAY") throw new HttpError(409, "This entry was paid online, so it can't be marked unpaid here.");
  const data = input.status === "PAID"
    ? { paymentStatus: "PAID", paymentMode: input.mode, amountPaid: existing.fee, paidAt: new Date() }
    : { paymentStatus: "PENDING", paymentMode: null, amountPaid: 0, paidAt: null };
  // The change and its audit entry are saved together.
  const saved = await prisma.$transaction(async (tx) => {
    const updated = await tx.registration.update({ where: { id: existing.id }, data, include: { student: true } });
    await recordPaymentAudit(tx, updated.student, { ...existing, tournament: existing.tournament.title }, existing, updated, adminActor(req),
      `${input.status === "PAID" ? `Payment recorded by admin (${PAY_MODE_LABEL[input.mode]})` : "Marked unpaid by admin"} — Remark: ${input.remark}`);
    return updated;
  });
  if (input.status === "PAID") sendEntryPassesLater(tournamentId, existing.studentId, { trigger: "ADMIN", actor: req.admin?.username || "admin" });
  res.json(saved);
});

/** One event's Tournament Entry Pass (once paid or free). ?download=1 to save it. */
router.get("/:id/registrations/:regId/entry-pass", async (req, res) => {
  const data = await loadEntryPass(param(req, "regId"));
  if (!data || data.tournament.id !== param(req, "id")) throw notFound("Entry");
  if (!entryPassReady(data.entry)) throw new HttpError(409, "The entry pass is issued once this event is paid.");
  const pdf = await entryPassPdf(data);
  sendPdf(res, pdf.content, pdf.filename, req.query.download === "1");
});

router.delete("/:id/registrations/:regId", async (req, res) => {
  const tournamentId = param(req, "id");
  const regId = param(req, "regId");
  const existing = await prisma.registration.findFirst({ where: { id: regId, tournamentId }, include: { student: true, tournament: { select: { title: true } } } });
  if (!existing) throw notFound("Registration");
  if ((await drawsContaining(tournamentId, regId)).length) {
    throw new HttpError(409, "This student is already in a draw. Delete that category's draw before removing them.");
  }
  const { reason } = z.object({ reason: z.string().trim().max(500, "Keep the reason under 500 characters.").default("") }).parse(req.body ?? {});
  // The removal and its audit entry (with the entry's payment at the time) are saved together.
  await prisma.$transaction(async (tx) => {
    await tx.registration.delete({ where: { id: regId } });
    const payment = existing.paymentStatus === "PAID"
      ? `was paid ₹${existing.amountPaid}${existing.paymentMode ? ` (${existing.paymentMode.toLowerCase()})` : ""}`
      : existing.paymentStatus === "WAIVED" ? "was free" : `was unpaid (₹${existing.fee} due)`;
    await recordStudentAudit(tx, existing.student, "ENTRY_REMOVED", adminActor(req), {
      note: [entryLabel(existing.tournament.title, existing), payment, reason && `Reason: ${reason}`].filter(Boolean).join(" — "),
    });
  });
  // Removing the first category moves the full fee to the player's next unpaid entry.
  await repriceEntries(prisma, tournamentId, existing.studentId);
  res.json({ message: "Registration removed." });
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

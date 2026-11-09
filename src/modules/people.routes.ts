// Master lists: students (athletes) and referees. Both are reusable across tournaments.
import express, { Router } from "express";
import { z } from "zod";
import prisma from "../db.js";
import { HttpError, notFound } from "../middleware/errors.js";
import { param } from "../lib/helpers.js";
import { DOCUMENT_KINDS, PARTICIPANT_TYPES, approveStudent, assertAadhaarFree, confirmResidency, createStudent, studentSchema } from "../lib/students.js";
import { ensureAccount } from "../lib/accounts.js";
import { DATE, DATE_TIME, maskAadhaar, sendSheets, sheet, yearAge, type Column } from "../lib/excel.js";
import { AGE_GROUPS, AGE_GROUP_NAMES, eligibleAgeGroups } from "../lib/categories.js";
import { categoryLabel } from "../lib/certificate.js";
import { checkRows, readSheet, templateWorkbook } from "../lib/studentImport.js";
import { getJob, startJob } from "../lib/importJobs.js";
import { undeliverable } from "../lib/importSheet.js";
import { emailApproval, emailRegistration, emailRegistrationLater } from "../lib/registrationEmails.js";
import { adminActor, diffStudent, recordStudentAudit } from "../lib/audit.js";

const listQuery = z.object({
  q: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// ─── Students ────────────────────────────────────────────────────────────────

export const studentsRouter = Router();

function studentWhere(query: unknown) {
  const { q } = z.object({ q: z.string().trim().optional() }).parse(query);
  const status = z.enum(["APPROVED", "PENDING", "REJECTED"]).optional().parse((query as Record<string, unknown>).status || undefined);
  const participantType = z.enum(PARTICIPANT_TYPES).optional().parse((query as Record<string, unknown>).type || undefined);
  const where = {
    ...(status ? { status } : {}),
    ...(participantType ? { participantType } : {}),
    ...(q
      ? { OR: [{ fullName: { contains: q, mode: "insensitive" as const } }, { studentNo: { contains: q, mode: "insensitive" as const } }, { club: { contains: q, mode: "insensitive" as const } }, { phone: { contains: q } }, { email: { contains: q.toLowerCase() } }] }
      : {}),
  };
  return { where, status };
}

studentsRouter.get("/", async (req, res) => {
  const { page, pageSize } = listQuery.parse(req.query);
  const { where, status } = studentWhere(req.query);
  const [items, total, pending] = await Promise.all([
    prisma.student.findMany({
      where, orderBy: status === "PENDING" ? { createdAt: "asc" } : { fullName: "asc" }, skip: (page - 1) * pageSize, take: pageSize,
      include: { _count: { select: { registrations: true } } },
    }),
    prisma.student.count({ where }),
    prisma.student.count({ where: { status: "PENDING" } }),
  ]);
  res.json({ items, total, page, pageSize, pending });
});

/** Counts for the tiles above the list. Rejected applications aren't counted. */
studentsRouter.get("/stats", async (_req, res) => {
  const byType = await prisma.student.groupBy({ by: ["participantType", "status"], where: { status: { not: "REJECTED" } }, _count: { _all: true } });
  const count = (match: (r: (typeof byType)[number]) => boolean) => byType.filter(match).reduce((n, r) => n + r._count._all, 0);
  res.json({
    total: count(() => true),
    students: count((r) => r.participantType !== "PROFESSIONAL"),
    professionals: count((r) => r.participantType === "PROFESSIONAL"),
    pending: count((r) => r.status === "PENDING"),
  });
});

const LABEL = {
  status: { APPROVED: "Approved", PENDING: "Waiting for approval", REJECTED: "Rejected" } as Record<string, string>,
  gender: { MALE: "Male", FEMALE: "Female", OTHER: "Other" } as Record<string, string>,
  weighIn: { PENDING: "Not weighed", CLEARED: "Cleared", DISQUALIFIED: "Disqualified" } as Record<string, string>,
  placement: { FIRST: "1st", SECOND: "2nd", THIRD: "3rd", PARTICIPATION: "Participation" } as Record<string, string>,
  document: { BPL_PROOF: "BPL proof", NATIVITY_PROOF: "Nativity proof" } as Record<string, string>,
  participant: { STUDENT: "Student", PROFESSIONAL: "Working professional" } as Record<string, string>,
  employment: { PRIVATE: "Private", GOVERNMENT: "Government", SELF_EMPLOYED: "Self-employed", OTHER: "Other" } as Record<string, string>,
};
const label = (map: Record<string, string>, v: string | null | undefined) => (v ? map[v] ?? v : "");

/**
 * Every student matching the list's search and status filter, with all their registration details and
 * their categories, as Excel: a "Students" sheet (one row per student) and a "Categories" sheet (one row
 * per tournament entry). Aadhaar numbers are masked; uploaded documents are listed, not attached.
 */
studentsRouter.get("/export", async (req, res) => {
  const { where, status } = studentWhere(req.query);
  const students = await prisma.student.findMany({
    where,
    orderBy: { fullName: "asc" },
    include: {
      documents: { select: { kind: true, label: true } },
      registrations: {
        include: { tournament: { select: { title: true, startDate: true } } },
        orderBy: [{ tournament: { startDate: "desc" } }, { ageGroup: "asc" }],
      },
    },
  });
  type S = (typeof students)[number];
  type R = S["registrations"][number] & { student: S };
  const now = new Date();
  /** The age group whose own band holds this year's age (e.g. 16 → Cadet) */
  const ownGroup = (s: S) => AGE_GROUPS.find((g) => yearAge(s.dob, now) >= g.minAge && yearAge(s.dob, now) <= g.maxAge)?.name ?? "";
  const categoriesOf = (s: S) =>
    [...new Map(s.registrations.map((r) => [r.tournamentId, r.tournament.title])).entries()]
      .map(([id, title]) => `${title}: ${s.registrations.filter((r) => r.tournamentId === id).map((r) => categoryLabel(r.ageGroup, r.gender, r.weightCategory)).join(", ")}`)
      .join(" | ");

  const studentColumns: Column<S>[] = [
    { header: "Student ID", width: 16, value: (s) => s.studentNo },
    { header: "Status", width: 18, value: (s) => label(LABEL.status, s.status) },
    { header: "Type", width: 20, value: (s) => label(LABEL.participant, s.participantType) },
    { header: "Full name", width: 26, value: (s) => s.fullName },
    { header: "Gender", value: (s) => label(LABEL.gender, s.gender) },
    { header: "Date of birth", value: (s) => s.dob, format: DATE },
    { header: "Age (this year)", value: (s) => yearAge(s.dob, now) },
    { header: "Age group", width: 26, value: ownGroup },
    { header: "Events they can play", width: 26, value: (s) => eligibleAgeGroups(s.dob, now, AGE_GROUP_NAMES).join(", ") },
    { header: "Father's name", width: 22, value: (s) => s.fatherName },
    { header: "Mother's name", width: 22, value: (s) => s.motherName },
    { header: "Phone", width: 14, value: (s) => s.phone },
    { header: "Parent / emergency contact", width: 16, value: (s) => s.parentPhone || s.emergencyPhone },
    { header: "Email", width: 28, value: (s) => s.email },
    { header: "Blood group", value: (s) => s.bloodGroup },
    { header: "Aadhaar", width: 18, value: (s) => maskAadhaar(s.aadhaarNumber) },
    { header: "Nationality", value: (s) => s.nationality },
    { header: "Residing pincode", value: (s) => s.residingPincode },
    { header: "District", width: 16, value: (s) => s.district },
    { header: "Taluk", width: 16, value: (s) => s.taluk },
    { header: "Outside Tamil Nadu", value: (s) => s.outsideTamilNadu },
    { header: "Address", width: 36, value: (s) => s.address },
    { header: "City", width: 16, value: (s) => s.city },
    { header: "State", width: 16, value: (s) => s.state },
    { header: "Pincode", value: (s) => s.pincode },
    { header: "Annual income", value: (s) => s.annualIncome, format: "#,##0" },
    { header: "BPL", value: (s) => s.isBPL },
    { header: "Institution type", value: (s) => s.institutionType },
    { header: "Institution", width: 28, value: (s) => s.institutionName },
    { header: "Standard / year", value: (s) => s.grade },
    { header: "Department", width: 18, value: (s) => s.degreeDepartment },
    { header: "Employment type", width: 16, value: (s) => label(LABEL.employment, s.employmentType) },
    { header: "Organisation", width: 28, value: (s) => s.organisationName },
    { header: "Designation", width: 20, value: (s) => s.occupation },
    { header: "Club", width: 22, value: (s) => s.club },
    { header: "Coach", width: 20, value: (s) => s.coachName },
    { header: "Belt", value: (s) => s.belt },
    { header: "Documents uploaded", width: 22, value: (s) => s.documents.map((d) => d.label || label(LABEL.document, d.kind)).join(", ") },
    { header: "Registered by", value: (s) => (s.source === "SELF" ? "Self" : "Admin") },
    { header: "Registered on", value: (s) => s.createdAt, format: DATE_TIME },
    { header: "Reviewed on", value: (s) => s.reviewedAt, format: DATE_TIME },
    { header: "Review note", width: 24, value: (s) => s.reviewNote },
    { header: "Tournaments entered", value: (s) => new Set(s.registrations.map((r) => r.tournamentId)).size },
    { header: "Categories entered", value: (s) => s.registrations.length },
    { header: "Categories", width: 60, value: categoriesOf },
  ];

  const entries: R[] = students.flatMap((s) => s.registrations.map((r) => ({ ...r, student: s })));
  const entryColumns: Column<R>[] = [
    { header: "Student ID", width: 16, value: (r) => r.student.studentNo },
    { header: "Full name", width: 26, value: (r) => r.student.fullName },
    { header: "Gender", value: (r) => label(LABEL.gender, r.student.gender) },
    { header: "Date of birth", value: (r) => r.student.dob, format: DATE },
    { header: "Tournament", width: 30, value: (r) => r.tournament.title },
    { header: "Tournament starts", value: (r) => r.tournament.startDate, format: DATE },
    { header: "Age at tournament", value: (r) => yearAge(r.student.dob, r.tournament.startDate) },
    { header: "Age group", width: 26, value: (r) => r.ageGroup },
    { header: "Section", value: (r) => (r.gender === "FEMALE" ? "Girls" : "Boys") },
    { header: "Weight class", value: (r) => r.weightCategory },
    { header: "Category", width: 34, value: (r) => categoryLabel(r.ageGroup, r.gender, r.weightCategory) },
    { header: "Weight entered (kg)", value: (r) => r.weightKg },
    { header: "Fee (₹)", value: (r) => r.fee },
    { header: "Payment", value: (r) => ({ PENDING: "Unpaid", PAID: "Paid", WAIVED: "Free" } as Record<string, string>)[r.paymentStatus] ?? r.paymentStatus },
    { header: "Weigh-in", value: (r) => label(LABEL.weighIn, r.weighInStatus) },
    { header: "Scale weight (kg)", value: (r) => r.weighInKg },
    { header: "Weighed at", value: (r) => r.weighedAt, format: DATE_TIME },
    { header: "Placement", value: (r) => label(LABEL.placement, r.placement) },
    { header: "Certificate no.", width: 18, value: (r) => r.certificateNo },
    { header: "Club", width: 22, value: (r) => r.student.club },
    { header: "District", width: 16, value: (r) => r.student.district },
    { header: "Phone", width: 14, value: (r) => r.student.phone },
    { header: "Email", width: 28, value: (r) => r.student.email },
    { header: "Entered on", value: (r) => r.createdAt, format: DATE_TIME },
  ];

  const stamp = now.toISOString().slice(0, 10);
  await sendSheets(res, `students${status ? `_${status.toLowerCase()}` : ""}_${stamp}.xlsx`, [
    sheet({ name: "Students", columns: studentColumns, rows: students }),
    sheet({ name: "Categories", columns: entryColumns, rows: entries }),
  ]);
});

// ─── Bulk import ─────────────────────────────────────────────────────────────

studentsRouter.get("/import/template", async (_req, res) => {
  const workbook = await templateWorkbook();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="students_import_template.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

/**
 * Import students from the template (.xlsx or .csv), sent as the raw request body with the file name in
 * X-Filename. Runs in the background (a big file takes longer than the proxy waits): the reply is a job to
 * poll at GET /students/import/jobs/:jobId. ?dryRun=1 only checks every row. Otherwise the valid rows are
 * created (rows with problems are skipped and listed).
 *
 * Emails are off unless the admin explicitly asks: ?sendEmails=1&confirmEmails=<n>, where n is the number
 * of emails the admin confirmed on screen. If more would go out than were confirmed, none are sent.
 * Every email goes through the email service, so each student gets at most one (re-importing can't
 * resend), they count against today's registration-email budget, and any over the limit are HELD for
 * an admin to release rather than dropped. Each student's history notes whether emails were on.
 */
studentsRouter.post("/import", express.raw({ type: () => true, limit: "5mb" }), async (req, res) => {
  const file = req.body;
  if (!Buffer.isBuffer(file) || !file.length) throw new HttpError(400, "Choose a file to import.");
  const filename = decodeURIComponent(String(req.headers["x-filename"] ?? "students.xlsx"));
  const dryRun = req.query.dryRun === "1";
  const sendEmails = req.query.sendEmails === "1";
  const confirmedEmails = Number(req.query.confirmEmails ?? NaN);
  if (!dryRun && sendEmails && !(Number.isInteger(confirmedEmails) && confirmedEmails > 0)) {
    throw new HttpError(400, "Confirm how many registration emails will be sent before importing with emails on.");
  }
  const importedBy = req.admin?.username || "admin";
  // Read the sheet now, so a wrong file is reported straight away
  const { rows, missing, unknown } = await readSheet(file, filename);

  const job = startJob("students", req.admin!.adminId, async (job) => {
    job.total = rows.length;
    const checked = await checkRows(rows, (done) => { job.done = done; });
    const summary = (r: (typeof checked)[number]) => ({ row: r.row, fullName: r.fullName, email: r.email, district: r.district, errors: r.errors });
    if (dryRun) {
      return { rows: checked.map(summary), valid: checked.filter((r) => r.data).length, invalid: checked.filter((r) => !r.data).length, missingColumns: missing, unknownColumns: unknown };
    }

    const toSave = checked.filter((r) => r.data);
    Object.assign(job, { phase: "SAVING", total: toSave.length, done: 0 });
    const created: { row: number; fullName: string; studentNo: string | null }[] = [];
    const failed = checked.filter((r) => !r.data).map(summary);
    const welcome: Awaited<ReturnType<typeof createStudent>>[] = [];
    for (const r of toSave) {
      try {
        // One row at a time: a problem with one student doesn't stop the rest.
        const student = await prisma.$transaction(async (tx) => {
          const s = await createStudent(tx, r.data!, {
            source: "ADMIN", bulkImport: true, actor: { type: "IMPORT", name: importedBy },
            note: `Imported from a spreadsheet (${filename}) — registration email ${sendEmails ? "ON" : "OFF"}`,
          });
          await ensureAccount(tx, s.email);
          return s;
        });
        created.push({ row: r.row, fullName: student.fullName, studentNo: student.studentNo });
        welcome.push(student);
      } catch (err) {
        failed.push({ ...summary(r), errors: [err instanceof HttpError ? err.message : "Couldn't save this student"] });
      }
      job.done++;
    }
    failed.sort((a, b) => a.row - b.row);

    // Emails one by one after saving; never to reserved test domains (e.g. @example.invalid)
    const deliverable = sendEmails ? welcome.filter((w) => !undeliverable(w.email)) : [];
    // More than the admin confirmed (e.g. the file changed between the check and the import): send none.
    const overConfirmed = deliverable.length > confirmedEmails;
    const mail = overConfirmed ? [] : deliverable;
    console.log(`[import] ${importedBy} imported ${created.length} students from ${filename}; registration emails ${sendEmails ? (overConfirmed ? `NOT sent (${deliverable.length} > ${confirmedEmails} confirmed)` : `on: ${mail.length}`) : "off"}`);
    const emails = { sent: 0, held: 0, failed: 0 };
    Object.assign(job, { phase: "EMAILING", total: mail.length, done: 0 });
    for (const w of mail) {
      const delivery = await emailRegistration(w, { trigger: "IMPORT", actor: importedBy }).catch((err: unknown) => {
        console.error("Import registration email failed:", err);
        return null;
      });
      if (delivery && ["SENT", "LOGGED", "UNCERTAIN", "DUPLICATE"].includes(delivery.status)) emails.sent++;
      else if (delivery?.status === "HELD") emails.held++;
      else emails.failed++;
      job.done++;
    }
    return {
      created: created.length, students: created, failed,
      emailsEnabled: sendEmails, emailsQueued: mail.length, emailsSent: emails.sent, emailsHeld: emails.held, emailsFailed: emails.failed,
      emailsBlocked: overConfirmed ? deliverable.length : 0,
      emailsSkipped: sendEmails ? welcome.length - deliverable.length : 0,
    };
  });
  res.status(202).json({ jobId: job.id });
});

studentsRouter.get("/import/jobs/:jobId", (req, res) => {
  res.json(getJob(param(req, "jobId"), req.admin!.adminId));
});

/** Students an admin adds are approved straight away; the registration email carries their login and PDF. */
studentsRouter.post("/", async (req, res) => {
  const data = await confirmResidency(studentSchema.parse(req.body));
  const student = await prisma.$transaction(async (tx) => {
    const created = await createStudent(tx, data, { actor: adminActor(req) });
    await ensureAccount(tx, created.email);
    return created;
  });
  emailRegistrationLater(student, { trigger: "ADMIN", actor: req.admin?.username || "admin" });
  res.status(201).json(student);
});

studentsRouter.get("/:id", async (req, res) => {
  const student = await prisma.student.findUnique({
    where: { id: param(req, "id") },
    include: {
      registrations: { include: { tournament: { select: { id: true, title: true, startDate: true } } }, orderBy: { createdAt: "desc" } },
      documents: { select: { kind: true, label: true, mime: true } },
    },
  });
  if (!student) throw notFound("Student");
  res.json(student);
});

/** BPL proof or proof of nativity uploaded with the registration. */
studentsRouter.get("/:id/documents/:kind", async (req, res) => {
  const kind = z.enum(DOCUMENT_KINDS).parse(param(req, "kind"));
  const doc = await prisma.studentDocument.findUnique({ where: { studentId_kind: { studentId: param(req, "id"), kind } } });
  if (!doc) throw notFound("Document");
  res.setHeader("Content-Type", doc.mime);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.end(Buffer.from(doc.data));
});

studentsRouter.put("/:id", async (req, res) => {
  const id = param(req, "id");
  const existing = await prisma.student.findUnique({ where: { id } });
  if (!existing) throw notFound("Student");
  // Student / working professional is fixed at registration (the permanent ID carries it: -S- or -P-).
  const data = await confirmResidency(studentSchema.parse({ ...req.body, participantType: existing.participantType }));
  const emailChanged = existing.email.toLowerCase() !== data.email;
  await assertAadhaarFree(prisma, data.aadhaarNumber, id);
  const student = await prisma.$transaction(async (tx) => {
    const updated = await tx.student.update({ where: { id }, data });
    if (emailChanged) await ensureAccount(tx, data.email);
    // The change and its audit entry are saved together (or not at all).
    const changes = diffStudent(existing, updated);
    if (changes.length) await recordStudentAudit(tx, updated, "UPDATED", adminActor(req), { changes });
    return updated;
  });
  res.json(student);
});

/** Approve an application from outside Tamil Nadu: issues the permanent ID and emails it with the registration PDF. */
studentsRouter.post("/:id/approve", async (req, res) => {
  const student = await prisma.$transaction(async (tx) => {
    const before = await tx.student.findUnique({ where: { id: param(req, "id") } });
    const approved = await approveStudent(tx, param(req, "id"));
    if (before && before.status !== "APPROVED") {
      await recordStudentAudit(tx, approved, "APPROVED", adminActor(req), { changes: diffStudent(before, approved), note: `Student ID ${approved.studentNo} issued` });
    }
    return approved;
  });
  emailApproval(student, { trigger: "ADMIN", actor: req.admin?.username || "admin" }).catch((err) => console.error("[registration email] approval failed:", err));
  res.json(student);
});

studentsRouter.post("/:id/reject", async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3, "Tell the applicant why").max(500) }).parse(req.body);
  const existing = await prisma.student.findUnique({ where: { id: param(req, "id") } });
  if (!existing) throw notFound("Student");
  if (existing.status === "APPROVED") throw new HttpError(409, "This student is already approved.");
  const student = await prisma.$transaction(async (tx) => {
    const updated = await tx.student.update({ where: { id: existing.id }, data: { status: "REJECTED", reviewNote: reason, reviewedAt: new Date() } });
    await recordStudentAudit(tx, updated, "REJECTED", adminActor(req), { changes: diffStudent(existing, updated), note: reason });
    return updated;
  });
  res.json(student);
});

studentsRouter.delete("/:id", async (req, res) => {
  // Restricted by the Registration foreign key: students with entries can't be deleted.
  // The audit log keeps the record of the deletion (and everything before it) for good.
  await prisma.$transaction(async (tx) => {
    const student = await tx.student.findUnique({ where: { id: param(req, "id") } });
    if (!student) throw notFound("Student");
    await tx.student.delete({ where: { id: student.id } });
    await recordStudentAudit(tx, student, "DELETED", adminActor(req), { note: `${student.fullName}${student.email ? ` (${student.email})` : ""}` });
  });
  res.json({ message: "Student deleted." });
});

// ─── Referees ────────────────────────────────────────────────────────────────

export const refereeSchema = z.object({
  fullName: z.string().trim().min(2, "Name is required").max(100),
  grade: z.string().trim().max(60).default(""),
  district: z.string().trim().max(80).default(""),
  phone: z.union([z.literal(""), z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number")]).default(""),
  email: z.email("Enter a valid email address").max(254),
});

export const refereesRouter = Router();

refereesRouter.get("/", async (req, res) => {
  const { q, page, pageSize } = listQuery.parse(req.query);
  const where = q
    ? { OR: [{ fullName: { contains: q, mode: "insensitive" as const } }, { district: { contains: q, mode: "insensitive" as const } }, { phone: { contains: q } }] }
    : {};
  const [items, total] = await Promise.all([
    prisma.referee.findMany({
      where, orderBy: { fullName: "asc" }, skip: (page - 1) * pageSize, take: pageSize,
      include: { _count: { select: { assignments: true } } },
    }),
    prisma.referee.count({ where }),
  ]);
  res.json({ items, total, page, pageSize });
});

refereesRouter.post("/", async (req, res) => {
  const data = refereeSchema.parse(req.body);
  const referee = await prisma.referee.create({ data });
  res.status(201).json(referee);
});

refereesRouter.put("/:id", async (req, res) => {
  const id = param(req, "id");
  const data = refereeSchema.parse(req.body);
  const existing = await prisma.referee.findUnique({ where: { id }, select: { email: true } });
  if (!existing) throw notFound("Referee");
  const referee = await prisma.referee.update({ where: { id }, data });
  res.json(referee);
});

refereesRouter.delete("/:id", async (req, res) => {
  await prisma.referee.delete({ where: { id: param(req, "id") } });
  res.json({ message: "Referee deleted." });
});

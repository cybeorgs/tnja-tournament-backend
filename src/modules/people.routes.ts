// Master lists: students (athletes) and referees. Both are reusable across tournaments.
import express, { Router } from "express";
import { z } from "zod";
import prisma from "../db.js";
import { HttpError, notFound } from "../middleware/errors.js";
import { param } from "../lib/helpers.js";
import { DOCUMENT_KINDS, approveStudent, assertAadhaarFree, confirmResidency, createStudent, studentSchema } from "../lib/students.js";
import { assertEmailVerified } from "../lib/emailOtp.js";
import { ensureAccount, welcomeLink } from "../lib/accounts.js";
import { DATE, DATE_TIME, maskAadhaar, sendWorkbook, yearAge, type Column } from "../lib/excel.js";
import { checkRows, readSheet, templateWorkbook } from "../lib/studentImport.js";
import { sendStudentApproved, sendStudentRegistered, sendStudentRejected } from "../lib/mailer.js";

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
  const where = {
    ...(status ? { status } : {}),
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

/** Every student matching the list's search and status filter, as an Excel sheet. Aadhaar numbers are masked. */
studentsRouter.get("/export", async (req, res) => {
  const { where, status } = studentWhere(req.query);
  const students = await prisma.student.findMany({ where, orderBy: { fullName: "asc" }, include: { _count: { select: { registrations: true } } } });
  type S = (typeof students)[number];
  const columns: Column<S>[] = [
    { header: "Student ID", width: 16, value: (s) => s.studentNo },
    { header: "Status", value: (s) => s.status },
    { header: "Full name", width: 26, value: (s) => s.fullName },
    { header: "Gender", value: (s) => s.gender },
    { header: "Date of birth", value: (s) => s.dob, format: DATE },
    { header: "Age (this year)", value: (s) => yearAge(s.dob) },
    { header: "Father's name", width: 22, value: (s) => s.fatherName },
    { header: "Mother's name", width: 22, value: (s) => s.motherName },
    { header: "Phone", width: 14, value: (s) => s.phone },
    { header: "Alternate phone", width: 14, value: (s) => s.alternatePhone },
    { header: "Email", width: 28, value: (s) => s.email },
    { header: "Blood group", value: (s) => s.bloodGroup },
    { header: "Aadhaar", width: 18, value: (s) => maskAadhaar(s.aadhaarNumber) },
    { header: "Club", width: 22, value: (s) => s.club },
    { header: "Coach", width: 20, value: (s) => s.coachName },
    { header: "Belt", value: (s) => s.belt },
    { header: "District", width: 16, value: (s) => s.district },
    { header: "Taluk", width: 16, value: (s) => s.taluk },
    { header: "Address", width: 36, value: (s) => s.address },
    { header: "City", width: 16, value: (s) => s.city },
    { header: "State", width: 16, value: (s) => s.state },
    { header: "Pincode", value: (s) => s.pincode },
    { header: "Residing pincode", value: (s) => s.residingPincode },
    { header: "Nationality", value: (s) => s.nationality },
    { header: "Outside Tamil Nadu", value: (s) => s.outsideTamilNadu },
    { header: "BPL", value: (s) => s.isBPL },
    { header: "Annual income", value: (s) => s.annualIncome, format: "#,##0" },
    { header: "Institution type", value: (s) => s.institutionType },
    { header: "Institution", width: 28, value: (s) => s.institutionName },
    { header: "Standard / year", value: (s) => s.grade },
    { header: "Department", width: 18, value: (s) => s.degreeDepartment },
    { header: "Registered by", value: (s) => (s.source === "SELF" ? "Self" : "Admin") },
    { header: "Tournaments entered", value: (s) => s._count.registrations },
    { header: "Registered on", value: (s) => s.createdAt, format: DATE_TIME },
  ];
  const stamp = new Date().toISOString().slice(0, 10);
  await sendWorkbook(res, `students${status ? `_${status.toLowerCase()}` : ""}_${stamp}.xlsx`, "Students", columns, students);
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
 * X-Filename. ?dryRun=1 only checks every row. Otherwise the valid rows are created (rows with problems are
 * skipped and listed) and, with ?sendEmails=1, each new account gets its set-password link by email.
 */
studentsRouter.post("/import", express.raw({ type: () => true, limit: "5mb" }), async (req, res) => {
  const file = req.body;
  if (!Buffer.isBuffer(file) || !file.length) throw new HttpError(400, "Choose a file to import.");
  const filename = decodeURIComponent(String(req.headers["x-filename"] ?? "students.xlsx"));
  const dryRun = req.query.dryRun === "1";
  const sendEmails = req.query.sendEmails === "1";

  const { rows, missing, unknown } = await readSheet(file, filename);
  const checked = await checkRows(rows);
  const summary = (r: (typeof checked)[number]) => ({ row: r.row, fullName: r.fullName, email: r.email, district: r.district, errors: r.errors });

  if (dryRun) {
    res.json({ rows: checked.map(summary), valid: checked.filter((r) => r.data).length, invalid: checked.filter((r) => !r.data).length, missingColumns: missing, unknownColumns: unknown });
    return;
  }

  const created: { row: number; fullName: string; studentNo: string | null }[] = [];
  const failed = checked.filter((r) => !r.data).map(summary);
  const welcome: { email: string; fullName: string; studentNo: string | null; link: string | null }[] = [];
  for (const r of checked) {
    if (!r.data) continue;
    try {
      // One row at a time: a problem with one student doesn't stop the rest.
      const { student, account } = await prisma.$transaction(async (tx) => {
        const s = await createStudent(tx, r.data!, undefined, { source: "ADMIN", bulkImport: true });
        return { student: s, account: await ensureAccount(tx, s.email) };
      });
      created.push({ row: r.row, fullName: student.fullName, studentNo: student.studentNo });
      welcome.push({ email: student.email, fullName: student.fullName, studentNo: student.studentNo, link: welcomeLink(account) });
    } catch (err) {
      failed.push({ ...summary(r), errors: [err instanceof HttpError ? err.message : "Couldn't save this student"] });
    }
  }
  failed.sort((a, b) => a.row - b.row);

  // Emails go out after the response, one by one, so a large import doesn't time out.
  if (sendEmails && welcome.length) {
    void (async () => {
      for (const w of welcome) {
        await sendStudentRegistered(w.email, { fullName: w.fullName, studentNo: w.studentNo, setPasswordUrl: w.link }).catch((err) => console.error("Import welcome email failed:", err));
      }
    })();
  }
  res.json({ created: created.length, students: created, failed, emailsQueued: sendEmails ? welcome.length : 0 });
});

/** Students an admin adds are approved straight away and get a login by email. */
studentsRouter.post("/", async (req, res) => {
  const data = await confirmResidency(studentSchema.parse(req.body));
  const { student, account } = await prisma.$transaction(async (tx) => {
    const created = await createStudent(tx, data, req.body?.emailVerificationToken);
    return { student: created, account: await ensureAccount(tx, created.email) };
  });
  await sendStudentRegistered(student.email, { fullName: student.fullName, studentNo: student.studentNo, setPasswordUrl: welcomeLink(account) });
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
  const data = await confirmResidency(studentSchema.parse(req.body));
  const existing = await prisma.student.findUnique({ where: { id }, select: { email: true } });
  if (!existing) throw notFound("Student");
  const emailChanged = existing.email.toLowerCase() !== data.email;
  if (emailChanged) assertEmailVerified(req.body?.emailVerificationToken, data.email);
  await assertAadhaarFree(prisma, data.aadhaarNumber, id);
  const { student, account } = await prisma.$transaction(async (tx) => ({
    student: await tx.student.update({ where: { id }, data }),
    account: emailChanged ? await ensureAccount(tx, data.email) : null,
  }));
  // A new email that didn't have a login yet gets the welcome email with its set-password link.
  if (account?.created) await sendStudentRegistered(student.email, { fullName: student.fullName, studentNo: student.studentNo, setPasswordUrl: welcomeLink(account) });
  res.json(student);
});

/** Approve an application from outside Tamil Nadu: issues the permanent ID and emails it. */
studentsRouter.post("/:id/approve", async (req, res) => {
  const student = await prisma.$transaction((tx) => approveStudent(tx, param(req, "id")));
  await sendStudentApproved(student.email, { fullName: student.fullName, studentNo: student.studentNo! });
  res.json(student);
});

studentsRouter.post("/:id/reject", async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3, "Tell the applicant why").max(500) }).parse(req.body);
  const existing = await prisma.student.findUnique({ where: { id: param(req, "id") } });
  if (!existing) throw notFound("Student");
  if (existing.status === "APPROVED") throw new HttpError(409, "This student is already approved.");
  const student = await prisma.student.update({ where: { id: existing.id }, data: { status: "REJECTED", reviewNote: reason, reviewedAt: new Date() } });
  await sendStudentRejected(student.email, { fullName: student.fullName, reason });
  res.json(student);
});

studentsRouter.delete("/:id", async (req, res) => {
  // Restricted by the Registration foreign key: students with entries can't be deleted.
  await prisma.student.delete({ where: { id: param(req, "id") } });
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
  assertEmailVerified(req.body?.emailVerificationToken, data.email);
  const referee = await prisma.referee.create({ data });
  res.status(201).json(referee);
});

refereesRouter.put("/:id", async (req, res) => {
  const id = param(req, "id");
  const data = refereeSchema.parse(req.body);
  const existing = await prisma.referee.findUnique({ where: { id }, select: { email: true } });
  if (!existing) throw notFound("Referee");
  if (existing.email.toLowerCase() !== data.email.toLowerCase()) assertEmailVerified(req.body?.emailVerificationToken, data.email);
  const referee = await prisma.referee.update({ where: { id }, data });
  res.json(referee);
});

refereesRouter.delete("/:id", async (req, res) => {
  await prisma.referee.delete({ where: { id: param(req, "id") } });
  res.json({ message: "Referee deleted." });
});

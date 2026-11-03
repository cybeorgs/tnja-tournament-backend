// Master lists: students (athletes) and referees. Both are reusable across tournaments.
import { Router } from "express";
import { z } from "zod";
import prisma from "../db.js";
import { HttpError, notFound } from "../middleware/errors.js";
import { param } from "../lib/helpers.js";
import { DOCUMENT_KINDS, approveStudent, assertAadhaarFree, confirmResidency, createStudent, studentSchema } from "../lib/students.js";
import { assertEmailVerified } from "../lib/emailOtp.js";
import { ensureAccount, welcomeLink } from "../lib/accounts.js";
import { sendStudentApproved, sendStudentRegistered, sendStudentRejected } from "../lib/mailer.js";

const listQuery = z.object({
  q: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// ─── Students ────────────────────────────────────────────────────────────────

export const studentsRouter = Router();

studentsRouter.get("/", async (req, res) => {
  const { q, page, pageSize } = listQuery.parse(req.query);
  const status = z.enum(["APPROVED", "PENDING", "REJECTED"]).optional().parse(req.query.status || undefined);
  const where = {
    ...(status ? { status } : {}),
    ...(q
      ? { OR: [{ fullName: { contains: q, mode: "insensitive" as const } }, { studentNo: { contains: q, mode: "insensitive" as const } }, { club: { contains: q, mode: "insensitive" as const } }, { phone: { contains: q } }, { email: { contains: q.toLowerCase() } }] }
      : {}),
  };
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

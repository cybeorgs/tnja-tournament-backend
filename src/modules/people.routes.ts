// Master lists: students (athletes) and referees. Both are reusable across tournaments.
import { Router } from "express";
import { z } from "zod";
import prisma from "../db.js";
import { notFound } from "../middleware/errors.js";
import { param } from "../lib/helpers.js";
import { assertAadhaarFree, createStudent, studentSchema } from "../lib/students.js";
import { assertEmailVerified } from "../lib/emailOtp.js";

const listQuery = z.object({
  q: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// ─── Students ────────────────────────────────────────────────────────────────

export const studentsRouter = Router();

studentsRouter.get("/", async (req, res) => {
  const { q, page, pageSize } = listQuery.parse(req.query);
  const where = q
    ? { OR: [{ fullName: { contains: q, mode: "insensitive" as const } }, { studentNo: { contains: q, mode: "insensitive" as const } }, { club: { contains: q, mode: "insensitive" as const } }, { phone: { contains: q } }] }
    : {};
  const [items, total] = await Promise.all([
    prisma.student.findMany({
      where, orderBy: { fullName: "asc" }, skip: (page - 1) * pageSize, take: pageSize,
      include: { _count: { select: { registrations: true } } },
    }),
    prisma.student.count({ where }),
  ]);
  res.json({ items, total, page, pageSize });
});

studentsRouter.post("/", async (req, res) => {
  const data = studentSchema.parse(req.body);
  const student = await prisma.$transaction((tx) => createStudent(tx, data, req.body?.emailVerificationToken));
  res.status(201).json(student);
});

studentsRouter.get("/:id", async (req, res) => {
  const student = await prisma.student.findUnique({
    where: { id: param(req, "id") },
    include: {
      registrations: { include: { tournament: { select: { id: true, title: true, startDate: true } } }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!student) throw notFound("Student");
  res.json(student);
});

studentsRouter.put("/:id", async (req, res) => {
  const id = param(req, "id");
  const data = studentSchema.parse(req.body);
  const existing = await prisma.student.findUnique({ where: { id }, select: { email: true } });
  if (!existing) throw notFound("Student");
  if (existing.email.toLowerCase() !== data.email.toLowerCase()) assertEmailVerified(req.body?.emailVerificationToken, data.email);
  await assertAadhaarFree(prisma, data.aadhaarNumber, id);
  const student = await prisma.student.update({ where: { id }, data });
  res.json(student);
});

studentsRouter.delete("/:id", async (req, res) => {
  // Restricted by the Registration foreign key: students with entries can't be deleted.
  await prisma.student.delete({ where: { id: param(req, "id") } });
  res.json({ message: "Student deleted." });
});

// ─── Referees ────────────────────────────────────────────────────────────────

const refereeSchema = z.object({
  fullName: z.string().trim().min(2, "Name is required").max(100),
  grade: z.string().trim().max(60).default(""),
  district: z.string().trim().max(80).default(""),
  phone: z.union([z.literal(""), z.string().trim().regex(/^[6-9]d{9}$/, "Enter a valid 10-digit mobile number")]).default(""),
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

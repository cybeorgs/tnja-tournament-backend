// Master lists: students (athletes) and referees. Both are reusable across tournaments.
import { Router } from "express";
import { z } from "zod";
import prisma from "../db.js";
import { notFound } from "../middleware/errors.js";
import { param } from "../lib/helpers.js";
import { assertAadhaarFree, createStudent, studentSchema } from "../lib/students.js";

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
  const student = await prisma.$transaction((tx) => createStudent(tx, data));
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
  phone: z.string().trim().max(20).default(""),
  email: z.union([z.literal(""), z.email("Email is not valid")]).default(""),
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
  const referee = await prisma.referee.create({ data: refereeSchema.parse(req.body) });
  res.status(201).json(referee);
});

refereesRouter.put("/:id", async (req, res) => {
  const referee = await prisma.referee.update({ where: { id: param(req, "id") }, data: refereeSchema.parse(req.body) });
  res.json(referee);
});

refereesRouter.delete("/:id", async (req, res) => {
  await prisma.referee.delete({ where: { id: param(req, "id") } });
  res.json({ message: "Referee deleted." });
});

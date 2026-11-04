// Read-only view of the student audit log (lib/audit.ts). There are deliberately no routes to change
// or delete entries, and the database refuses such changes anyway.
import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import prisma from "../db.js";

const router = Router();

const listQuery = z.object({
  studentId: z.string().uuid().optional(),
  action: z.enum(["CREATED", "UPDATED", "APPROVED", "REJECTED", "DELETED"]).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

router.get("/students", async (req, res) => {
  const { studentId, action, q, page, pageSize } = listQuery.parse(req.query);
  const where: Prisma.StudentAuditLogWhereInput = {
    ...(studentId ? { studentId } : {}),
    ...(action ? { action } : {}),
    ...(q
      ? {
          OR: [
            { studentName: { contains: q, mode: "insensitive" } },
            { studentNo: { contains: q, mode: "insensitive" } },
            { actor: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.studentAuditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.studentAuditLog.count({ where }),
  ]);
  res.json({ items, total, page, pageSize });
});

export default router;

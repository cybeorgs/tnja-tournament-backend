// Read-only view of the student audit log (lib/audit.ts). There are deliberately no routes to change
// or delete entries, and the database refuses such changes anyway.
import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { AUDIT_FILTERS, type AuditFilter } from "../lib/audit.js";

const router = Router();

const FILTER_KEYS = Object.keys(AUDIT_FILTERS) as [AuditFilter, ...AuditFilter[]];

const listQuery = z.object({
  studentId: z.string().uuid().optional(),
  /** A filter of the audit page: each covers every action of its kind (see AUDIT_FILTERS) */
  action: z.enum(FILTER_KEYS).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * The log, newest first, with how many entries each filter has for the same student / search (so the
 * page can show the counts on its filter buttons).
 */
router.get("/students", async (req, res) => {
  const { studentId, action, q, page, pageSize } = listQuery.parse(req.query);
  const scope: Prisma.StudentAuditLogWhereInput = {
    ...(studentId ? { studentId } : {}),
    ...(q
      ? {
          OR: [
            { studentName: { contains: q, mode: "insensitive" } },
            { studentNo: { contains: q, mode: "insensitive" } },
            { actor: { contains: q, mode: "insensitive" } },
            // The tournament, event, remark or reason
            { note: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const where: Prisma.StudentAuditLogWhereInput = { ...scope, ...(action ? { action: { in: [...AUDIT_FILTERS[action]] } } : {}) };
  const [items, total, byAction] = await Promise.all([
    // Ties on the timestamp (entries written together) keep a stable order across pages.
    prisma.studentAuditLog.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.studentAuditLog.count({ where }),
    prisma.studentAuditLog.groupBy({ by: ["action"], where: scope, _count: { _all: true } }),
  ]);
  const perAction = new Map(byAction.map((g) => [g.action, g._count._all]));
  const counts = Object.fromEntries(
    FILTER_KEYS.map((key) => [key, AUDIT_FILTERS[key].reduce((n, a) => n + (perAction.get(a) ?? 0), 0)]),
  ) as Record<AuditFilter, number>;
  const all = byAction.reduce((n, g) => n + g._count._all, 0);
  res.json({ items, total, page, pageSize, counts: { ALL: all, ...counts } });
});

export default router;

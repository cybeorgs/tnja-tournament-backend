// Admin view of entry-fee payments across tournaments.
// Entries are charged the tournament's entry fee when made (see lib/fees.ts): PENDING until paid,
// PAID once paid, WAIVED for free tournaments. The online payment step is added later.
import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import prisma from "../db.js";

const router = Router();

const listQuery = z.object({
  tournamentId: z.string().uuid().optional(),
  /** PENDING (unpaid) | PAID | WAIVED (free); empty = every entry that has a fee or was paid */
  status: z.enum(["PENDING", "PAID", "WAIVED"]).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

router.get("/", async (req, res) => {
  const { tournamentId, status, q, page, pageSize } = listQuery.parse(req.query);
  const scope: Prisma.RegistrationWhereInput = { ...(tournamentId ? { tournamentId } : {}) };
  const where: Prisma.RegistrationWhereInput = {
    ...scope,
    ...(status ? { paymentStatus: status } : { OR: [{ fee: { gt: 0 } }, { paymentStatus: "PAID" }] }),
    ...(q
      ? {
          student: {
            OR: [
              { fullName: { contains: q, mode: "insensitive" } },
              { studentNo: { contains: q, mode: "insensitive" } },
              { phone: { contains: q } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          },
        }
      : {}),
  };

  const [items, total, paid, unpaid] = await Promise.all([
    prisma.registration.findMany({
      where,
      orderBy: [{ paidAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, ageGroup: true, gender: true, weightCategory: true, fee: true, paymentStatus: true, paymentMode: true,
        amountPaid: true, razorpayPaymentId: true, paidAt: true, createdAt: true,
        student: { select: { id: true, studentNo: true, fullName: true, phone: true, email: true, club: true } },
        tournament: { select: { id: true, title: true, startDate: true } },
      },
    }),
    prisma.registration.count({ where }),
    prisma.registration.aggregate({ where: { ...scope, paymentStatus: "PAID" }, _sum: { amountPaid: true }, _count: true }),
    prisma.registration.aggregate({ where: { ...scope, paymentStatus: "PENDING" }, _sum: { fee: true }, _count: true }),
  ]);

  res.json({
    items, total, page, pageSize,
    summary: {
      collected: paid._sum.amountPaid ?? 0,
      paidCount: paid._count,
      due: unpaid._sum.fee ?? 0,
      unpaidCount: unpaid._count,
    },
  });
});

export default router;

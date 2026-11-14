// Admin view of entry-fee payments across tournaments.
// Entries are charged the tournament's entry fee when made (see lib/fees.ts): PENDING until paid,
// PAID once paid, WAIVED for free tournaments. The online payment step is added later.
// Also: boys / girls, students / working professionals and district-wise report (JSON), and Excel / PDF downloads of the filtered list.
import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { HttpError } from "../middleware/errors.js";
import { sendUnpaidDeletionNotice } from "../lib/mailer.js";
import { DATE, DATE_TIME, sendSheets, sheet } from "../lib/excel.js";
import {
  buildReport, districtOf, genderLabel, typeLabel, MODE_LABEL, paymentReportPdf, STATUS_LABEL,
  type DistrictRow,
} from "../lib/paymentReport.js";

const router = Router();

const filterQuery = z.object({
  tournamentId: z.string().uuid().optional(),
  /** PENDING (unpaid) | PAID | WAIVED (free); empty = every entry that has a fee or was paid */
  status: z.enum(["PENDING", "PAID", "WAIVED"]).optional(),
  q: z.string().trim().max(100).optional(),
});
type Filters = z.infer<typeof filterQuery>;

const listQuery = filterQuery.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** The list's filters as a Prisma where (shared by the list, the report and the downloads). */
function whereFor({ tournamentId, status, q }: Filters): Prisma.RegistrationWhereInput {
  return {
    ...(tournamentId ? { tournamentId } : {}),
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
}

router.get("/", async (req, res) => {
  const { page, pageSize, ...filters } = listQuery.parse(req.query);
  const scope: Prisma.RegistrationWhereInput = { ...(filters.tournamentId ? { tournamentId: filters.tournamentId } : {}) };
  const where = whereFor(filters);

  const [items, total, paid, unpaid] = await Promise.all([
    prisma.registration.findMany({
      where,
      orderBy: [{ paidAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, ageGroup: true, gender: true, weightCategory: true, fee: true, paymentStatus: true, paymentMode: true,
        amountPaid: true, razorpayPaymentId: true, paidAt: true, createdAt: true,
        student: { select: { id: true, studentNo: true, fullName: true, phone: true, email: true, club: true, district: true, participantType: true } },
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

/** Every entry matching the filters, with what the report and downloads need. */
function reportEntries(filters: Filters) {
  return prisma.registration.findMany({
    where: whereFor(filters),
    orderBy: [{ paidAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    select: {
      ageGroup: true, gender: true, weightCategory: true, fee: true, paymentStatus: true, paymentMode: true,
      amountPaid: true, razorpayPaymentId: true, paidAt: true, createdAt: true, isLate: true,
      student: { select: { studentNo: true, fullName: true, phone: true, email: true, club: true, district: true, participantType: true } },
      tournament: { select: { title: true, startDate: true } },
    },
  });
}

/** The tournament name (or "All tournaments"), a note of the other filters, and a file name base. */
async function describe(filters: Filters) {
  const tournament = filters.tournamentId
    ? await prisma.tournament.findUnique({ where: { id: filters.tournamentId }, select: { title: true } })
    : null;
  const scope = tournament?.title ?? "All tournaments";
  const statusNote = filters.status ? `${STATUS_LABEL[filters.status]} entries only` : "";
  const filterNote = [statusNote, filters.q ? `Search: "${filters.q}"` : ""].filter(Boolean).join("  |  ");
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `payments_${tournament ? tournament.title : "all"}${filters.status ? `_${(STATUS_LABEL[filters.status] ?? filters.status).toLowerCase()}` : ""}_${stamp}`;
  return { scope, filterNote, base };
}

/** Boys / girls, students / working professionals and district-wise totals for the current filters. */
router.get("/report", async (req, res) => {
  const filters = filterQuery.parse(req.query);
  res.json(buildReport(await reportEntries(filters)));
});

router.get("/export.xlsx", async (req, res) => {
  const filters = filterQuery.parse(req.query);
  const entries = await reportEntries(filters);
  const { base } = await describe(filters);
  const report = buildReport(entries);
  type Entry = (typeof entries)[number];
  const districtRows: DistrictRow[] = [...report.districts, { district: "TOTAL", ...report.totals }];

  await sendSheets(res, `${base}.xlsx`, [
    sheet<DistrictRow>({
      name: "District summary",
      rows: districtRows,
      columns: [
        { header: "District", width: 24, value: (r) => r.district },
        { header: "Entries", value: (r) => r.entries },
        { header: "Boys", value: (r) => r.boys },
        { header: "Girls", value: (r) => r.girls },
        { header: "Students", value: (r) => r.students },
        { header: "Working professionals", width: 22, value: (r) => r.professionals },
        { header: "Paid entries", width: 14, value: (r) => r.paidCount },
        { header: "Collected (₹)", width: 15, value: (r) => r.collected, format: "#,##0" },
        { header: "Unpaid entries", width: 15, value: (r) => r.unpaidCount },
        { header: "Due (₹)", width: 12, value: (r) => r.due, format: "#,##0" },
      ],
    }),
    sheet<Entry>({
      name: "Entries",
      rows: entries,
      columns: [
        { header: "Student ID", width: 16, value: (e) => e.student.studentNo },
        { header: "Name", width: 26, value: (e) => e.student.fullName },
        { header: "Boys / Girls", width: 12, value: (e) => genderLabel(e.gender) },
        { header: "Student / Professional", width: 22, value: (e) => typeLabel(e) },
        { header: "District", width: 18, value: (e) => districtOf(e) },
        { header: "Club", width: 24, value: (e) => e.student.club },
        { header: "Phone", width: 14, value: (e) => e.student.phone },
        { header: "Email", width: 28, value: (e) => e.student.email },
        { header: "Tournament", width: 32, value: (e) => e.tournament.title },
        { header: "Tournament date", width: 15, value: (e) => e.tournament.startDate, format: DATE },
        { header: "Age group", width: 22, value: (e) => e.ageGroup },
        { header: "Weight category", width: 15, value: (e) => e.weightCategory },
        { header: "Registration", width: 12, value: (e) => (e.isLate ? "Late" : "Regular") },
        { header: "Status", value: (e) => STATUS_LABEL[e.paymentStatus] ?? e.paymentStatus },
        { header: "Fee (₹)", value: (e) => e.fee, format: "#,##0" },
        { header: "Amount paid (₹)", width: 15, value: (e) => e.amountPaid, format: "#,##0" },
        { header: "Mode", value: (e) => (e.paymentMode ? MODE_LABEL[e.paymentMode] ?? e.paymentMode : "") },
        { header: "Paid on", width: 17, value: (e) => e.paidAt, format: DATE_TIME },
        { header: "Payment ID", width: 22, value: (e) => e.razorpayPaymentId },
        { header: "Entered on", width: 17, value: (e) => e.createdAt, format: DATE_TIME },
      ],
    }),
  ]);
});

router.get("/export.pdf", async (req, res) => {
  const filters = filterQuery.parse(req.query);
  const download = req.query.download === "1";
  const entries = await reportEntries(filters);
  const { scope, filterNote, base } = await describe(filters);
  const bytes = await paymentReportPdf(entries, { scope, filterNote });
  const safe = `${base}.pdf`.replace(/[^A-Za-z0-9._-]+/g, "_");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${safe}"`);
  res.setHeader("Cache-Control", "no-store");
  res.end(Buffer.from(bytes));
});

// ─── Unpaid notice ───────────────────────────────────────────────────────────

/**
 * Players with an unpaid entry in a tournament, one row per player (their unpaid events and total),
 * with when they were last sent an unpaid notice for this tournament and the pay-by date it gave.
 */
router.get("/unpaid-players", async (req, res) => {
  const { tournamentId } = z.object({ tournamentId: z.string().uuid() }).parse(req.query);
  const unpaid = await prisma.registration.findMany({
    where: { tournamentId, paymentStatus: "PENDING", fee: { gt: 0 } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, ageGroup: true, gender: true, weightCategory: true, fee: true, createdAt: true,
      student: { select: { id: true, studentNo: true, fullName: true, phone: true, email: true, district: true, participantType: true } },
    },
  });
  const players = new Map<string, { student: (typeof unpaid)[number]["student"]; events: { id: string; name: string; fee: number }[]; due: number; enteredAt: Date }>();
  for (const r of unpaid) {
    const p = players.get(r.student.id) ?? { student: r.student, events: [], due: 0, enteredAt: r.createdAt };
    p.events.push({ id: r.id, name: `${r.ageGroup} · ${genderLabel(r.gender)} ${r.weightCategory}`, fee: r.fee });
    p.due += r.fee;
    players.set(r.student.id, p);
  }
  const notices = players.size
    ? await prisma.emailMessage.findMany({
        where: { kind: "UNPAID_NOTICE", tournamentId, studentId: { in: [...players.keys()] }, status: { in: ["SENT", "LOGGED", "UNCERTAIN"] } },
        orderBy: { createdAt: "desc" },
        select: { studentId: true, createdAt: true, idempotencyKey: true },
      })
    : [];
  const lastNotice = new Map<string, { sentAt: Date; payBy: string }>();
  for (const n of notices) {
    if (n.studentId && !lastNotice.has(n.studentId)) lastNotice.set(n.studentId, { sentAt: n.createdAt, payBy: n.idempotencyKey?.split(":").pop() ?? "" });
  }
  res.json({
    items: [...players.values()].map((p) => ({ ...p, lastNotice: lastNotice.get(p.student.id) ?? null })),
  });
});

const unpaidNoticeBody = z.object({
  tournamentId: z.string().uuid(),
  /** Only these players; left out = every player with an unpaid entry in the tournament */
  studentIds: z.array(z.string().uuid()).min(1).max(1000).optional(),
  /** Deadline shown in the email (YYYY-MM-DD, Indian time), today or later */
  payBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the date to pay by."),
});

/**
 * Email unpaid players: "pay by <date>, or your registration (ID and details) will be deleted".
 * One email per player, listing their unpaid events in the tournament. Sent one after another within the
 * ADMIN daily email limit; the same player, tournament and date is never emailed twice (a double click
 * or a second run reports them as already sent), but a new date can be sent.
 */
router.post("/unpaid-notice", async (req, res) => {
  const { tournamentId, studentIds, payBy } = unpaidNoticeBody.parse(req.body);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  if (payBy < today) throw new HttpError(400, "The pay-by date can't be in the past.");
  const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId }, select: { title: true } });
  if (!tournament) throw new HttpError(404, "Tournament not found.");

  const unpaid = await prisma.registration.findMany({
    where: { tournamentId, paymentStatus: "PENDING", fee: { gt: 0 }, ...(studentIds ? { studentId: { in: studentIds } } : {}) },
    orderBy: { createdAt: "asc" },
    select: { ageGroup: true, gender: true, weightCategory: true, fee: true, student: { select: { id: true, fullName: true, email: true } } },
  });
  const byStudent = new Map<string, { student: (typeof unpaid)[number]["student"]; entries: typeof unpaid }>();
  for (const r of unpaid) {
    const group = byStudent.get(r.student.id) ?? { student: r.student, entries: [] };
    group.entries.push(r);
    byStudent.set(r.student.id, group);
  }

  const actor = req.admin?.username || "admin";
  const counts = { sent: 0, alreadySent: 0, notSent: 0, noEmail: 0 };
  const notSent: string[] = [];
  for (const { student, entries } of byStudent.values()) {
    if (!student.email) { counts.noEmail++; continue; }
    const delivery = await sendUnpaidDeletionNotice(
      student.email,
      {
        fullName: student.fullName,
        tournament: tournament.title,
        events: entries.map((e) => ({ name: `${e.ageGroup} · ${genderLabel(e.gender)} ${e.weightCategory}`, fee: e.fee })),
        amountDue: entries.reduce((sum, e) => sum + e.fee, 0),
        payBy: new Date(`${payBy}T12:00:00+05:30`),
      },
      { trigger: "ADMIN", actor, studentId: student.id, tournamentId, idempotencyKey: `unpaid-notice:${tournamentId}:${student.id}:${payBy}` },
    );
    if (["SENT", "LOGGED", "UNCERTAIN"].includes(delivery.status)) counts.sent++;
    else if (delivery.status === "DUPLICATE") counts.alreadySent++;
    else {
      counts.notSent++;
      if (notSent.length < 20) notSent.push(`${student.fullName}: ${delivery.error || delivery.status}`);
    }
  }
  console.warn(`[email] ${actor} sent unpaid notices for "${tournament.title}" (pay by ${payBy}): ${JSON.stringify(counts)}`);
  res.json({ players: byStudent.size, ...counts, notSentDetails: notSent });
});

export default router;

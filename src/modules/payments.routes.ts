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
import { moneyCheck, onlinePaymentEnabled, resolveReview, syncWithRazorpay } from "../lib/payments.js";
import { adminActor } from "../lib/audit.js";
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

// ─── Razorpay sync ───────────────────────────────────────────────────────────

let syncing = false;

/**
 * Match every successful Razorpay payment of the last `days` to its order and record any that weren't
 * (including ones made before order records were kept). Safe to run any time; one run at a time.
 */
router.post("/razorpay/sync", async (req, res) => {
  if (!onlinePaymentEnabled()) throw new HttpError(409, "Online payment isn't set up (no Razorpay keys).");
  const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).parse(req.body ?? {});
  if (syncing) throw new HttpError(409, "A sync is already running. Try again in a minute.");
  syncing = true;
  try {
    const result = await syncWithRazorpay(days);
    console.warn(`[payments] ${req.admin?.username || "admin"} synced with Razorpay (${days} days): ${JSON.stringify(result)}`);
    res.json(result);
  } finally {
    syncing = false;
  }
});

/** Razorpay's collected total explained against the website (read-only). */
router.get("/razorpay/money-check", async (req, res) => {
  if (!onlinePaymentEnabled()) throw new HttpError(409, "Online payment isn't set up (no Razorpay keys).");
  const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(90) }).parse(req.query);
  res.json(await moneyCheck(days));
});

/** Paid orders that need an admin (an entry removed or already paid meanwhile, an amount that didn't match). */
router.get("/razorpay/review", async (_req, res) => {
  const orders = await prisma.paymentOrder.findMany({ where: { status: "REVIEW" }, orderBy: { updatedAt: "desc" }, take: 200 });
  const [students, tournaments] = await Promise.all([
    prisma.student.findMany({ where: { id: { in: orders.map((o) => o.studentId) } }, select: { id: true, studentNo: true, fullName: true, phone: true, email: true } }),
    prisma.tournament.findMany({ where: { id: { in: orders.map((o) => o.tournamentId) } }, select: { id: true, title: true } }),
  ]);
  res.json({
    items: orders.map((o) => ({
      orderId: o.id, paymentId: o.paymentId, amount: o.amount, paidAt: o.paidAt, note: o.note, updatedAt: o.updatedAt,
      student: students.find((s) => s.id === o.studentId) ?? null,
      tournament: tournaments.find((t) => t.id === o.tournamentId)?.title ?? "",
    })),
  });
});

/** Mark a review order as settled (refunded or sorted out by hand), with what was done. */
router.post("/razorpay/review/:orderId/resolve", async (req, res) => {
  const { note, noRefund } = z.object({
    note: z.string().trim().min(3, "Pick a quick answer or write a short note.").max(500),
    /** The player paid once, online: entries marked paid by hand are switched to Online. */
    noRefund: z.boolean().default(false),
  }).parse(req.body ?? {});
  const switched = await resolveReview(String(req.params.orderId), adminActor(req), note, noRefund);
  res.json({ ok: true, switched });
});

// ─── Duplicate registrations ─────────────────────────────────────────────────

/** "G.Sanjay", "Sanjay G" and "SANJAY . G" → "g sanjay": letters only, words in any order. */
const nameKey = (name: string) => name.toLowerCase().split(/[^a-z]+/).filter(Boolean).sort().join(" ");
const phoneKey = (phone: string) => phone.replace(/\D/g, "").slice(-10);
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * People entered in a tournament under more than one student record (they filled the form again,
 * e.g. with a mistyped Aadhaar, and got a second student ID). Two records are the same person when they
 * share a date of birth and either their name (ignoring dots, spaces, initials' order and case) or their
 * mobile number. Only groups with an unpaid entry are listed. Nothing is changed here.
 */
router.get("/duplicates", async (req, res) => {
  const { tournamentId } = z.object({ tournamentId: z.string().uuid() }).parse(req.query);
  const entries = await prisma.registration.findMany({
    where: { tournamentId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, ageGroup: true, gender: true, weightCategory: true, fee: true, paymentStatus: true, paymentMode: true, amountPaid: true, createdAt: true,
      student: { select: { id: true, studentNo: true, fullName: true, dob: true, phone: true, email: true, district: true, aadhaarNumber: true, createdAt: true } },
    },
  });
  type S = (typeof entries)[number]["student"];
  const students = new Map<string, S>();
  for (const e of entries) students.set(e.student.id, e.student);

  // Union-find over the two matching rules
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const p = parent.get(id) ?? id;
    if (p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  const byKey = new Map<string, string>();
  const link = (key: string, id: string) => {
    const other = byKey.get(key);
    if (!other) byKey.set(key, id);
    else parent.set(find(id), find(other));
  };
  for (const s of students.values()) {
    const name = nameKey(s.fullName);
    if (name) link(`n:${dayKey(s.dob)}:${name}`, s.id);
    const phone = phoneKey(s.phone);
    if (phone.length === 10) link(`p:${dayKey(s.dob)}:${phone}`, s.id);
  }

  const groups = new Map<string, S[]>();
  for (const s of students.values()) groups.set(find(s.id), [...(groups.get(find(s.id)) ?? []), s]);

  const items = [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const records = g
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((s) => {
          const own = entries.filter((e) => e.student.id === s.id);
          return {
            student: {
              id: s.id, studentNo: s.studentNo, fullName: s.fullName, dob: s.dob, phone: s.phone, email: s.email, district: s.district,
              aadhaarLast4: s.aadhaarNumber ? s.aadhaarNumber.slice(-4) : null, registeredAt: s.createdAt,
            },
            entries: own.map((e) => ({
              id: e.id, name: `${e.ageGroup} · ${genderLabel(e.gender)} ${e.weightCategory}`, ageGroup: e.ageGroup, weightCategory: e.weightCategory,
              fee: e.fee, paymentStatus: e.paymentStatus, paymentMode: e.paymentMode, amountPaid: e.amountPaid, enteredAt: e.createdAt,
            })),
          };
        });
      const sameName = new Set(g.map((s) => nameKey(s.fullName))).size === 1;
      const samePhone = new Set(g.map((s) => phoneKey(s.phone))).size === 1;
      const unpaid = records.flatMap((r) => r.entries).filter((e) => e.paymentStatus === "PENDING");
      return {
        matchedOn: [sameName ? "name" : "", samePhone ? "mobile" : "", "date of birth"].filter(Boolean),
        anyPaid: records.some((r) => r.entries.some((e) => e.paymentStatus !== "PENDING")),
        unpaidCount: unpaid.length,
        unpaidTotal: unpaid.reduce((n, e) => n + e.fee, 0),
        records,
      };
    })
    .filter((g) => g.unpaidCount > 0)
    // Someone already paid under another record first: those are the clearest duplicates
    .sort((a, b) => Number(b.anyPaid) - Number(a.anyPaid) || b.unpaidTotal - a.unpaidTotal);

  res.json({ items });
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
 * Email unpaid players a reminder to pay by <date>, after which their pending registration is removed.
 * One email per player with an unpaid entry in the tournament. Sent one after another within the
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
  for (const { student } of byStudent.values()) {
    if (!student.email) { counts.noEmail++; continue; }
    const delivery = await sendUnpaidDeletionNotice(
      student.email,
      { fullName: student.fullName, tournament: tournament.title, payBy },
      { trigger: "ADMIN", actor, studentId: student.id, tournamentId, idempotencyKey: `unpaid-notice:v2:${tournamentId}:${student.id}:${payBy}` },
      // (v2: the reminder wording; a player emailed the earlier wording for a date can get this one once.
      // The "last notice" list reads the date from the key's last part, so both versions show.)
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

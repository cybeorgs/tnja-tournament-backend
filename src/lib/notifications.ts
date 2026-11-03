// The three tournament emails — and only these three — with the rules that keep each to a single send:
//   1. Registration confirmation — right after a player's entries are saved (by the player or an admin).
//   2. Deadline reminder — at the tournament's reminderAt, to players whose entries are still unpaid;
//      never after the regular deadline or the start, never to anyone who has paid.
//   3. Payment success — only after the payment gateway's payment is verified, with a receipt.
// Every entry records when its confirmation and reminder went out; an automatic email is sent only
// after its entries have been claimed (marked) in the database, so retries, double clicks or two
// server ticks can't send it twice. An admin can also send each email on purpose ("MANUAL").
// Every send is written to EmailLog with its delivery status. Fees and dates always come from the
// tournament's settings and the entries themselves.
import prisma from "../db.js";
import { HttpError } from "../middleware/errors.js";
import { categoryLabel } from "./certificate.js";
import { passwordLink } from "./accounts.js";
import { registrationPhase, repriceUnpaid } from "./fees.js";
import { sendDeadlineReminder, sendPaymentReceipt, sendRegistrationConfirmation, type Delivery, type EmailEntry } from "./mailer.js";

export type EmailKind = "CONFIRMATION" | "REMINDER" | "PAYMENT";
type Trigger = "AUTO" | "MANUAL";
type EntryRow = { ageGroup: string; gender: string; weightCategory: string; fee: number; isLate: boolean; paymentStatus: string; amountPaid: number };
type TournamentRow = { id: string; title: string; venue: string; startDate: Date; registrationClosesAt: Date; entryFee: number; lateEntryFee: number };

const toEmailEntry = (r: EntryRow): EmailEntry => ({
  category: categoryLabel(r.ageGroup, r.gender, r.weightCategory),
  fee: r.fee, isLate: r.isLate, paymentStatus: r.paymentStatus, amountPaid: r.amountPaid,
});

const feesOf = (t: TournamentRow) => ({ regularFee: t.entryFee, lateFee: t.lateEntryFee, closesAt: t.registrationClosesAt });

async function log(tournamentId: string, studentId: string | null, kind: EmailKind, trigger: Trigger, d: Delivery) {
  await prisma.emailLog.create({ data: { tournamentId, studentId, kind, trigger, toEmail: d.to, subject: d.subject, status: d.status, error: d.error } });
  return d;
}

/** Claim entries for an automatic email: marks them and returns true only if this call marked them. */
async function claim(ids: string[], field: "confirmationSentAt" | "reminderSentAt") {
  if (!ids.length) return false;
  const { count } = await prisma.registration.updateMany({ where: { id: { in: ids }, [field]: null }, data: { [field]: new Date() } });
  return count > 0;
}

/** Set-password link while the account's owner hasn't chosen a password yet. */
async function setPasswordUrlFor(email: string) {
  const account = await prisma.studentAccount.findUnique({ where: { email: email.toLowerCase() } });
  return account && !account.passwordSetAt ? passwordLink(account, "welcome") : null;
}

// ─── 1. Registration confirmation ────────────────────────────────────────────

/**
 * Confirm a student's entries in a tournament. Automatically: only entries not confirmed yet.
 * By an admin: all of the student's entries (a deliberate resend).
 */
export async function sendEntryConfirmations(tournamentId: string, studentId: string, trigger: Trigger = "AUTO") {
  let ids: string[];
  if (trigger === "AUTO") {
    const fresh = await prisma.registration.findMany({ where: { tournamentId, studentId, confirmationSentAt: null }, select: { id: true } });
    ids = fresh.map((r) => r.id);
    if (!(await claim(ids, "confirmationSentAt"))) return null;
  } else {
    ids = (await prisma.registration.findMany({ where: { tournamentId, studentId }, select: { id: true } })).map((r) => r.id);
    if (!ids.length) throw new HttpError(404, "This player has no entries in the tournament.");
    await prisma.registration.updateMany({ where: { id: { in: ids }, confirmationSentAt: null }, data: { confirmationSentAt: new Date() } });
  }

  const entries = await prisma.registration.findMany({ where: { id: { in: ids } }, include: { student: true, tournament: true }, orderBy: { createdAt: "asc" } });
  const first = entries[0];
  if (!first) return null;
  const delivery = await sendRegistrationConfirmation(first.student.email, {
    playerName: first.student.fullName,
    tournament: first.tournament,
    entries: entries.map(toEmailEntry),
    isLate: entries.some((e) => e.isLate),
    fees: feesOf(first.tournament),
    setPasswordUrl: await setPasswordUrlFor(first.student.email),
  });
  return log(tournamentId, studentId, "CONFIRMATION", trigger, delivery);
}

/** Fire-and-forget wrapper for request handlers: the entry is saved whether or not the email goes. */
export function confirmEntriesLater(tournamentId: string, studentId: string) {
  sendEntryConfirmations(tournamentId, studentId).catch((err) => console.error("[notifications] Confirmation email failed:", err));
}

// ─── 2. Deadline reminder ────────────────────────────────────────────────────

/** Reminders can only go out while regular registration is running (so never after the start). */
function assertRemindable(t: { registrationClosesAt: Date; startDate: Date; status: string; registrationOpensAt: Date; entryFee: number; lateEntryFee: number }, now: Date) {
  if (registrationPhase(t, now) !== "OPEN") throw new HttpError(409, "Reminders can only be sent while regular registration is open (before the regular deadline).");
}

async function remind(t: TournamentRow, entries: (EntryRow & { id: string; studentId: string; student: { fullName: string; email: string } })[], trigger: Trigger) {
  const student = entries[0]!.student;
  const delivery = await sendDeadlineReminder(student.email, { playerName: student.fullName, tournament: t, entries: entries.map(toEmailEntry), fees: feesOf(t) });
  return log(t.id, entries[0]!.studentId, "REMINDER", trigger, delivery);
}

const groupByStudent = <T extends { studentId: string }>(rows: T[]) => {
  const groups = new Map<string, T[]>();
  for (const r of rows) groups.set(r.studentId, [...(groups.get(r.studentId) ?? []), r]);
  return [...groups.values()];
};

/** Automatic run: due reminders for every tournament whose reminder time has come. */
export async function sendDueReminders(now = new Date()) {
  const tournaments = await prisma.tournament.findMany({
    where: { status: "PUBLISHED", reminderAt: { lte: now }, registrationClosesAt: { gt: now }, startDate: { gt: now } },
  });
  for (const t of tournaments) {
    // Unpaid entries made before the reminder time (later ones were just told the deadline in their confirmation).
    const pending = await prisma.registration.findMany({
      where: { tournamentId: t.id, paymentStatus: "PENDING", fee: { gt: 0 }, reminderSentAt: null, createdAt: { lte: t.reminderAt! } },
      include: { student: true },
      orderBy: { createdAt: "asc" },
    });
    for (const entries of groupByStudent(pending)) {
      if (await claim(entries.map((e) => e.id), "reminderSentAt")) await remind(t, entries, "AUTO");
    }
  }
}

/**
 * Admin "send reminder now": to one player (a deliberate resend), or to every player with unpaid
 * entries who hasn't had a reminder yet (no duplicates). Returns how many emails went out.
 */
export async function sendRemindersNow(tournamentId: string, studentId?: string) {
  const now = new Date();
  const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!t) throw new HttpError(404, "Tournament not found.");
  assertRemindable(t, now);
  await repriceUnpaid(t, now);
  const pending = await prisma.registration.findMany({
    where: { tournamentId, paymentStatus: "PENDING", fee: { gt: 0 }, ...(studentId ? { studentId } : { reminderSentAt: null }) },
    include: { student: true },
    orderBy: { createdAt: "asc" },
  });
  if (studentId && !pending.length) throw new HttpError(409, "This player has nothing left to pay.");
  let sent = 0;
  for (const entries of groupByStudent(pending)) {
    await prisma.registration.updateMany({ where: { id: { in: entries.map((e) => e.id) } }, data: { reminderSentAt: now } });
    await remind(t, entries, "MANUAL");
    sent++;
  }
  return sent;
}

// ─── 3. Payment success ──────────────────────────────────────────────────────

/** Receipt for entries a verified gateway payment has just marked paid (called by lib/payments.ts). */
export async function sendPaymentSuccess(registrationIds: string[], payment: { transactionId: string; orderId: string; paidAt: Date }, trigger: Trigger = "AUTO") {
  if (!registrationIds.length) return null;
  const entries = await prisma.registration.findMany({ where: { id: { in: registrationIds } }, include: { student: true, tournament: true }, orderBy: { createdAt: "asc" } });
  const first = entries[0];
  if (!first) return null;
  const delivery = await sendPaymentReceipt(first.student.email, {
    playerName: first.student.fullName,
    tournament: first.tournament,
    entries: entries.map(toEmailEntry),
    transactionId: payment.transactionId,
    receiptNo: payment.orderId,
    paidAt: payment.paidAt,
  });
  return log(first.tournamentId, first.studentId, "PAYMENT", trigger, delivery);
}

/** Admin resend of a player's latest online payment receipt (cash/UPI recorded by hand has no gateway receipt). */
export async function resendPaymentReceipt(tournamentId: string, studentId: string) {
  const paid = await prisma.registration.findMany({
    where: { tournamentId, studentId, paymentStatus: "PAID", paymentMode: "RAZORPAY", razorpayPaymentId: { not: null } },
    orderBy: { paidAt: "desc" },
  });
  const latest = paid[0];
  if (!latest) throw new HttpError(409, "This player has no verified online payment to send a receipt for.");
  const sameOrder = paid.filter((r) => r.razorpayPaymentId === latest.razorpayPaymentId).map((r) => r.id);
  return sendPaymentSuccess(sameOrder, { transactionId: latest.razorpayPaymentId!, orderId: latest.razorpayOrderId ?? latest.razorpayPaymentId!, paidAt: latest.paidAt ?? new Date() }, "MANUAL");
}

// ─── Every minute ────────────────────────────────────────────────────────────

/** Keep unpaid fees on the policy (late fee from the deadline) and send due reminders. */
export async function runScheduledTasks(now = new Date()) {
  const upcoming = await prisma.tournament.findMany({ where: { status: "PUBLISHED", startDate: { gt: now } } });
  for (const t of upcoming) await repriceUnpaid(t, now);
  await sendDueReminders(now);
}

let started = false;

/** Run the scheduled tasks now and then every minute (single server process). */
export function startReminderScheduler() {
  if (started) return;
  started = true;
  const tick = () => runScheduledTasks().catch((err) => console.error("[notifications] Scheduled run failed:", err));
  void tick();
  setInterval(tick, 60 * 1000);
}

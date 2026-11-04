// Registration runs on a schedule the admin sets; nothing is switched by hand.
//   NOT_OPEN — before registrationOpensAt
//   OPEN     — registrationOpensAt → registrationClosesAt
//   CLOSED   — from registrationClosesAt (or once the tournament is completed): no new entries
// There is no late registration: entries made earlier with isLate = true keep it for history only.
//
// Fees: a player's first category (age group) in a tournament costs entryFee; every further category
// they enter in the same tournament costs additionalEntryFee (lower, set by the admin). The first
// category is the player's earliest entry. An entry with a fee is PENDING until paid; one with no fee
// is WAIVED. Unpaid entries are repriced whenever the player's entries or the fees change (see
// repriceEntries), so removing the first category moves the full fee to the next unpaid one.
import type { Prisma } from "@prisma/client";
import prisma from "../db.js";

type Schedule = { registrationOpensAt: Date; registrationClosesAt: Date; startDate: Date; status: string; entryFee: number };

export type RegistrationPhase = "NOT_OPEN" | "OPEN" | "CLOSED";

export function registrationPhase(t: Omit<Schedule, "entryFee">, now = new Date()): RegistrationPhase {
  if (t.status === "COMPLETED" || now >= t.startDate || now >= t.registrationClosesAt) return "CLOSED";
  return now < t.registrationOpensAt ? "NOT_OPEN" : "OPEN";
}

export type EntryTerms = { fee: number; isLate: false; paymentStatus: "PENDING" | "WAIVED" };

/**
 * Terms for an entry made right now, or null when registration isn't open. The fee here is the full
 * fee; call repriceEntries after creating entries to charge further categories the additional fee.
 */
export function newEntryTerms(t: Schedule, now = new Date()): EntryTerms | null {
  if (registrationPhase(t, now) !== "OPEN") return null;
  return { fee: t.entryFee, isLate: false, paymentStatus: t.entryFee > 0 ? "PENDING" : "WAIVED" };
}

const IST = { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" } as const;
const when = (d: Date) => d.toLocaleString("en-IN", IST);

type Fees = { entryFee: number; additionalEntryFee: number };
type Db = Prisma.TransactionClient | typeof prisma;

/** The fee for an entry: full for the player's first category, the additional fee for the rest. */
export const feeFor = (t: Fees, isFirst: boolean) => (isFirst ? t.entryFee : Math.min(t.additionalEntryFee, t.entryFee));

/**
 * Bring a player's entries in a tournament to the current fees: the earliest entry is the first
 * category (full fee), the others pay the additional fee. Paid entries keep what they paid; any other
 * entry is PENDING when it has a fee and WAIVED when it comes to 0 (and back again if a fee is set). Pass studentId to do one player, or leave it out for all.
 */
export async function repriceEntries(db: Db, tournamentId: string, studentId?: string) {
  const tournament = await db.tournament.findUnique({ where: { id: tournamentId }, select: { entryFee: true, additionalEntryFee: true } });
  if (!tournament) return;
  const entries = await db.registration.findMany({
    where: { tournamentId, ...(studentId ? { studentId } : {}) },
    select: { id: true, studentId: true, fee: true, paymentStatus: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const seen = new Set<string>();
  for (const e of entries) {
    const isFirst = !seen.has(e.studentId);
    seen.add(e.studentId);
    // Paid entries keep what they paid. Every other entry follows the current fees: an entry that was
    // free (fee 0) owes the fee again if one is set later, and an unpaid one becomes free at 0.
    if (e.paymentStatus === "PAID") continue;
    const fee = feeFor(tournament, isFirst);
    const status = fee > 0 ? "PENDING" : "WAIVED";
    if (fee === e.fee && status === e.paymentStatus) continue;
    await db.registration.update({
      where: { id: e.id },
      // The payment order (if any) is kept: an order already paid is still matched; a new order uses the new fee.
      data: { fee, paymentStatus: status },
    });
  }
}

/** Why an entry can't be made now, for error messages. */
export function closedReason(t: Omit<Schedule, "entryFee">, now = new Date()) {
  return registrationPhase(t, now) === "NOT_OPEN"
    ? `Registration for this tournament opens on ${when(t.registrationOpensAt)}.`
    : "Registration for this tournament has closed.";
}

// Registration runs on a schedule the admin sets; nothing is switched by hand.
//   NOT_OPEN — before registrationOpensAt
//   OPEN     — registrationOpensAt → registrationClosesAt, at the entry fee
//   LATE     — registrationClosesAt → startDate, at the admin's (higher) late entry fee; registration never pauses
//   CLOSED   — from the tournament start (or once it is marked completed): no new entries or payments
// Fee policy for unpaid entries: an entry owes the fee of the period it is paid in. An entry made
// during regular registration but still unpaid at the deadline owes the late fee from then on (the
// deadline reminder warns about this). Paid and waived entries never change.
import prisma from "../db.js";

type Schedule = { registrationOpensAt: Date; registrationClosesAt: Date; startDate: Date; entryFee: number; lateEntryFee: number; status: string };

export type RegistrationPhase = "NOT_OPEN" | "OPEN" | "LATE" | "CLOSED";

export function registrationPhase(t: Schedule, now = new Date()): RegistrationPhase {
  if (t.status === "COMPLETED" || now >= t.startDate) return "CLOSED";
  if (now < t.registrationOpensAt) return "NOT_OPEN";
  return now < t.registrationClosesAt ? "OPEN" : "LATE";
}

/** The fee that applies right now: the entry fee until the regular deadline, then the late entry fee. */
export const applicableFee = (t: Schedule, now = new Date()) => (now >= t.registrationClosesAt ? t.lateEntryFee : t.entryFee);

/** Fee and type for an entry made right now, or null when registration isn't open. */
export function newEntryTerms(t: Schedule, now = new Date()): { fee: number; isLate: boolean; paymentStatus: "PENDING" | "WAIVED" } | null {
  const phase = registrationPhase(t, now);
  if (phase !== "OPEN" && phase !== "LATE") return null;
  const fee = applicableFee(t, now);
  return { fee, isLate: phase === "LATE", paymentStatus: fee > 0 ? "PENDING" : "WAIVED" };
}

/**
 * Bring unpaid entries in line with the fee policy: each owes the currently applicable fee. Run before
 * any payment is taken, after the admin edits the fees, and every minute (to switch to the late fee
 * right at the deadline). Entries that become free are marked waived. Paid entries are untouched.
 */
export async function repriceUnpaid(t: Schedule & { id: string }, now = new Date()) {
  if (registrationPhase(t, now) === "CLOSED") return 0;
  const fee = applicableFee(t, now);
  const { count } = await prisma.registration.updateMany({
    where: { tournamentId: t.id, paymentStatus: "PENDING", fee: { not: fee } },
    data: { fee, paymentStatus: fee > 0 ? "PENDING" : "WAIVED" },
  });
  return count;
}

const IST = { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" } as const;
const when = (d: Date) => d.toLocaleString("en-IN", IST);

/** Why an entry can't be made now, for error messages. */
export function closedReason(t: Schedule, now = new Date()) {
  return registrationPhase(t, now) === "NOT_OPEN"
    ? `Registration for this tournament opens on ${when(t.registrationOpensAt)}.`
    : "Registration for this tournament has closed.";
}

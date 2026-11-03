// Registration runs on a schedule the admin sets; nothing is switched by hand.
//   NOT_OPEN — before registrationOpensAt
//   OPEN     — registrationOpensAt → registrationClosesAt (regular registration)
//   LATE     — registrationClosesAt → startDate (late registration; entries are marked late)
//   CLOSED   — from the tournament start (or once it is marked completed): no new entries
// Registration is free: there are no entry fees or payments. Every entry is confirmed as soon as it
// is made (paymentStatus WAIVED, fee 0). The old fee/payment columns are kept only for history.
import prisma from "../db.js";

type Schedule = { registrationOpensAt: Date; registrationClosesAt: Date; startDate: Date; status: string };

export type RegistrationPhase = "NOT_OPEN" | "OPEN" | "LATE" | "CLOSED";

export function registrationPhase(t: Schedule, now = new Date()): RegistrationPhase {
  if (t.status === "COMPLETED" || now >= t.startDate) return "CLOSED";
  if (now < t.registrationOpensAt) return "NOT_OPEN";
  return now < t.registrationClosesAt ? "OPEN" : "LATE";
}

/** Terms for an entry made right now (free and confirmed), or null when registration isn't open. */
export function newEntryTerms(t: Schedule, now = new Date()): { fee: number; isLate: boolean; paymentStatus: "WAIVED" } | null {
  const phase = registrationPhase(t, now);
  if (phase !== "OPEN" && phase !== "LATE") return null;
  return { fee: 0, isLate: phase === "LATE", paymentStatus: "WAIVED" };
}

/**
 * Entries made back when registration had a fee and never paid: confirm them (nothing is due any more).
 * Paid entries keep their payment record. Returns how many changed.
 */
export async function confirmUnpaid(tournamentId?: string) {
  const { count } = await prisma.registration.updateMany({
    where: { paymentStatus: "PENDING", ...(tournamentId ? { tournamentId } : {}) },
    data: { fee: 0, paymentStatus: "WAIVED" },
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

// Registration runs on a schedule the admin sets; nothing is switched by hand.
//   NOT_OPEN — before registrationOpensAt
//   OPEN     — registrationOpensAt → registrationClosesAt
//   CLOSED   — from registrationClosesAt (or once the tournament is completed): no new entries
// There is no late registration: entries made earlier with isLate = true keep it for history only.
//
// Every entry is charged the tournament's entryFee. With a fee it starts as paymentStatus PENDING
// until it is paid (online payment is added in a later step); a free tournament's entries are WAIVED.
type Schedule = { registrationOpensAt: Date; registrationClosesAt: Date; startDate: Date; status: string; entryFee: number };

export type RegistrationPhase = "NOT_OPEN" | "OPEN" | "CLOSED";

export function registrationPhase(t: Omit<Schedule, "entryFee">, now = new Date()): RegistrationPhase {
  if (t.status === "COMPLETED" || now >= t.startDate || now >= t.registrationClosesAt) return "CLOSED";
  return now < t.registrationOpensAt ? "NOT_OPEN" : "OPEN";
}

export type EntryTerms = { fee: number; isLate: false; paymentStatus: "PENDING" | "WAIVED" };

/** Terms for an entry made right now, or null when registration isn't open. */
export function newEntryTerms(t: Schedule, now = new Date()): EntryTerms | null {
  if (registrationPhase(t, now) !== "OPEN") return null;
  return { fee: t.entryFee, isLate: false, paymentStatus: t.entryFee > 0 ? "PENDING" : "WAIVED" };
}

const IST = { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" } as const;
const when = (d: Date) => d.toLocaleString("en-IN", IST);

/** Why an entry can't be made now, for error messages. */
export function closedReason(t: Omit<Schedule, "entryFee">, now = new Date()) {
  return registrationPhase(t, now) === "NOT_OPEN"
    ? `Registration for this tournament opens on ${when(t.registrationOpensAt)}.`
    : "Registration for this tournament has closed.";
}

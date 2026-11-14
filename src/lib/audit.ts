// ─── Student audit log ───────────────────────────────────────────────────────
// Every change to a student record is written to StudentAuditLog: created (by an admin, an import or
// the student registering), updated (with each field's old and new value), approved, rejected and
// deleted. The table is append-only at the database level (see its migration), and its timestamps
// come from the database clock, so the history can't be rewritten. There is no API to change it.
import type { Prisma, Student } from "@prisma/client";
import prisma from "../db.js";

type Db = Prisma.TransactionClient | typeof prisma;

/** PAYMENT: an entry's payment changed (marked paid / unpaid by an admin, or paid online). ENTRY_REMOVED: an admin removed a tournament entry. */
export type AuditAction = "CREATED" | "UPDATED" | "APPROVED" | "REJECTED" | "DELETED" | "PAYMENT" | "ENTRY_REMOVED";
export const AUDIT_ACTIONS: AuditAction[] = ["CREATED", "UPDATED", "APPROVED", "REJECTED", "DELETED", "PAYMENT", "ENTRY_REMOVED"];
export type Actor = { type: "ADMIN" | "STUDENT" | "IMPORT"; name: string };
export type FieldChange = { field: string; label: string; from: string; to: string };

/** Fields shown in the history, with their labels. Anything else (ids, timestamps) is left out. */
const LABELS: Record<string, string> = {
  fullName: "Full name", fatherName: "Father's name", motherName: "Mother's name", gender: "Gender", dob: "Date of birth",
  bloodGroup: "Blood group", aadhaarNumber: "Aadhaar", phone: "Mobile", alternatePhone: "Alternate mobile",
  parentPhone: "Parent / emergency contact", emergencyPhone: "Emergency contact", email: "Email", nationality: "Nationality",
  residingPincode: "Residing pincode", outsideTamilNadu: "Outside Tamil Nadu", district: "District", taluk: "Taluk",
  representing: "Representing", representingDistrict: "Representing district", representingUnit: "Representing unit",
  address: "Address", city: "City", state: "State", pincode: "Pincode", annualIncome: "Annual income", isBPL: "BPL family",
  institutionType: "Institution type", institutionName: "Institution", grade: "Standard / year", degreeDepartment: "Department",
  participantType: "Type", employmentType: "Employment type", organisationName: "Organisation", occupation: "Designation",
  club: "Club", rootCoach: "Root coach", belt: "Belt", weightKg: "Weight (kg)", managerName: "Manager",
  districtPresident: "District president", districtSecretary: "District secretary",
  status: "Status", studentNo: "Student ID", reviewNote: "Review note",
};

/** A value as shown in the history. Aadhaar numbers are masked: the log must not leak them. */
function show(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (field === "aadhaarNumber") return `XXXX XXXX ${String(value).slice(-4)}`;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** What changed between two versions of a student, field by field. */
export function diffStudent(before: Partial<Student>, after: Partial<Student>): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, label] of Object.entries(LABELS)) {
    if (!(field in after)) continue;
    const from = show(field, before[field as keyof Student]);
    const to = show(field, after[field as keyof Student]);
    // emergencyPhone always mirrors parentPhone: don't list the same change twice.
    if (from !== to && field !== "emergencyPhone") changes.push({ field, label, from, to });
  }
  return changes;
}

/** Write one entry. Use the same transaction as the change, so the change and its record go together. */
export async function recordStudentAudit(
  db: Db,
  student: Pick<Student, "id" | "studentNo" | "fullName">,
  action: AuditAction,
  actor: Actor,
  extra: { changes?: FieldChange[]; note?: string } = {},
) {
  await db.studentAuditLog.create({
    data: {
      studentId: student.id, studentNo: student.studentNo, studentName: student.fullName, action,
      actorType: actor.type, actor: actor.name, changes: extra.changes ?? [], note: extra.note ?? "",
    },
  });
}

// ─── Payments ────────────────────────────────────────────────────────────────

type PaymentState = { paymentStatus: string; paymentMode: string | null; amountPaid: number; fee: number; paidAt: Date | null };
type EntryRef = { ageGroup: string; gender: string; weightCategory: string };

const PAYMENT_STATUS: Record<string, string> = { PENDING: "Unpaid", PAID: "Paid", WAIVED: "Free" };
const PAYMENT_MODE: Record<string, string> = { RAZORPAY: "Online", CASH: "Cash", UPI: "UPI", OTHER: "Other" };
const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const when = (d: Date | null) => (d ? d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "");

/** "Super Trophy 2026 · Senior · Boys -73kg" */
export const entryLabel = (tournament: string, e: EntryRef) => `${tournament} · ${e.ageGroup} · ${e.gender === "FEMALE" ? "Girls" : "Boys"} ${e.weightCategory}`;

/** What changed in an entry's payment, field by field. */
function diffPayment(before: PaymentState, after: PaymentState): FieldChange[] {
  const rows: [string, string, string, string][] = [
    ["paymentStatus", "Payment", PAYMENT_STATUS[before.paymentStatus] ?? before.paymentStatus, PAYMENT_STATUS[after.paymentStatus] ?? after.paymentStatus],
    ["paymentMode", "Paid by", before.paymentMode ? PAYMENT_MODE[before.paymentMode] ?? before.paymentMode : "", after.paymentMode ? PAYMENT_MODE[after.paymentMode] ?? after.paymentMode : ""],
    ["amountPaid", "Amount paid", before.amountPaid ? rupees(before.amountPaid) : "", after.amountPaid ? rupees(after.amountPaid) : ""],
    ["fee", "Entry fee", rupees(before.fee), rupees(after.fee)],
    ["paidAt", "Paid on", when(before.paidAt), when(after.paidAt)],
  ];
  return rows.filter(([, , from, to]) => from !== to).map(([field, label, from, to]) => ({ field, label, from, to }));
}

/**
 * Log a change to an entry's payment against the student (shown in Admin → Audit log and on the student).
 * Nothing is written when nothing changed. Use the same transaction as the change when there is one.
 */
export async function recordPaymentAudit(
  db: Db,
  student: Pick<Student, "id" | "studentNo" | "fullName">,
  entry: { tournament: string } & EntryRef,
  before: PaymentState,
  after: PaymentState,
  actor: Actor,
  note = "",
) {
  const changes = diffPayment(before, after);
  if (!changes.length) return;
  await recordStudentAudit(db, student, "PAYMENT", actor, { changes, note: [entryLabel(entry.tournament, entry), note].filter(Boolean).join(" — ") });
}

/** The admin making the request, as the actor of a change. */
export const adminActor = (req: { admin?: { username: string } }): Actor => ({ type: "ADMIN", name: req.admin?.username || "admin" });

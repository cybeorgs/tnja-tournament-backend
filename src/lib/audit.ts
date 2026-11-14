// ─── Student audit log ───────────────────────────────────────────────────────
// Every change to a student record is written to StudentAuditLog: created (by an admin, an import or
// the student registering), updated (with each field's old and new value), approved, rejected and
// deleted. The table is append-only at the database level (see its migration), and its timestamps
// come from the database clock, so the history can't be rewritten. There is no API to change it.
import type { Prisma, Student } from "@prisma/client";
import prisma from "../db.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type AuditAction = "CREATED" | "UPDATED" | "APPROVED" | "REJECTED" | "DELETED";
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

/** The admin making the request, as the actor of a change. */
export const adminActor = (req: { admin?: { username: string } }): Actor => ({ type: "ADMIN", name: req.admin?.username || "admin" });

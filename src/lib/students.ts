import type { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../db.js";
import { HttpError } from "../middleware/errors.js";
import { getSettings } from "./helpers.js";
import { isKnownLocation } from "./locations.js";

type Tx = Prisma.TransactionClient;

// ─── Registration details (same fields as the main TNJA player registration) ──

const name = (label: string) => z.string().trim().min(2, `${label} is required`).max(120).regex(/^[A-Za-z\s.'-]+$/, `${label} can only contain letters`);
const text = (label: string, max = 120) => z.string().trim().min(1, `${label} is required`).max(max);
const optional = (max = 120) => z.string().trim().max(max).default("");
const pincode = (label: string) => z.string().trim().regex(/^[1-9]\d{5}$/, `${label} must be 6 digits`);
const mobile = z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number");

const threeYearsAgo = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 3);
  return d;
};

export const BLOOD_GROUPS = ["O+ve", "O-ve", "A+ve", "A-ve", "B+ve", "B-ve", "AB+ve", "AB-ve"] as const;

export const studentSchema = z
  .object({
    // Residing location
    district: text("District", 80),
    taluk: text("Taluk", 80),
    residingPincode: pincode("Residing pincode"),

    // Personal information
    fullName: name("Full name"),
    fatherName: name("Father's name"),
    motherName: name("Mother's name"),
    gender: z.enum(["MALE", "FEMALE"], { error: "Choose the gender" }),
    dob: z.coerce.date({ error: "Date of birth is required" }).refine((d) => d <= threeYearsAgo(), "Student must be at least 3 years old"),
    bloodGroup: z.enum(BLOOD_GROUPS, { error: "Choose the blood group" }),
    aadhaarNumber: z.string().trim().regex(/^\d{12}$/, "Aadhaar number must be 12 digits"),
    phone: mobile,
    alternatePhone: z.union([z.literal(""), mobile]).default(""),
    email: z.email("Enter a valid email address").max(254),
    nationality: name("Nationality"),

    // Permanent address
    address: z.string().trim().min(3, "Address is required").max(300),
    city: name("City"),
    state: name("State"),
    pincode: pincode("Pincode"),

    // Financial
    annualIncome: z.coerce.number({ error: "Annual income is required" }).int().min(0).max(1_000_000_000),

    // Education
    institutionType: z.enum(["SCHOOL", "COLLEGE", "DIPLOMA"], { error: "Choose the institution type" }),
    institutionName: text("Institution name", 150),
    grade: text("Standard / year", 40),
    degreeDepartment: optional(),

    // Academy (optional)
    club: optional(),
    coachName: optional(),
    belt: optional(40),
  })
  .refine((s) => isKnownLocation(s.district, s.taluk), { message: "Choose a taluk from the selected district", path: ["taluk"] });

export type StudentData = z.infer<typeof studentSchema>;

/** One Aadhaar number, one student ID. */
export async function assertAadhaarFree(tx: Tx | typeof prisma, aadhaarNumber: string, exceptId?: string) {
  const other = await tx.student.findUnique({ where: { aadhaarNumber }, select: { id: true, studentNo: true } });
  if (other && other.id !== exceptId) {
    throw new HttpError(409, `This Aadhaar number is already registered (student ID ${other.studentNo}).`);
  }
}

// ─── Permanent student ID ────────────────────────────────────────────────────

/** Next permanent student ID, e.g. TNJA-S-000123. Numbers come from a database sequence, so they never repeat. */
async function nextStudentNo(tx: Tx): Promise<string> {
  const settings = await getSettings();
  const prefix = settings.orgShortName.replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "STU";
  const [row] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('student_no_seq') AS n`;
  return `${prefix}-S-${String(row!.n).padStart(6, "0")}`;
}

/** Create a student with a freshly issued permanent ID. */
export async function createStudent(tx: Tx, data: StudentData, source: "ADMIN" | "SELF" = "ADMIN") {
  await assertAadhaarFree(tx, data.aadhaarNumber);
  return tx.student.create({ data: { ...data, source, studentNo: await nextStudentNo(tx) } });
}

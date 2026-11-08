import type { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../db.js";
import { HttpError } from "../middleware/errors.js";
import { getSettings } from "./helpers.js";
import { PINCODE_FORMAT_MESSAGE, PINCODE_PATTERN, isKnownLocation, lookupPincode } from "./locations.js";
import { recordStudentAudit, type Actor } from "./audit.js";

type Tx = Prisma.TransactionClient;

// ─── Registration details (same fields as the main TNJA player registration) ──

const name = (label: string) => z.string().trim().min(2, `${label} is required`).max(120).regex(/^[A-Za-z\s.'-]+$/, `${label} can only contain letters`);
const text = (label: string, max = 120) => z.string().trim().min(1, `${label} is required`).max(max);
const optional = (max = 120) => z.string().trim().max(max).default("");
const pincode = (label: string) => z.string().trim().regex(PINCODE_PATTERN, `${label} ${PINCODE_FORMAT_MESSAGE}`);
const mobile = z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number");

const threeYearsAgo = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 3);
  return d;
};

export const BLOOD_GROUPS = ["O+ve", "O-ve", "A+ve", "A-ve", "B+ve", "B-ve", "AB+ve", "AB-ve"] as const;
export const PARTICIPANT_TYPES = ["STUDENT", "PROFESSIONAL"] as const;
export const EMPLOYMENT_TYPES = ["PRIVATE", "GOVERNMENT", "SELF_EMPLOYED", "OTHER"] as const;

export const studentSchema = z
  .object({
    // Residing location. Tamil Nadu residents pick a district and taluk from the list;
    // everyone else types their district and needs admin approval (see createStudent).
    residingPincode: pincode("Residing pincode"),
    outsideTamilNadu: z.boolean().default(false),
    district: text("District", 80),
    taluk: optional(80),

    // Personal information
    fullName: name("Full name"),
    fatherName: name("Father's name"),
    motherName: name("Mother's name"),
    /** Male or female only. (Older records may still be OTHER; they pick boys' or girls' categories per tournament.) */
    gender: z.enum(["MALE", "FEMALE"], { error: "Choose male or female" }),
    dob: z.coerce.date({ error: "Date of birth is required" }).refine((d) => d <= threeYearsAgo(), "Student must be at least 3 years old"),
    bloodGroup: z.enum(BLOOD_GROUPS, { error: "Choose the blood group" }),
    aadhaarNumber: z.string().trim().regex(/^\d{12}$/, "Aadhaar number must be 12 digits"),
    phone: mobile,
    alternatePhone: z.union([z.literal(""), mobile]).default(""),
    /** Parent's mobile, which is also the emergency contact (confirmResidency keeps the two equal). Required when players register themselves. */
    parentPhone: z.union([z.literal(""), z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit parent / emergency contact number")]).default(""),
    emergencyPhone: z.union([z.literal(""), z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit emergency contact number")]).default(""),
    email: z.email("Enter a valid email address").max(254).transform((e) => e.trim().toLowerCase()),
    nationality: name("Nationality"),

    // Permanent address
    address: z.string().trim().min(3, "Address is required").max(300),
    city: name("City"),
    state: name("State"),
    pincode: pincode("Pincode"),

    // Financial
    annualIncome: z.coerce.number({ error: "Annual income is required" }).int().min(0).max(1_000_000_000),
    isBPL: z.boolean().default(false),

    /** Student or working professional: decides whether the education or the occupation details are required */
    participantType: z.enum(PARTICIPANT_TYPES, { error: "Choose student or working professional" }).default("STUDENT"),

    // Education (students)
    institutionType: z.union([z.literal(""), z.enum(["SCHOOL", "COLLEGE", "DIPLOMA"], { error: "Choose the institution type" })]).default(""),
    institutionName: optional(150),
    grade: optional(40),
    degreeDepartment: optional(),

    // Occupation (working professionals)
    employmentType: z.union([z.literal(""), z.enum(EMPLOYMENT_TYPES, { error: "Choose the employment type" })]).default(""),
    organisationName: optional(150),
    occupation: optional(100),

    // Academy (optional)
    club: optional(),
    coachName: optional(),
    belt: optional(40),

    // Additional details (printed on the Tournament Entry Pass). Weight is required when students register themselves.
    weightKg: z.union([z.literal("").transform(() => null), z.coerce.number().min(10, "Weight looks too low").max(250, "Weight looks too high")]).nullable().default(null),
    managerName: optional(),
    districtPresident: optional(),
    districtSecretary: optional(),
  })
  // Students give their education, working professionals their occupation.
  .superRefine((s, ctx) => {
    const need = (ok: unknown, path: string, message: string) => { if (!ok) ctx.addIssue({ code: "custom", path: [path], message }); };
    if (s.participantType === "PROFESSIONAL") {
      need(s.employmentType, "employmentType", "Choose the employment type");
      need(s.organisationName, "organisationName", "Organisation / employer name is required");
      need(s.occupation, "occupation", "Designation / role is required");
    } else {
      need(s.institutionType, "institutionType", "Choose the institution type");
      need(s.institutionName, "institutionName", "Institution name is required");
      need(s.grade, "grade", "Standard / year is required");
    }
  });

export type StudentData = z.infer<typeof studentSchema>;

/** Keep only the details for the participant type: education for students, occupation for working professionals. */
function clearOtherDetails<T>(data: T): T {
  const type = (data as { participantType?: string }).participantType;
  if (type === "PROFESSIONAL") return { ...data, institutionType: "", institutionName: "", grade: "", degreeDepartment: "" };
  if (type === "STUDENT") return { ...data, employmentType: "", organisationName: "", occupation: "" };
  return data;
}

/**
 * Decide from the pincode itself whether the student lives in Tamil Nadu, rather than trusting
 * the form (if the lookup service is down, the form's answer is kept). Tamil Nadu residents must
 * pick a district and taluk from the list.
 */
export async function confirmResidency<T extends { residingPincode: string; outsideTamilNadu: boolean; isBPL: boolean; district: string; taluk: string; parentPhone: string; emergencyPhone: string }>(data: T): Promise<T> {
  // One number: the parent's mobile is the emergency contact (whichever was given fills both).
  const contact = data.parentPhone || data.emergencyPhone;
  data = clearOtherDetails({ ...data, parentPhone: contact, emergencyPhone: contact });
  let outside = data.outsideTamilNadu;
  try {
    outside = !(await lookupPincode(data.residingPincode)).inTamilNadu;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) throw new HttpError(400, "The residing pincode wasn't found. Please check it.");
  }
  if (!outside && !isKnownLocation(data.district, data.taluk)) {
    throw new HttpError(400, "taluk: Choose a taluk from the selected district");
  }
  // BPL is a Tamil Nadu scheme.
  return { ...data, outsideTamilNadu: outside, isBPL: outside ? false : data.isBPL };
}

/** One Aadhaar number, one student. */
export async function assertAadhaarFree(tx: Tx | typeof prisma, aadhaarNumber: string, exceptId?: string) {
  const other = await tx.student.findUnique({ where: { aadhaarNumber }, select: { id: true, studentNo: true, fullName: true } });
  if (other && other.id !== exceptId) {
    throw new HttpError(409, `This Aadhaar number is already registered (${other.studentNo ?? `${other.fullName}, awaiting approval`}).`);
  }
}

// ─── Documents ───────────────────────────────────────────────────────────────

export const DOCUMENT_KINDS = ["PHOTO", "BPL_PROOF", "NATIVITY_PROOF"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export type StudentUpload = { kind: DocumentKind; label: string; mime: string; data: Uint8Array<ArrayBuffer> };

const MIME_BY_PREFIX: Record<string, string> = {
  "data:image/png;base64": "image/png",
  "data:image/jpeg;base64": "image/jpeg",
  "data:image/jpg;base64": "image/jpeg",
  "data:image/webp;base64": "image/webp",
  "data:application/pdf;base64": "application/pdf",
};

/** Decode an uploaded data: URL, checking its type and size. `imageOnly` refuses PDFs (and WEBP, which PDFs can't embed). */
export function decodeUpload(dataUrl: string, label: string, maxBytes = 1024 * 1024, { imageOnly = false } = {}) {
  const [header, base64] = dataUrl.split(",", 2);
  const mime = MIME_BY_PREFIX[header ?? ""];
  if (imageOnly && mime !== "image/jpeg" && mime !== "image/png") throw new HttpError(400, `${label} must be a JPG or PNG image.`);
  if (!mime) throw new HttpError(400, `${label} must be a JPG, PNG, WEBP or PDF file.`);
  const data = Uint8Array.from(Buffer.from(base64 || "", "base64"));
  if (data.length === 0) throw new HttpError(400, `${label} is empty.`);
  if (data.length > maxBytes) throw new HttpError(400, `${label} must be smaller than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  return { mime, data };
}

// ─── Permanent student ID ────────────────────────────────────────────────────

/**
 * Next permanent ID: TNJA-S-000123 for a student, TNJA-P-000124 for a working professional.
 * Both share one database sequence, so a number is never used twice.
 */
async function nextStudentNo(tx: Tx, participantType: string): Promise<string> {
  const settings = await getSettings();
  const prefix = settings.orgShortName.replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "STU";
  const [row] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('student_no_seq') AS n`;
  return `${prefix}-${participantType === "PROFESSIONAL" ? "P" : "S"}-${String(row!.n).padStart(6, "0")}`;
}

/**
 * Create a student.
 * Students added by an admin, and Tamil Nadu residents, get their permanent ID straight away;
 * anyone else registering themselves waits (PENDING) until an admin approves their documents.
 */
export async function createStudent(
  tx: Tx,
  data: StudentData,
  {
    source = "ADMIN",
    documents = [],
    bulkImport: _bulkImport = false,
    actor,
  }: {
    source?: "ADMIN" | "SELF";
    documents?: StudentUpload[];
    /** Admin bulk import from a spreadsheet */
    bulkImport?: boolean;
    /** Who is adding the student, for the audit log (the student themselves when source is SELF) */
    actor?: Actor;
  } = {},
) {
  await assertAadhaarFree(tx, data.aadhaarNumber);
  const approved = source === "ADMIN" || !data.outsideTamilNadu;
  const student = await tx.student.create({
    data: { ...data, source, status: approved ? "APPROVED" : "PENDING", studentNo: approved ? await nextStudentNo(tx, data.participantType) : null },
  });
  for (const doc of documents) await tx.studentDocument.create({ data: { studentId: student.id, ...doc } });
  const by: Actor = actor ?? (source === "SELF" ? { type: "STUDENT", name: student.email } : { type: _bulkImport ? "IMPORT" : "ADMIN", name: "admin" });
  await recordStudentAudit(tx, student, "CREATED", by, { note: source === "SELF" ? "Registered on the website" : _bulkImport ? "Imported from a spreadsheet" : "Added by an admin" });
  return student;
}

/** Approve a pending application, issuing the permanent ID. */
export async function approveStudent(tx: Tx, id: string) {
  const student = await tx.student.findUnique({ where: { id } });
  if (!student) throw new HttpError(404, "Student not found.");
  if (student.status === "APPROVED") return student;
  return tx.student.update({
    where: { id },
    data: { status: "APPROVED", studentNo: student.studentNo ?? (await nextStudentNo(tx, student.participantType)), reviewNote: "", reviewedAt: new Date() },
  });
}

// ─── Bulk student import from Excel / CSV ────────────────────────────────────
// Each row is checked exactly like the "Add student" form (studentSchema + residency), so an
// imported student is indistinguishable from one added by hand. Nothing is invented: a missing
// required field is reported for that row, not filled with a default.

import { HttpError } from "../middleware/errors.js";
import prisma from "../db.js";
import { BLOOD_GROUPS, confirmResidency, studentSchema, type StudentData } from "./students.js";
import { TN_LOCATIONS } from "./locations.js";
import { digits, key, readImportSheet, str, templateWorkbook as buildTemplate, type Cell, type ImportColumn } from "./importSheet.js";

export const IMPORT_MAX_ROWS = 2000;

type Field = keyof StudentData;

/** Columns of the template, with the other header spellings accepted (compared without case, spaces or punctuation). */
export const IMPORT_COLUMNS: ImportColumn<Field>[] = [
  { field: "fullName", header: "Full Name", required: true, aliases: ["name", "studentname", "playername"], note: "Letters only", example: "Arun Kumar" },
  { field: "gender", header: "Gender", required: true, aliases: ["sex"], note: "Male, Female or Other", example: "Male" },
  { field: "dob", header: "Date of Birth", required: true, aliases: ["dob", "birthdate"], note: "DD-MM-YYYY (or an Excel date)", example: "15-06-2010" },
  { field: "fatherName", header: "Father's Name", required: true, aliases: ["father", "fathersname"], note: "", example: "Kumar S" },
  { field: "motherName", header: "Mother's Name", required: true, aliases: ["mother", "mothersname"], note: "", example: "Lakshmi K" },
  { field: "bloodGroup", header: "Blood Group", required: true, aliases: ["blood"], note: BLOOD_GROUPS.join(", ") + " (O+ also works)", example: "O+ve" },
  { field: "aadhaarNumber", header: "Aadhaar Number", required: true, aliases: ["aadhaar", "aadhar", "aadharnumber", "aadhaarno"], note: "12 digits; one student per Aadhaar", example: "123412341234" },
  { field: "phone", header: "Mobile Number", required: true, aliases: ["mobile", "phone", "phonenumber", "mobileno", "contactnumber"], note: "10 digits", example: "9876543210" },
  { field: "alternatePhone", header: "Alternate Mobile", required: false, aliases: ["alternatephone", "alternatenumber", "alternatemobilenumber"], note: "", example: "" },
  { field: "email", header: "Email", required: true, aliases: ["emailid", "emailaddress", "mail"], note: "The login is sent here; siblings may share one", example: "arun@example.com" },
  { field: "residingPincode", header: "Residing Pincode", required: false, aliases: ["residingpin"], note: "Where they live / study; defaults to Pincode", example: "600002" },
  { field: "district", header: "District", required: true, aliases: ["districtname"], note: "Tamil Nadu: as in the district list", example: "Chennai" },
  { field: "taluk", header: "Taluk", required: false, aliases: ["talukname"], note: "Required for Tamil Nadu residents", example: "Egmore" },
  { field: "address", header: "Address", required: true, aliases: ["permanentaddress", "doorno"], note: "", example: "12, Anna Salai" },
  { field: "city", header: "City", required: true, aliases: ["town", "village"], note: "", example: "Chennai" },
  { field: "state", header: "State", required: true, aliases: [], note: "", example: "Tamil Nadu" },
  { field: "pincode", header: "Pincode", required: true, aliases: ["pin", "zipcode", "postalcode", "addresspincode"], note: "6 digits", example: "600002" },
  { field: "nationality", header: "Nationality", required: false, aliases: [], note: "Defaults to Indian", example: "Indian" },
  { field: "annualIncome", header: "Annual Income", required: true, aliases: ["income", "familyincome"], note: "Rupees, numbers only", example: 150000 },
  { field: "isBPL", header: "BPL", required: false, aliases: ["isbpl", "belowpovertyline"], note: "Yes or No", example: "No" },
  { field: "institutionType", header: "Institution Type", required: true, aliases: ["institution type", "studying"], note: "School, College or Diploma", example: "School" },
  { field: "institutionName", header: "Institution Name", required: true, aliases: ["institution", "schoolname", "school", "collegename", "college"], note: "", example: "Govt Hr Sec School" },
  { field: "grade", header: "Standard / Year", required: true, aliases: ["grade", "class", "standard", "year", "std"], note: "", example: "10th" },
  { field: "degreeDepartment", header: "Department", required: false, aliases: ["degree", "degreedepartment", "course"], note: "College / diploma", example: "" },
  { field: "club", header: "Club", required: false, aliases: ["academy", "clubname", "dojo"], note: "", example: "Chennai Judo Club" },
  { field: "coachName", header: "Coach Name", required: false, aliases: ["coach"], note: "", example: "Ravi M" },
  { field: "belt", header: "Belt", required: false, aliases: ["beltgrade", "kyu"], note: "", example: "Yellow" },
];

const EXAMPLE_AADHAAR = String(IMPORT_COLUMNS.find((c) => c.field === "aadhaarNumber")!.example);

/** The first sheet as rows keyed by student field */
export const readSheet = (file: Buffer, filename: string) => readImportSheet(file, filename, IMPORT_COLUMNS, { maxRows: IMPORT_MAX_ROWS, noun: "students" });

/** A calendar date, or the text itself when the day doesn't exist (e.g. 31-02-2010) so the schema reports it */
function utcDate(y: number, m: number, d: number, text: string): Date | string {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : text;
}

function parseDate(v: Cell | undefined): Date | string {
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(Math.round((v - 25569) * 86400 * 1000)); // Excel serial date
  const s = str(v);
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (dmy) return utcDate(+dmy[3]!, +dmy[2]!, +dmy[1]!, s);
  const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (ymd) return utcDate(+ymd[1]!, +ymd[2]!, +ymd[3]!, s);
  return s; // let the schema report it
}

function parseGender(v: Cell | undefined) {
  const s = key(str(v));
  if (["m", "male", "boy", "men"].includes(s)) return "MALE";
  if (["f", "female", "girl", "women"].includes(s)) return "FEMALE";
  if (["o", "other", "others", "transgender"].includes(s)) return "OTHER";
  return s.toUpperCase();
}

function parseBloodGroup(v: Cell | undefined) {
  const s = str(v).toUpperCase().replace(/\s+/g, "").replace(/POSITIVE|POS|\+VE/g, "+").replace(/NEGATIVE|NEG|-VE/g, "-");
  const m = /^(AB|A|B|O)([+-])$/.exec(s);
  return m ? `${m[1]}${m[2]}ve` : str(v);
}

const yes = (v: Cell | undefined) => (typeof v === "boolean" ? v : ["yes", "y", "true", "1", "bpl"].includes(key(str(v))));

/** Match Tamil Nadu district / taluk names whatever their case or spacing. */
function canonicalLocation(district: string, taluk: string) {
  const d = TN_LOCATIONS.find((x) => key(x.district) === key(district));
  if (!d) return { district, taluk };
  return { district: d.district, taluk: d.taluks.find((t) => key(t) === key(taluk)) ?? taluk };
}

const LABEL = new Map(IMPORT_COLUMNS.map((c) => [c.field as string, c.header]));

function toInput(values: Partial<Record<Field, Cell>>) {
  const v = values;
  const pincode = digits(v.pincode);
  const location = canonicalLocation(str(v.district), str(v.taluk));
  const institution = key(str(v.institutionType));
  return {
    fullName: str(v.fullName),
    fatherName: str(v.fatherName),
    motherName: str(v.motherName),
    gender: parseGender(v.gender),
    dob: parseDate(v.dob),
    bloodGroup: parseBloodGroup(v.bloodGroup),
    aadhaarNumber: digits(v.aadhaarNumber),
    phone: digits(v.phone).replace(/^(91|0)(?=\d{10}$)/, ""),
    alternatePhone: digits(v.alternatePhone).replace(/^(91|0)(?=\d{10}$)/, ""),
    email: str(v.email),
    residingPincode: digits(v.residingPincode) || pincode,
    outsideTamilNadu: false, // decided from the pincode by confirmResidency
    district: location.district,
    taluk: location.taluk,
    address: str(v.address),
    city: str(v.city),
    state: str(v.state),
    pincode,
    nationality: str(v.nationality) || "Indian",
    annualIncome: str(v.annualIncome).replace(/[,₹\s]/g, "") || undefined,
    isBPL: yes(v.isBPL),
    institutionType: institution.startsWith("school") ? "SCHOOL" : institution.startsWith("college") ? "COLLEGE" : institution.startsWith("diploma") || institution.startsWith("polytechnic") ? "DIPLOMA" : str(v.institutionType).toUpperCase(),
    institutionName: str(v.institutionName),
    grade: str(v.grade),
    degreeDepartment: str(v.degreeDepartment),
    club: str(v.club),
    coachName: str(v.coachName),
    belt: str(v.belt),
  };
}

export interface CheckedRow {
  row: number;
  fullName: string;
  email: string;
  district: string;
  /** null when the row can be imported */
  errors: string[];
  data: StudentData | null;
}

/** Validate every row: the form's rules, Tamil Nadu residency, and no Aadhaar number used twice (in the file or already registered). */
export async function checkRows(rows: { row: number; values: Partial<Record<Field, Cell>> }[], onProgress?: (done: number) => void): Promise<CheckedRow[]> {
  const checked: CheckedRow[] = [];
  for (const { row, values } of rows) {
    const input = toInput(values);
    const errors: string[] = [];
    if (input.aadhaarNumber === EXAMPLE_AADHAAR) {
      checked.push({ row, fullName: input.fullName, email: input.email, district: input.district, errors: ["This is the template's example row — delete it"], data: null });
      continue;
    }
    let data: StudentData | null = null;
    const parsed = studentSchema.safeParse(input);
    if (!parsed.success) {
      const seen = new Set<string>();
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "");
        // The residing pincode defaults to the pincode: report the pincode only
        if (seen.has(field) || (field === "residingPincode" && values.residingPincode === undefined)) continue;
        seen.add(field);
        const raw = values[field as Field];
        const label = LABEL.get(field) ?? field;
        errors.push(raw === undefined && field ? `${label} is missing` : field === "dob" ? `${label}: "${str(raw)}" isn't a valid date (use DD-MM-YYYY)` : `${label}: ${issue.message}`);
      }
    } else {
      try {
        data = await confirmResidency(parsed.data);
      } catch (err) {
        errors.push(err instanceof HttpError ? err.message.replace(/^taluk: /, "Taluk: ") : "Couldn't check the residing pincode");
      }
    }
    checked.push({ row, fullName: input.fullName, email: input.email.toLowerCase(), district: input.district, errors, data: errors.length ? null : data });
    onProgress?.(checked.length);
  }

  // One Aadhaar, one student: within the file…
  const byAadhaar = new Map<string, number>();
  for (const r of checked) {
    if (!r.data) continue;
    const first = byAadhaar.get(r.data.aadhaarNumber);
    if (first !== undefined) {
      r.errors.push(`Same Aadhaar number as row ${first}`);
      r.data = null;
    } else byAadhaar.set(r.data.aadhaarNumber, r.row);
  }
  // …and against students already registered
  const existing = await prisma.student.findMany({ where: { aadhaarNumber: { in: [...byAadhaar.keys()] } }, select: { aadhaarNumber: true, studentNo: true, fullName: true } });
  const taken = new Map(existing.map((s) => [s.aadhaarNumber!, s]));
  for (const r of checked) {
    const other = r.data && taken.get(r.data.aadhaarNumber);
    if (other) {
      r.errors.push(`Aadhaar already registered (${other.studentNo ?? other.fullName})`);
      r.data = null;
    }
  }
  return checked;
}

/** The import template: a header row with one example, and a sheet explaining each column. */
export const templateWorkbook = () =>
  buildTemplate("Students", IMPORT_COLUMNS, [
    "Orange columns are required. Replace the example row (row 2) with your students, one per row.",
    "Each student gets a permanent student ID and an email with a link to set their password.",
    "Students living outside Tamil Nadu (by residing pincode) can be imported too; leave Taluk empty for them.",
    `Up to ${IMPORT_MAX_ROWS} students per file. Save as .xlsx (or .csv).`,
  ]);

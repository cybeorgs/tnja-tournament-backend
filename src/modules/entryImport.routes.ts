// ─── Bulk tournament entry import ────────────────────────────────────────────
// Enter many students in a tournament from a spreadsheet. Students come from the master list
// (by student ID or Aadhaar number); each row is checked exactly like "Register student":
// registration open, approved student, age eligibility, gender, weight class, not already entered.

import express, { Router } from "express";
import prisma from "../db.js";
import { HttpError } from "../middleware/errors.js";
import { eligibleAgeGroups, type Gender } from "../lib/categories.js";
import { findTournament, newCertificateNo, param } from "../lib/helpers.js";
import { closedReason, newEntryTerms, repriceEntries } from "../lib/fees.js";
import { digits, key, readImportSheet, str, templateWorkbook, undeliverable, type Cell, type ImportColumn } from "../lib/importSheet.js";
import { getJob, startJob } from "../lib/importJobs.js";
import { resolveCategory } from "./tournaments.routes.js";

/** Mounted at /tournaments/:id (see app.ts) */
const router = Router({ mergeParams: true });
export default router;

const MAX_ROWS = 2000;

type Field = "studentNo" | "aadhaarNumber" | "fullName" | "ageGroups" | "weightKg" | "competeAs";

export const COLUMNS: ImportColumn<Field>[] = [
  { field: "studentNo", header: "Student ID", required: false, aliases: ["studentid", "studentno", "id", "permanentid", "tnjaid", "playerid"], note: "The student's permanent ID (or give the Aadhaar number instead)", example: "TNJA-S-000123" },
  { field: "aadhaarNumber", header: "Aadhaar Number", required: false, aliases: ["aadhaar", "aadhar", "aadharnumber"], note: "Used when there is no Student ID", example: "" },
  { field: "fullName", header: "Full Name", required: false, aliases: ["name", "studentname", "playername"], note: "Optional check: must match the student found", example: "Arun Kumar" },
  { field: "ageGroups", header: "Age Groups", required: false, aliases: ["agegroup", "categories", "category", "agecategory"], note: "One or more, separated by commas (e.g. Cadet, Junior, Senior), or All for every eligible group. Empty: the student's own age group", example: "Cadet, Junior" },
  { field: "weightKg", header: "Weight (kg)", required: true, aliases: ["weight", "weightkg", "bodyweight", "weightentered", "weightenteredkg"], note: "The weight class is worked out from this", example: 52.5 },
  { field: "competeAs", header: "Compete In", required: false, aliases: ["competeas", "competein", "section"], note: "Only for students whose gender is Other: Boys or Girls", example: "" },
];
const LABEL = new Map(COLUMNS.map((c) => [c.field, c.header]));

type Row = { row: number; values: Partial<Record<Field, Cell>> };
type Tournament = Awaited<ReturnType<typeof findTournament>>;
type Category = Awaited<ReturnType<typeof resolveCategory>>;

interface CheckedRow {
  row: number;
  fullName: string;
  studentNo: string;
  /** e.g. ["Cadet · -50kg", "Junior · -55kg"] */
  entries: string[];
  errors: string[];
  plan: null | { studentId: string; categories: Category[] };
}

function parseCompeteAs(v: Cell | undefined): Gender | undefined | null {
  const s = key(str(v));
  if (!s) return undefined;
  if (["boys", "boy", "male", "m", "men"].includes(s)) return "MALE";
  if (["girls", "girl", "female", "f", "women"].includes(s)) return "FEMALE";
  return null;
}

const sameName = (a: string, b: string) => key(a) === key(b);

/**
 * An Entries export has one row per entry, so a student in Junior and Senior is on two rows.
 * Rows for the same student with the same weight become one row with both age groups; any
 * other repeat is left alone and reported as "Same student as row …".
 */
function mergeRepeatedStudents(rows: Row[]): Row[] {
  const firstFor = new Map<string, Row>();
  const merged: Row[] = [];
  for (const { row, values } of rows) {
    const id = str(values.studentNo).toUpperCase() || digits(values.aadhaarNumber);
    const first = id ? firstFor.get(id) : undefined;
    const groups = str(values.ageGroups);
    if (first && groups && str(first.values.ageGroups) && str(first.values.weightKg) === str(values.weightKg)) {
      first.values.ageGroups = `${str(first.values.ageGroups)}, ${groups}`;
      continue;
    }
    const copy = { row, values: { ...values } };
    if (id && !first) firstFor.set(id, copy);
    merged.push(copy);
  }
  return merged;
}

/** `db`: the Prisma client, or a transaction (tests) */
export async function checkRows(tournament: Tournament, sheetRows: Row[], db: Pick<typeof prisma, "student" | "registration"> = prisma, onProgress?: (done: number) => void): Promise<CheckedRow[]> {
  const rows = mergeRepeatedStudents(sheetRows);
  const ids = rows.map((r) => str(r.values.studentNo).toUpperCase()).filter(Boolean);
  const aadhaars = rows.map((r) => digits(r.values.aadhaarNumber)).filter(Boolean);
  const students = await db.student.findMany({ where: { OR: [{ studentNo: { in: ids } }, { aadhaarNumber: { in: aadhaars } }] } });
  const byNo = new Map(students.filter((s) => s.studentNo).map((s) => [s.studentNo!.toUpperCase(), s]));
  const byAadhaar = new Map(students.filter((s) => s.aadhaarNumber).map((s) => [s.aadhaarNumber!, s]));
  const entered = await db.registration.findMany({ where: { tournamentId: tournament.id, studentId: { in: students.map((s) => s.id) } }, select: { studentId: true, ageGroup: true } });
  const enteredIn = (studentId: string) => entered.filter((e) => e.studentId === studentId).map((e) => e.ageGroup);
  const contested = new Map(tournament.ageGroups.map((g) => [key(g), g]));
  const seen = new Map<string, number>();

  const checked: CheckedRow[] = [];
  for (const { row, values } of rows) {
    const errors: string[] = [];
    const out: CheckedRow = { row, fullName: str(values.fullName), studentNo: str(values.studentNo), entries: [], errors, plan: null };
    checked.push(out);
    onProgress?.(checked.length);

    const no = str(values.studentNo).toUpperCase();
    const aadhaar = digits(values.aadhaarNumber);
    if (!no && !aadhaar) {
      errors.push("Give the Student ID or the Aadhaar number");
      continue;
    }
    if (!no && aadhaar.length !== 12) {
      errors.push("Aadhaar Number: must be 12 digits");
      continue;
    }
    const student = (no && byNo.get(no)) || (!no && byAadhaar.get(aadhaar)) || null;
    if (!student) {
      errors.push(no ? `No student with ID ${no} — add them on the Students page first` : "No student with this Aadhaar number — add them on the Students page first");
      continue;
    }
    out.fullName = student.fullName;
    out.studentNo = student.studentNo ?? "";
    if (values.fullName !== undefined && !sameName(str(values.fullName), student.fullName)) {
      errors.push(`Full Name "${str(values.fullName)}" doesn't match this student (${student.fullName})`);
    }
    if (student.status !== "APPROVED") errors.push("This student's application hasn't been approved yet");
    const first = seen.get(student.id);
    if (first !== undefined) errors.push(`Same student as row ${first}`);
    else seen.set(student.id, row);

    // Age groups: listed, All, or the student's own (the youngest group they're eligible for)
    const eligible = eligibleAgeGroups(student.dob, tournament.startDate, tournament.ageGroups);
    const raw = str(values.ageGroups);
    let groups: string[];
    if (!raw) groups = eligible.slice(0, 1);
    else if (key(raw) === "all") groups = eligible;
    else {
      groups = [];
      for (const token of raw.split(/[,;/|]+/).map((t) => t.trim()).filter(Boolean)) {
        const g = contested.get(key(token));
        if (!g) errors.push(`Age Groups: "${token}" isn't an age group in this tournament (${tournament.ageGroups.join(", ")})`);
        else if (!groups.includes(g)) groups.push(g);
      }
    }
    if (!groups.length && !errors.length) errors.push(`Not eligible for any age group in this tournament by birth year`);
    const already = groups.filter((g) => enteredIn(student.id).includes(g));
    if (already.length) errors.push(`Already entered in ${already.join(", ")}`);

    const weightKg = Number(str(values.weightKg).replace(/kg/i, "").trim());
    if (values.weightKg === undefined) errors.push("Weight (kg) is missing");
    else if (!Number.isFinite(weightKg) || weightKg < 10 || weightKg > 250) errors.push(`Weight (kg): "${str(values.weightKg)}" doesn't look like a weight`);

    const competeAs = parseCompeteAs(values.competeAs);
    if (competeAs === null) errors.push(`Compete In: use Boys or Girls`);
    if (errors.length) continue;

    const categories: Category[] = [];
    for (const ageGroup of groups) {
      try {
        categories.push(await resolveCategory(tournament, student, { ageGroup, weightKg, overrideAge: false, competeAs: competeAs ?? undefined }));
      } catch (err) {
        errors.push(err instanceof HttpError ? err.message.replace(/ Tick "override age check" to enter them anyway\./, "") : `Couldn't place the student in ${ageGroup}`);
      }
    }
    if (errors.length) continue;
    out.entries = categories.map((c) => `${c.ageGroup} · ${c.weightCategory}`);
    out.plan = { studentId: student.id, categories };
  }
  return checked;
}

router.get("/registrations/import/template", async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  const workbook = templateWorkbook("Entries", COLUMNS, [
    "Weight (kg) is required, plus the Student ID or the Aadhaar number to find the student. Replace the example row (row 2).",
    "Students must already be on the Students page (add many at once with Students → Import).",
    `Age groups in this tournament: ${tournament.ageGroups.join(", ")}. Cadets (15–17) may enter Cadet, Junior and Senior; juniors (18–20) Junior and Senior.`,
    "Each age group is a separate entry and is charged the entry fee. The weight class is worked out from the weight.",
    "An Entries export from another tournament can be uploaded as it is: a student's rows with the same weight become one student entered in each of those age groups.",
    `Up to ${MAX_ROWS} students per file. Save as .xlsx (or .csv).`,
  ]);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${tournament.slug.replace(/[^A-Za-z0-9_-]+/g, "_")}_entries_import_template.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

/**
 * The filled-in template as the raw request body (file name in X-Filename). ?dryRun=1 only checks the rows.
 * Otherwise the rows without problems are entered (no emails are sent).
 */
router.post("/registrations/import", express.raw({ type: () => true, limit: "5mb" }), async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  const terms = newEntryTerms(tournament);
  if (!terms) throw new HttpError(409, `${closedReason(tournament)} To change this, edit the registration dates.`);
  const file = req.body;
  if (!Buffer.isBuffer(file) || !file.length) throw new HttpError(400, "Choose a file to import.");
  const filename = decodeURIComponent(String(req.headers["x-filename"] ?? "entries.xlsx"));

  const { rows, missing, unknown } = await readImportSheet(file, filename, COLUMNS, { maxRows: MAX_ROWS, noun: "students" });
  // A sheet without either way of finding the student can't work at all
  const noIdentifier = rows.every((r) => r.values.studentNo === undefined && r.values.aadhaarNumber === undefined);
  const missingColumns = [...missing, ...(noIdentifier ? ["Student ID (or Aadhaar Number)"] : [])];
  const dryRun = req.query.dryRun === "1";

  // In the background: a big file takes longer than the proxy waits. Poll GET .../import/jobs/:jobId.
  const job = startJob(`entries:${tournament.id}`, req.admin!.adminId, async (job) => {
    job.total = rows.length;
    const checked = await checkRows(tournament, rows, prisma, (done) => { job.done = done; });
    const summary = (r: CheckedRow) => ({ row: r.row, fullName: r.fullName, studentNo: r.studentNo, entries: r.entries, errors: r.errors });
    const valid = checked.filter((r) => r.plan);
    if (dryRun) {
      return {
        rows: checked.map(summary), valid: valid.length, invalid: checked.length - valid.length,
        entries: valid.reduce((n, r) => n + r.plan!.categories.length, 0), entryFee: tournament.entryFee, additionalEntryFee: Math.min(tournament.additionalEntryFee, tournament.entryFee), missingColumns, unknownColumns: unknown,
      };
    }

    Object.assign(job, { phase: "SAVING", total: valid.length, done: 0 });
    let entries = 0;
    const failed = checked.filter((r) => !r.plan).map(summary);
    const studentIds: string[] = [];
    for (const r of valid) {
      const plan = r.plan!;
      try {
        const certificateNos = await Promise.all(plan.categories.map(() => newCertificateNo()));
        // One student at a time, all their entries together
        await prisma.$transaction(async (tx) => {
          for (const [i, category] of plan.categories.entries()) {
            await tx.registration.create({ data: { tournamentId: tournament.id, studentId: plan.studentId, ...category, ...terms, certificateNo: certificateNos[i]! } });
          }
          await repriceEntries(tx, tournament.id, plan.studentId);
        });
        entries += plan.categories.length;
        studentIds.push(plan.studentId);
      } catch (err) {
        const duplicate = err instanceof Error && "code" in err && (err as { code?: string }).code === "P2002";
        failed.push({ ...summary(r), errors: [duplicate ? "Already entered (added meanwhile)" : err instanceof HttpError ? err.message : "Couldn't save these entries"] });
      }
      job.done++;
    }
    failed.sort((a, b) => a.row - b.row);

    return { students: studentIds.length, entries, failed };
  });
  res.status(202).json({ jobId: job.id });
});

router.get("/registrations/import/jobs/:jobId", (req, res) => {
  res.json(getJob(param(req, "jobId"), req.admin!.adminId));
});

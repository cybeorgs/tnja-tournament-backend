// ─── Excel (.xlsx) downloads ─────────────────────────────────────────────────
import ExcelJS from "exceljs";
import type { Response } from "express";
import { competitionAge } from "./categories.js";

export interface Column<T> {
  header: string;
  /** Approximate width in characters */
  width?: number;
  value: (row: T) => string | number | Date | boolean | null | undefined;
  /** Excel number format, e.g. "dd-mm-yyyy" or "#,##0" */
  format?: string;
}

/** One worksheet of a download: its name, columns and rows. */
export interface Sheet<T> {
  name: string;
  columns: Column<T>[];
  rows: T[];
}

/** Helps TypeScript check each sheet's columns against its own rows. */
export const sheet = <T>(s: Sheet<T>) => s as Sheet<unknown>;

function addSheet<T>(workbook: ExcelJS.Workbook, { name, columns, rows }: Sheet<T>) {
  const ws = workbook.addWorksheet(name.slice(0, 31), { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, width: c.width ?? Math.max(12, c.header.length + 2), ...(c.format ? { style: { numFmt: c.format } } : {}) }));
  for (const row of rows) {
    ws.addRow(columns.map((c) => {
      const v = c.value(row);
      return typeof v === "boolean" ? (v ? "Yes" : "No") : v ?? "";
    }));
  }
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
  header.alignment = { vertical: "middle" };
  header.height = 20;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
}

/** Several sheets, each with a bold, frozen, filterable header row, sent as one download. */
export async function sendSheets(res: Response, filename: string, sheets: Sheet<unknown>[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  for (const s of sheets) addSheet(workbook, s);
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, "_");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${safe}"`);
  res.setHeader("Cache-Control", "no-store");
  await workbook.xlsx.write(res);
  res.end();
}

/** One sheet, sent as a download. */
export function sendWorkbook<T>(res: Response, filename: string, sheetName: string, columns: Column<T>[], rows: T[]) {
  return sendSheets(res, filename, [sheet({ name: sheetName, columns, rows })]);
}

/** Show only the last four digits of an Aadhaar number in exports. */
export const maskAadhaar = (n: string | null | undefined) => (n ? `XXXX XXXX ${n.slice(-4)}` : "");

export const DATE = "dd-mm-yyyy";
export const DATE_TIME = "dd-mm-yyyy hh:mm";

/** Age as the federation counts it: tournament (or current) year − birth year */
/** Age by birth year only (the year of `on` in India minus the birth year), as categories use. */
export const yearAge = (dob: Date, on = new Date()) => competitionAge(dob, on);

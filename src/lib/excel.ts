// ─── Excel (.xlsx) downloads ─────────────────────────────────────────────────
import ExcelJS from "exceljs";
import type { Response } from "express";

export interface Column<T> {
  header: string;
  /** Approximate width in characters */
  width?: number;
  value: (row: T) => string | number | Date | boolean | null | undefined;
  /** Excel number format, e.g. "dd-mm-yyyy" or "#,##0" */
  format?: string;
}

/** One sheet with a bold, frozen, filterable header row, sent as a download. */
export async function sendWorkbook<T>(res: Response, filename: string, sheetName: string, columns: Column<T>[], rows: T[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31), { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = columns.map((c) => ({ header: c.header, width: c.width ?? Math.max(12, c.header.length + 2), ...(c.format ? { style: { numFmt: c.format } } : {}) }));
  for (const row of rows) {
    sheet.addRow(columns.map((c) => {
      const v = c.value(row);
      return typeof v === "boolean" ? (v ? "Yes" : "No") : v ?? "";
    }));
  }
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
  header.alignment = { vertical: "middle" };
  header.height = 20;
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, "_");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${safe}"`);
  res.setHeader("Cache-Control", "no-store");
  await workbook.xlsx.write(res);
  res.end();
}

/** Show only the last four digits of an Aadhaar number in exports. */
export const maskAadhaar = (n: string | null | undefined) => (n ? `XXXX XXXX ${n.slice(-4)}` : "");

export const DATE = "dd-mm-yyyy";
export const DATE_TIME = "dd-mm-yyyy hh:mm";

/** Age as the federation counts it: tournament (or current) year − birth year */
export const yearAge = (dob: Date, on = new Date()) => on.getFullYear() - dob.getFullYear();

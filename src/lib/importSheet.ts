// ─── Reading an uploaded import sheet (.xlsx or .csv) ────────────────────────
// Shared by the student import and the tournament entry import.

import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { HttpError } from "../middleware/errors.js";

export type Cell = string | number | boolean | Date | null;

export interface ImportColumn<F extends string> {
  field: F;
  header: string;
  required: boolean;
  /** Other header spellings accepted (compared without case, spaces or punctuation) */
  aliases: string[];
  note: string;
  example: string | number;
}

/** Reserved test domains (RFC 2606 / 6761): never send email there. */
export const undeliverable = (email: string) => /(.(invalid|test|example|localhost)|@example.(com|net|org))$/i.test(email.trim());

/** Header comparison key: lower case, letters and digits only */
export const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export const str = (v: Cell | undefined) => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());
export const digits = (v: Cell | undefined) => str(typeof v === "number" ? v.toFixed(0) : v).replace(/\D/g, "");

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "object") {
    if ("result" in v) return cellValue(v.result as ExcelJS.CellValue); // formula
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return String(v.text); // hyperlink (e.g. an email address)
  }
  return String(v);
}

/** The first sheet as rows keyed by field, plus the required columns that weren't found and the headers that were ignored. */
export async function readImportSheet<F extends string>(file: Buffer, filename: string, columns: ImportColumn<F>[], { maxRows, noun }: { maxRows: number; noun: string }) {
  const headerToField = new Map<string, F>();
  for (const c of columns) for (const h of [c.header, c.field, ...c.aliases]) headerToField.set(key(h), c.field);

  const workbook = new ExcelJS.Workbook();
  const lower = filename.toLowerCase();
  let sheet: ExcelJS.Worksheet | undefined;
  try {
    if (lower.endsWith(".csv")) {
      sheet = await workbook.csv.read(Readable.from(file.toString("utf8").replace(/^﻿/, "")));
    } else {
      await workbook.xlsx.load(file as unknown as ArrayBuffer);
      sheet = workbook.worksheets[0];
    }
  } catch {
    throw new HttpError(400, lower.endsWith(".xls") ? "Old .xls files can't be read — open it in Excel and save as .xlsx." : "Couldn't read this file. Upload the .xlsx template (or a .csv).");
  }
  if (!sheet || sheet.rowCount < 2) throw new HttpError(400, "The sheet has no rows below the header.");

  const columnField = new Map<number, F>();
  const unknown: string[] = [];
  sheet.getRow(1).eachCell((cell, col) => {
    const header = String(cellValue(cell.value) ?? "").trim();
    if (!header) return;
    const field = headerToField.get(key(header));
    if (field) columnField.set(col, field);
    else unknown.push(header);
  });
  const found = new Set(columnField.values());
  const missing = columns.filter((c) => c.required && !found.has(c.field)).map((c) => c.header);
  if (!found.size) throw new HttpError(400, "None of the column headers were recognised. Use the template's header row.");

  const rows: { row: number; values: Partial<Record<F, Cell>> }[] = [];
  sheet.eachRow({ includeEmpty: false }, (r, rowNumber) => {
    if (rowNumber === 1) return;
    const values: Partial<Record<F, Cell>> = {};
    for (const [col, field] of columnField) {
      const v = cellValue(r.getCell(col).value);
      if (v !== null && String(v).trim() !== "") values[field] = v;
    }
    if (Object.keys(values).length) rows.push({ row: rowNumber, values });
  });
  if (!rows.length) throw new HttpError(400, "The sheet has no rows below the header.");
  if (rows.length > maxRows) throw new HttpError(400, `Import at most ${maxRows} ${noun} at a time (this file has ${rows.length}).`);
  return { rows, missing, unknown };
}

/** A template workbook: required headers in orange, one example row, and a "How to fill" sheet. */
export function templateWorkbook<F extends string>(sheetName: string, columns: ImportColumn<F>[], notes: string[]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName, { views: [{ state: "frozen", ySplit: 1 }] });
  // Text cells, so IDs, Aadhaar and phone numbers keep their digits
  sheet.columns = columns.map((c) => ({ header: c.header, width: Math.max(14, c.header.length + 4), style: { numFmt: "@" } }));
  sheet.addRow(columns.map((c) => c.example));
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.eachCell((cell, col) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: columns[col - 1]!.required ? "FFFF7400" : "FF0F172A" } };
  });
  sheet.getRow(2).font = { italic: true, color: { argb: "FF64748B" } };

  const help = workbook.addWorksheet("How to fill");
  help.columns = [{ header: "Column", width: 22 }, { header: "Required", width: 10 }, { header: "What to enter", width: 70 }];
  help.getRow(1).font = { bold: true };
  for (const c of columns) help.addRow([c.header, c.required ? "Yes" : "", c.note]);
  help.addRow([]);
  notes.forEach((n, i) => help.addRow([i === 0 ? "Notes" : "", "", n]));
  return workbook;
}

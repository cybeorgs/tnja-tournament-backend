// ─── Payments report: boys / girls and district-wise totals, plus the PDF download ──────────────
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { getSettings } from "./helpers.js";

/** The fields of an entry the report needs. */
export interface ReportEntry {
  gender: string;
  ageGroup: string;
  weightCategory: string;
  fee: number;
  paymentStatus: string;
  paymentMode: string | null;
  amountPaid: number;
  paidAt: Date | null;
  student: { studentNo: string | null; fullName: string; district: string; club: string; phone: string };
  tournament: { title: string };
}

export interface ReportGroup {
  entries: number;
  boys: number;
  girls: number;
  paidCount: number;
  collected: number;
  unpaidCount: number;
  due: number;
}

export interface DistrictRow extends ReportGroup {
  district: string;
}

export interface PaymentReport {
  totals: ReportGroup;
  districts: DistrictRow[];
}

export const NO_DISTRICT = "Not specified";
export const districtOf = (e: { student: { district: string } }) => e.student.district.trim() || NO_DISTRICT;
export const genderLabel = (g: string) => (g === "FEMALE" ? "Girls" : "Boys");
export const STATUS_LABEL: Record<string, string> = { PAID: "Paid", PENDING: "Unpaid", WAIVED: "Free" };
export const MODE_LABEL: Record<string, string> = { RAZORPAY: "Online", CASH: "Cash", UPI: "UPI", OTHER: "Other" };

const emptyGroup = (): ReportGroup => ({ entries: 0, boys: 0, girls: 0, paidCount: 0, collected: 0, unpaidCount: 0, due: 0 });

function add(g: ReportGroup, e: ReportEntry) {
  g.entries++;
  if (e.gender === "FEMALE") g.girls++;
  else g.boys++;
  if (e.paymentStatus === "PAID") {
    g.paidCount++;
    g.collected += e.amountPaid;
  } else if (e.paymentStatus === "PENDING") {
    g.unpaidCount++;
    g.due += e.fee;
  }
}

/** Sort districts by name, with entries that have no district last. */
export const byDistrict = (a: string, b: string) => (a === NO_DISTRICT ? 1 : b === NO_DISTRICT ? -1 : a.localeCompare(b));

/** Totals across all entries and per district (by the student's district). */
export function buildReport(entries: ReportEntry[]): PaymentReport {
  const totals = emptyGroup();
  const map = new Map<string, ReportGroup>();
  for (const e of entries) {
    add(totals, e);
    const d = districtOf(e);
    if (!map.has(d)) map.set(d, emptyGroup());
    add(map.get(d)!, e);
  }
  const districts = [...map.entries()].map(([district, g]) => ({ district, ...g })).sort((a, b) => byDistrict(a.district, b.district));
  return { totals, districts };
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.39, 0.45, 0.55);
const LINE = rgb(0.89, 0.91, 0.94);
const HEAD_BG = rgb(0.06, 0.09, 0.16);
const STRIPE = rgb(0.97, 0.98, 0.99);
const BRAND = rgb(1, 0.455, 0); // #FF7400

// The standard PDF fonts only cover Latin-1; drop anything else rather than crash.
const safe = (text: string) => text.replace(/[^\x20-\x7E\xA0-\xFF]/g, "").trim();
const money = (n: number) => `Rs. ${n.toLocaleString("en-IN")}`;
const dateTime = (d: Date) =>
  d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

function fit(text: string, font: PDFFont, size: number, maxWidth: number) {
  const full = safe(text);
  if (font.widthOfTextAtSize(full, size) <= maxWidth) return full;
  let t = full;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}...`;
}

interface Col {
  header: string;
  width: number;
  align?: "left" | "right";
}

export interface PdfOptions {
  /** e.g. the tournament name, or "All tournaments" */
  scope: string;
  /** e.g. "Paid entries only"; empty for all */
  filterNote: string;
}

/** A4 landscape report: summary, district-wise table, then every entry grouped by district. */
export async function paymentReportPdf(entries: ReportEntry[], opts: PdfOptions): Promise<Uint8Array> {
  const settings = await getSettings();
  return renderPaymentReportPdf(entries, opts, settings.orgName);
}

/** The PDF itself, given the organisation's name (kept apart from settings so it renders without the database). */
export async function renderPaymentReportPdf(entries: ReportEntry[], opts: PdfOptions, orgName: string): Promise<Uint8Array> {
  const settings = { orgName };
  const report = buildReport(entries);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Payments report - ${opts.scope}`);
  pdf.setAuthor(settings.orgName);
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const W = 842;
  const H = 595;
  const left = 36;
  const right = W - 36;
  const bottom = 40;
  let page!: PDFPage;
  let y = 0;

  const newPage = () => {
    page = pdf.addPage([W, H]);
    y = H - 36;
  };
  const text = (t: string, x: number, size: number, font = sans, color = INK) => page.drawText(safe(t), { x, y, size, font, color });

  // ── Header ──
  newPage();
  page.drawRectangle({ x: 0, y: H - 76, width: W, height: 76, color: BRAND });
  y = H - 34;
  text(fit(settings.orgName.toUpperCase(), bold, 15, right - left), left, 15, bold, rgb(1, 1, 1));
  y -= 20;
  text(fit(`Payments report  |  ${opts.scope}${opts.filterNote ? `  |  ${opts.filterNote}` : ""}`, sans, 10, right - left - 180), left, 10, sans, rgb(1, 0.93, 0.86));
  const gen = `Generated ${dateTime(new Date())}`;
  page.drawText(gen, { x: right - sans.widthOfTextAtSize(gen, 9), y, size: 9, font: sans, color: rgb(1, 0.93, 0.86) });

  // ── Summary boxes ──
  y = H - 100;
  const t = report.totals;
  const boxes: [string, string][] = [
    ["Entries", String(t.entries)],
    ["Boys", String(t.boys)],
    ["Girls", String(t.girls)],
    ["Paid entries", String(t.paidCount)],
    ["Collected", money(t.collected)],
    ["Unpaid entries", String(t.unpaidCount)],
    ["Due", money(t.due)],
  ];
  const gap = 8;
  const bw = (right - left - gap * (boxes.length - 1)) / boxes.length;
  boxes.forEach(([label, value], i) => {
    const x = left + i * (bw + gap);
    page.drawRectangle({ x, y: y - 44, width: bw, height: 48, borderColor: LINE, borderWidth: 1, color: rgb(1, 1, 1) });
    page.drawText(label.toUpperCase(), { x: x + 8, y: y - 12, size: 7.5, font: bold, color: MUTED });
    page.drawText(fit(value, bold, 14, bw - 16), { x: x + 8, y: y - 34, size: 14, font: bold, color: INK });
  });
  y -= 70;

  // ── Table helper ──
  const rowH = 17;
  const drawHeader = (cols: Col[]) => {
    page.drawRectangle({ x: left, y: y - 5, width: right - left, height: rowH, color: HEAD_BG });
    let x = left;
    for (const c of cols) {
      const tw = bold.widthOfTextAtSize(c.header, 8);
      page.drawText(c.header, { x: c.align === "right" ? x + c.width - 6 - tw : x + 6, y, size: 8, font: bold, color: rgb(1, 1, 1) });
      x += c.width;
    }
    y -= rowH;
  };
  const drawRow = (cols: Col[], cells: string[], opts: { bold?: boolean; stripe?: boolean } = {}) => {
    const font = opts.bold ? bold : sans;
    if (opts.stripe) page.drawRectangle({ x: left, y: y - 5, width: right - left, height: rowH, color: STRIPE });
    let x = left;
    cols.forEach((c, i) => {
      const v = fit(cells[i] ?? "", font, 8.5, c.width - 12);
      const tw = font.widthOfTextAtSize(v, 8.5);
      page.drawText(v, { x: c.align === "right" ? x + c.width - 6 - tw : x + 6, y, size: 8.5, font, color: INK });
      x += c.width;
    });
    page.drawLine({ start: { x: left, y: y - 5 }, end: { x: right, y: y - 5 }, thickness: 0.5, color: LINE });
    y -= rowH;
  };
  /** Start a new page (repeating the header) when the next row wouldn't fit. */
  const ensure = (cols: Col[] | null, needed = rowH) => {
    if (y - needed < bottom) {
      newPage();
      if (cols) drawHeader(cols);
    }
  };
  const section = (title: string) => {
    ensure(null, 50);
    page.drawText(safe(title), { x: left, y, size: 12, font: bold, color: INK });
    y -= 20;
  };

  // ── District-wise summary ──
  section("District-wise summary");
  const dCols: Col[] = [
    { header: "#", width: 30, align: "right" },
    { header: "District", width: 210 },
    { header: "Entries", width: 70, align: "right" },
    { header: "Boys", width: 65, align: "right" },
    { header: "Girls", width: 65, align: "right" },
    { header: "Paid", width: 65, align: "right" },
    { header: "Collected", width: 90, align: "right" },
    { header: "Unpaid", width: 65, align: "right" },
    { header: "Due", width: right - left - 660, align: "right" },
  ];
  drawHeader(dCols);
  const groupCells = (g: ReportGroup) => [String(g.entries), String(g.boys), String(g.girls), String(g.paidCount), money(g.collected), String(g.unpaidCount), money(g.due)];
  report.districts.forEach((d, i) => {
    ensure(dCols);
    drawRow(dCols, [String(i + 1), d.district, ...groupCells(d)], { stripe: i % 2 === 1 });
  });
  ensure(dCols);
  drawRow(dCols, ["", "Total", ...groupCells(t)], { bold: true });
  y -= 18;

  // ── Entries by district ──
  const eCols: Col[] = [
    { header: "#", width: 30, align: "right" },
    { header: "Player", width: 140 },
    { header: "Student ID", width: 85 },
    { header: "Club", width: 105 },
    { header: "Category", width: 165 },
    { header: "Status", width: 45 },
    { header: "Amount", width: 60, align: "right" },
    { header: "Paid on", width: right - left - 630 },
  ];
  const byD = new Map<string, ReportEntry[]>();
  for (const e of entries) {
    const d = districtOf(e);
    if (!byD.has(d)) byD.set(d, []);
    byD.get(d)!.push(e);
  }
  const multiTournament = new Set(entries.map((e) => e.tournament.title)).size > 1;
  for (const district of [...byD.keys()].sort(byDistrict)) {
    const list = byD.get(district)!.sort((a, b) => a.student.fullName.localeCompare(b.student.fullName));
    const boys = list.filter((e) => e.gender !== "FEMALE").length;
    section(`${district}  (${list.length} entries: ${boys} boys, ${list.length - boys} girls)`);
    drawHeader(eCols);
    list.forEach((e, i) => {
      ensure(eCols);
      const category = `${e.ageGroup} - ${genderLabel(e.gender)} - ${e.weightCategory}${multiTournament ? ` (${e.tournament.title})` : ""}`;
      const amount = e.paymentStatus === "PAID" ? e.amountPaid : e.fee;
      const paid = e.paidAt ? `${dateTime(e.paidAt)}${e.paymentMode ? ` - ${MODE_LABEL[e.paymentMode] ?? e.paymentMode}` : ""}` : "";
      drawRow(eCols, [String(i + 1), e.student.fullName, e.student.studentNo ?? "", e.student.club, category, STATUS_LABEL[e.paymentStatus] ?? e.paymentStatus, money(amount), paid], { stripe: i % 2 === 1 });
    });
    y -= 14;
  }

  // ── Page numbers ──
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, { x: right - sans.widthOfTextAtSize(label, 8), y: 20, size: 8, font: sans, color: MUTED });
  });
  return pdf.save();
}

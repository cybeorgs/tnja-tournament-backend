import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import type { Settings } from "@prisma/client";
import type { Placement } from "./categories.js";

export interface StudentCertificate {
  kind: "STUDENT";
  name: string;
  club: string;
  district: string;
  placement: Placement;
  category: string;
}

export interface RefereeCertificate {
  kind: "REFEREE";
  name: string;
  district: string;
  role: string;
}

export interface CertificateEvent {
  title: string;
  venue: string;
  city: string;
  startDate: Date;
  endDate: Date | null;
}

type CertificateData = (StudentCertificate | RefereeCertificate) & { certificateNo: string };

const INK = rgb(0.11, 0.13, 0.18);
const MUTED = rgb(0.38, 0.42, 0.5);
const BRAND = rgb(1, 0.455, 0); // #FF7400

const ACCENTS: Record<Placement | "REFEREE", RGB> = {
  FIRST: rgb(0.83, 0.65, 0.13),
  SECOND: rgb(0.55, 0.6, 0.66),
  THIRD: rgb(0.72, 0.42, 0.2),
  PARTICIPATION: BRAND,
  REFEREE: rgb(0.09, 0.4, 0.75),
};

const PLACEMENT_TEXT: Record<Placement, string> = {
  FIRST: "First Place - Gold Medal",
  SECOND: "Second Place - Silver Medal",
  THIRD: "Third Place - Bronze Medal",
  PARTICIPATION: "Participation",
};

const ROLE_TEXT: Record<string, string> = {
  REFEREE: "Referee",
  JUDGE: "Judge",
  TIMEKEEPER: "Timekeeper",
  SCOREKEEPER: "Scorekeeper",
  TECHNICAL_OFFICIAL: "Technical Official",
};

// The standard PDF fonts only cover Latin-1; drop anything else rather than crash.
const safe = (text: string) => text.replace(/[^\x20-\x7E\xA0-\xFF]/g, "").trim();

function formatDates(start: Date, end: Date | null): string {
  const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
  if (!end || end.toDateString() === start.toDateString()) return fmt(start);
  return `${fmt(start)} to ${fmt(end)}`;
}

function centered(page: PDFPage, text: string, y: number, font: PDFFont, size: number, color: RGB) {
  const clean = safe(text);
  const width = font.widthOfTextAtSize(clean, size);
  page.drawText(clean, { x: (page.getWidth() - width) / 2, y, size, font, color });
}

/** Largest size <= `max` at which `text` fits in `maxWidth`. */
function fitSize(text: string, font: PDFFont, max: number, maxWidth: number): number {
  let size = max;
  while (size > 12 && font.widthOfTextAtSize(safe(text), size) > maxWidth) size -= 1;
  return size;
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of safe(text).split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function drawCertificate(pdf: PDFDocument, data: CertificateData, event: CertificateEvent, settings: Settings, verifyUrl: string) {
  const page = pdf.addPage([842, 595]); // A4 landscape
  const { width, height } = page.getSize();
  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const serifBold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const serifItalic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const sansBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const accent = data.kind === "STUDENT" ? ACCENTS[data.placement] : ACCENTS.REFEREE;

  // Background and double frame
  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0.99, 0.98, 0.96) });
  page.drawRectangle({ x: 18, y: 18, width: width - 36, height: height - 36, borderColor: accent, borderWidth: 3 });
  page.drawRectangle({ x: 28, y: 28, width: width - 56, height: height - 56, borderColor: INK, borderWidth: 0.6 });
  // Corner accents
  for (const [x, y] of [[28, 28], [width - 28, 28], [28, height - 28], [width - 28, height - 28]] as const) {
    page.drawCircle({ x, y, size: 7, color: accent });
  }

  let top = height - 60;
  if (settings.logo && settings.logoMime) {
    try {
      const image = settings.logoMime.includes("png") ? await pdf.embedPng(settings.logo) : await pdf.embedJpg(settings.logo);
      const scaled = image.scaleToFit(70, 70);
      page.drawImage(image, { x: (width - scaled.width) / 2, y: top - scaled.height, width: scaled.width, height: scaled.height });
      top -= scaled.height + 14;
    } catch (err) {
      console.error("Could not embed certificate logo:", err);
    }
  }

  centered(page, settings.orgName.toUpperCase(), top - 14, sansBold, fitSize(settings.orgName.toUpperCase(), sansBold, 18, width - 160), INK);
  const sub = [settings.regNo.trim() && `Reg. No. ${settings.regNo.trim()}`, settings.tagline].filter(Boolean).join("  |  ");
  if (sub) centered(page, sub, top - 32, sans, 10, MUTED);

  const title = data.kind === "REFEREE"
    ? "CERTIFICATE OF APPRECIATION"
    : data.placement === "PARTICIPATION" ? "CERTIFICATE OF PARTICIPATION" : "CERTIFICATE OF ACHIEVEMENT";
  centered(page, title, top - 82, serifBold, 30, accent);
  page.drawLine({ start: { x: width / 2 - 120, y: top - 98 }, end: { x: width / 2 + 120, y: top - 98 }, thickness: 1, color: accent });

  centered(page, "This is to certify that", top - 134, serifItalic, 15, MUTED);
  const nameSize = fitSize(data.name, serifBold, 36, width - 200);
  centered(page, data.name, top - 180, serifBold, nameSize, INK);

  const from = [data.kind === "STUDENT" ? data.club : "", data.district].filter((s) => s && s.trim()).join(", ");
  if (from) centered(page, `of ${from}`, top - 204, serif, 13, MUTED);

  const where = [event.venue, event.city].filter(Boolean).join(", ");
  const when = formatDates(event.startDate, event.endDate);
  const sentence = data.kind === "STUDENT"
    ? data.placement === "PARTICIPATION"
      ? `has participated in the ${data.category} category of the ${event.title}, held at ${where} on ${when}.`
      : `has secured ${PLACEMENT_TEXT[data.placement]} in the ${data.category} category of the ${event.title}, held at ${where} on ${when}.`
    : `has officiated as ${ROLE_TEXT[data.role] || data.role} at the ${event.title}, held at ${where} on ${when}, and is thanked for the valuable service rendered.`;

  let y = top - 244;
  for (const line of wrap(sentence, serif, 15, width - 220)) {
    centered(page, line, y, serif, 15, INK);
    y -= 22;
  }

  if (data.kind === "STUDENT" && data.placement !== "PARTICIPATION") {
    const badge = PLACEMENT_TEXT[data.placement].toUpperCase();
    const bw = sansBold.widthOfTextAtSize(badge, 11) + 28;
    page.drawRectangle({ x: (width - bw) / 2, y: y - 20, width: bw, height: 24, color: accent });
    centered(page, badge, y - 12, sansBold, 11, rgb(1, 1, 1));
  }

  // Signatures
  const signY = 92;
  const signatories = [
    { name: settings.signatory1Name, title: settings.signatory1Title, x: 190 },
    { name: settings.signatory2Name, title: settings.signatory2Title, x: width - 190 },
  ];
  for (const s of signatories) {
    if (!s.name && !s.title) continue;
    page.drawLine({ start: { x: s.x - 90, y: signY }, end: { x: s.x + 90, y: signY }, thickness: 0.8, color: INK });
    const nameText = safe(s.name);
    const titleText = safe(s.title);
    if (nameText) page.drawText(nameText, { x: s.x - sansBold.widthOfTextAtSize(nameText, 11) / 2, y: signY - 16, size: 11, font: sansBold, color: INK });
    if (titleText) page.drawText(titleText, { x: s.x - sans.widthOfTextAtSize(titleText, 10) / 2, y: signY - (nameText ? 30 : 16), size: 10, font: sans, color: MUTED });
  }

  centered(page, `Certificate No: ${data.certificateNo}`, 56, sansBold, 9, INK);
  if (verifyUrl) centered(page, `Verify at ${verifyUrl}`, 44, sans, 8, MUTED);
}

/** Render one or more certificates into a single PDF (one per page). */
export async function renderCertificates(
  items: CertificateData[],
  event: CertificateEvent,
  settings: Settings,
  verifyBaseUrl: string,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${safe(event.title)} - Certificates`);
  pdf.setAuthor(safe(settings.orgName));
  for (const item of items) {
    const verifyUrl = verifyBaseUrl ? `${verifyBaseUrl.replace(/\/$/, "")}/verify/${item.certificateNo}` : "";
    await drawCertificate(pdf, item, event, settings, verifyUrl);
  }
  return pdf.save();
}

export const categoryLabel = (ageGroup: string, gender: string, weightCategory: string) =>
  `${ageGroup} ${gender === "FEMALE" ? "Girls" : "Boys"} ${weightCategory}`;

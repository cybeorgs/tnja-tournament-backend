// ─── Hall tickets ────────────────────────────────────────────────────────────
// One A4 page per student per tournament, listing every event (age group) they entered. It is
// issued once all of those entries are paid, or straight away for a free tournament, and emailed
// as a PDF. It can be downloaded again any time from the student's account (and by an admin).
// When the student enters another event later and pays for it, an updated hall ticket is emailed.
//
// The page has the logo, short name, organisation name and registration number (Settings.regNo,
// "329-2017"), the passport photo, the registration details, the additional details (weight, coach,
// manager, district president and secretary) and blank space to be filled in by hand at the venue:
// the weigh-in, remarks and signatures.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import type { Registration, Student, Tournament } from "@prisma/client";
import prisma from "../db.js";
import { getSettings } from "./helpers.js";
import { sendHallTicket, type Attachment } from "./mailer.js";

const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.39, 0.45, 0.55);
const LINE = rgb(0.8, 0.83, 0.87);
const SOFT = rgb(1, 0.96, 0.92);
const BRAND = rgb(1, 0.455, 0); // #FF7400
const WHITE = rgb(1, 1, 1);

// The standard PDF fonts only cover Latin-1; drop anything else rather than crash.
const safe = (text: string) => text.replace(/[^\x20-\x7E\xA0-\xFF]/g, "").trim();
const IST = "Asia/Kolkata";
const day = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: IST });
const dateTime = (d: Date) => d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: IST });
const GENDER: Record<string, string> = { MALE: "Male", FEMALE: "Female", OTHER: "Other" };
const PAYMENT: Record<string, string> = { PAID: "Paid", WAIVED: "Free", PENDING: "Unpaid" };

function fit(text: string, font: PDFFont, size: number, maxWidth: number) {
  const full = safe(text);
  if (font.widthOfTextAtSize(full, size) <= maxWidth) return full;
  let t = full;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}...`;
}

type Entry = Pick<Registration, "id" | "ageGroup" | "gender" | "weightCategory" | "weightKg" | "fee" | "paymentStatus" | "amountPaid" | "paidAt" | "paymentMode" | "hallTicketSentAt" | "createdAt">;
export type HallTicketData = { tournament: Tournament; student: Student; entries: Entry[]; photo: { mime: string; data: Uint8Array } | null };

/** Stable number printed on the ticket: from the student's first entry in the tournament. */
export const hallTicketNo = (entries: Entry[]) => `HT-${entries[0]!.id.replace(/-/g, "").slice(0, 10).toUpperCase()}`;

/** Ready once the student has entries and none of them is waiting for payment. */
export const hallTicketReady = (entries: Pick<Entry, "paymentStatus">[]) => entries.length > 0 && entries.every((e) => e.paymentStatus !== "PENDING");

/** Everything printed on the ticket, or null when the student has no entry in the tournament. */
export async function loadHallTicket(tournamentId: string, studentId: string): Promise<HallTicketData | null> {
  const [tournament, student, entries, photo] = await Promise.all([
    prisma.tournament.findUnique({ where: { id: tournamentId } }),
    prisma.student.findUnique({ where: { id: studentId } }),
    prisma.registration.findMany({ where: { tournamentId, studentId }, orderBy: { createdAt: "asc" } }),
    prisma.studentDocument.findUnique({ where: { studentId_kind: { studentId, kind: "PHOTO" } }, select: { mime: true, data: true } }),
  ]);
  if (!tournament || !student || !entries.length) return null;
  return { tournament, student, entries, photo };
}

export async function hallTicketPdf({ tournament: t, student: s, entries, photo }: HallTicketData): Promise<Attachment> {
  const settings = await getSettings();
  const ticketNo = hallTicketNo(entries);
  const regNo = settings.regNo.trim();
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Hall ticket - ${s.fullName} - ${t.title}`);
  pdf.setAuthor(`${settings.orgShortName}${regNo ? ` (Reg. No. ${regNo})` : ""}`);
  const page = pdf.addPage([595.28, 841.89]); // A4 portrait
  const { width, height } = page.getSize();
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const left = 36;
  const right = width - 36;
  const inner = right - left;

  const text = (p: PDFPage, value: string, x: number, y: number, size: number, font = sans, color = INK) => p.drawText(safe(value), { x, y, size, font, color });
  const embed = async (mime: string, data: Uint8Array): Promise<PDFImage | null> => {
    try {
      return mime.includes("png") ? await pdf.embedPng(data) : await pdf.embedJpg(data);
    } catch (err) {
      console.error("[hall ticket] Could not embed an image:", err);
      return null;
    }
  };

  // Page border, for a clean printed edge
  page.drawRectangle({ x: 18, y: 18, width: width - 36, height: height - 36, borderColor: BRAND, borderWidth: 1.2 });

  // ── Header: logo, TNJA, organisation, registration number, HALL TICKET ──
  const headerTop = height - 30;
  const headerH = 92;
  page.drawRectangle({ x: left, y: headerTop - headerH, width: inner, height: headerH, color: BRAND });
  let textX = left + 16;
  const logo = settings.logo && settings.logoMime ? await embed(settings.logoMime, settings.logo) : null;
  if (logo) {
    const cx = left + 52;
    const cy = headerTop - headerH / 2;
    const radius = 36;
    const scale = (radius * 0.97) / (Math.hypot(logo.width, logo.height) / 2);
    page.drawCircle({ x: cx, y: cy, size: radius + 3, color: rgb(1, 0.82, 0.66) });
    page.drawCircle({ x: cx, y: cy, size: radius, color: WHITE });
    page.drawImage(logo, { x: cx - (logo.width * scale) / 2, y: cy - (logo.height * scale) / 2, width: logo.width * scale, height: logo.height * scale });
    textX = left + 102;
  }
  const badgeW = 128;
  const textW = right - badgeW - 14 - textX;
  text(page, fit(settings.orgShortName.toUpperCase(), bold, 26, textW), textX, headerTop - 34, 26, bold, WHITE);
  text(page, fit(settings.orgName, bold, 11, textW), textX, headerTop - 52, 11, bold, WHITE);
  const sub = [regNo && `Reg. No. ${regNo}`, settings.tagline].filter(Boolean).join("  |  ");
  if (sub) text(page, fit(sub, sans, 8.5, textW), textX, headerTop - 67, 8.5, sans, rgb(1, 0.93, 0.86));
  // "HALL TICKET" badge
  const badgeX = right - badgeW - 14;
  page.drawRectangle({ x: badgeX, y: headerTop - 64, width: badgeW, height: 36, color: WHITE });
  const title = "HALL TICKET";
  text(page, title, badgeX + (badgeW - bold.widthOfTextAtSize(title, 15)) / 2, headerTop - 51, 15, bold, BRAND);
  const no = fit(ticketNo, bold, 8, badgeW);
  text(page, no, badgeX + (badgeW - bold.widthOfTextAtSize(no, 8)) / 2, headerTop - 78, 8, bold, WHITE);

  // ── Tournament ──
  let y = headerTop - headerH - 10;
  page.drawRectangle({ x: left, y: y - 46, width: inner, height: 46, color: SOFT });
  text(page, fit(t.title, bold, 13, inner - 24), left + 12, y - 18, 13, bold);
  const days = t.endDate && day(t.endDate) !== day(t.startDate) ? `${day(t.startDate)} - ${day(t.endDate)}` : day(t.startDate);
  text(page, fit(`${[t.venue, t.city].filter(Boolean).join(", ")}   |   ${days}   |   Starts ${dateTime(t.startDate)}`, sans, 9, inner - 24), left + 12, y - 35, 9, sans, MUTED);
  y -= 62;

  // ── Photo (passport size: 35 x 45 mm) and player details ──
  const photoW = 99;
  const photoH = 127;
  const photoX = right - photoW;
  const photoTop = y;
  const image = photo ? await embed(photo.mime, photo.data) : null;
  if (image) {
    // Uploads are cropped to 35:45 in the browser, so this fills the box; anything else is fitted inside it.
    const scale = Math.min(photoW / image.width, photoH / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    page.drawImage(image, { x: photoX + (photoW - w) / 2, y: photoTop - photoH + (photoH - h) / 2, width: w, height: h });
  } else {
    const hint = ["Affix recent", "passport-size", "photograph", "(blue / white", "background)"];
    hint.forEach((line, i) => text(page, line, photoX + (photoW - sans.widthOfTextAtSize(line, 8)) / 2, photoTop - 42 - i * 11, 8, sans, MUTED));
  }
  page.drawRectangle({ x: photoX, y: photoTop - photoH, width: photoW, height: photoH, borderColor: INK, borderWidth: 0.8 });

  const detailsW = photoX - left - 16;
  const colW = (detailsW - 12) / 2;
  const field = (label: string, value: string, x: number, yy: number, w: number) => {
    text(page, label.toUpperCase(), x, yy, 7, bold, MUTED);
    text(page, fit(value || "-", bold, 10, w), x, yy - 13, 10, bold);
    page.drawLine({ start: { x, y: yy - 17 }, end: { x: x + w, y: yy - 17 }, thickness: 0.4, color: LINE });
  };
  const details: [string, string][] = [
    ["Student ID", s.studentNo ?? "-"], ["Date of birth", day(s.dob)],
    ["Gender", GENDER[s.gender] ?? s.gender], ["Blood group", s.bloodGroup],
    ["Father's name", s.fatherName], ["Mobile", s.phone],
    ["Parent's mobile", s.parentPhone], ["Emergency contact", s.emergencyPhone],
    ["District", s.district], ["Club / academy", s.club],
  ];
  text(page, "PLAYER", left, y, 9, bold, BRAND);
  text(page, fit(s.fullName.toUpperCase(), bold, 15, detailsW), left, y - 18, 15, bold);
  let dy = y - 40;
  for (let i = 0; i < details.length; i += 2) {
    field(details[i]![0], details[i]![1], left, dy, colW);
    if (details[i + 1]) field(details[i + 1]![0], details[i + 1]![1], left + colW + 12, dy, colW);
    dy -= 24;
  }
  y = Math.min(dy + 4, photoTop - photoH) - 16;

  // ── Events entered ──
  const section = (label: string) => {
    text(page, label.toUpperCase(), left, y, 9, bold, BRAND);
    page.drawLine({ start: { x: left, y: y - 5 }, end: { x: right, y: y - 5 }, thickness: 0.8, color: BRAND });
    y -= 20;
  };
  section("Events entered");
  const cols = [
    { label: "#", w: 22 }, { label: "Age group", w: 150 }, { label: "Section", w: 62 }, { label: "Weight class", w: 88 },
    { label: "Weight entered", w: 84 }, { label: "Entry fee", w: inner - 22 - 150 - 62 - 88 - 84 },
  ];
  const row = (cells: string[], font: PDFFont, color = INK, shade = false) => {
    if (shade) page.drawRectangle({ x: left, y: y - 5, width: inner, height: 17, color: rgb(0.96, 0.97, 0.98) });
    let x = left + 4;
    cells.forEach((c, i) => {
      text(page, fit(c, font, 9, cols[i]!.w - 8), x, y, 9, font, color);
      x += cols[i]!.w;
    });
    y -= 17;
  };
  row(cols.map((c) => c.label), bold, MUTED, true);
  const shown = entries.slice(0, 8);
  shown.forEach((e, i) => {
    const fee = e.paymentStatus === "WAIVED" || !e.fee ? "Free" : `Rs. ${(e.paymentStatus === "PAID" ? e.amountPaid || e.fee : e.fee).toLocaleString("en-IN")} ${PAYMENT[e.paymentStatus] ?? ""}`;
    row([String(i + 1), e.ageGroup, e.gender === "FEMALE" ? "Girls" : "Boys", e.weightCategory, `${e.weightKg} kg`, fee], sans);
  });
  if (entries.length > shown.length) row(["", `+ ${entries.length - shown.length} more (see your account)`, "", "", "", ""], sans, MUTED);
  y -= 8;

  // ── Additional details (blank lines where nothing was given, to fill in by hand) ──
  section("Additional details");
  const extra: [string, string][] = [
    ["Weight (kg)", s.weightKg ? `${s.weightKg} kg` : ""], ["Coach name", s.coachName],
    ["Manager name", s.managerName], ["District president", s.districtPresident],
    ["District secretary", s.districtSecretary], ["Belt", s.belt],
  ];
  const halfW = (inner - 16) / 2;
  for (let i = 0; i < extra.length; i += 2) {
    const pair = extra.slice(i, i + 2);
    for (const [j, [label, value]] of pair.entries()) {
      const x = left + j * (halfW + 16);
      text(page, `${label}:`, x, y, 9, bold, MUTED);
      const lx = x + bold.widthOfTextAtSize(`${label}:`, 9) + 6;
      if (value) text(page, fit(value, sans, 10, x + halfW - lx), lx, y, 10, sans);
      page.drawLine({ start: { x: lx, y: y - 3 }, end: { x: x + halfW, y: y - 3 }, thickness: 0.5, color: LINE });
    }
    y -= 21;
  }
  y -= 6;

  // ── For office use at the venue ──
  section("For office use (fill in at the venue)");
  const blank = (label: string, x: number, w: number) => {
    text(page, `${label}:`, x, y, 9, bold, MUTED);
    const lx = x + bold.widthOfTextAtSize(`${label}:`, 9) + 6;
    page.drawLine({ start: { x: lx, y: y - 3 }, end: { x: x + w, y: y - 3 }, thickness: 0.6, color: MUTED });
  };
  blank("Weight at weigh-in (kg)", left, halfW);
  blank("Weigh-in date & time", left + halfW + 16, halfW);
  y -= 22;
  blank("Weight class confirmed", left, halfW);
  blank("Chest / bib no.", left + halfW + 16, halfW);
  y -= 22;
  blank("Remarks", left, inner);
  y -= 20;
  page.drawLine({ start: { x: left, y: y - 3 }, end: { x: right, y: y - 3 }, thickness: 0.6, color: MUTED });
  y -= 22;

  // ── Signatures ──
  const signers = ["Player", "Coach / Manager", "District Secretary (seal)", "Weigh-in Official"];
  const boxW = (inner - 12 * (signers.length - 1)) / signers.length;
  const boxH = 46;
  signers.forEach((label, i) => {
    const x = left + i * (boxW + 12);
    page.drawRectangle({ x, y: y - boxH, width: boxW, height: boxH, borderColor: LINE, borderWidth: 0.8 });
    text(page, fit(label, bold, 8, boxW - 8), x + (boxW - bold.widthOfTextAtSize(fit(label, bold, 8, boxW - 8), 8)) / 2, y - boxH + 7, 8, bold, MUTED);
  });
  y -= boxH + 18;

  // ── Instructions ──
  section("Instructions");
  const notes = [
    "Bring this hall ticket (printed on A4) and your Aadhaar card to the venue. Entry without it may be refused.",
    "Report at the venue for the weigh-in at the time given by the organisers. Your weight must be within your weight class.",
    "The photograph on this ticket must match the player. Tampered or altered hall tickets are invalid.",
    "Follow the rules of the tournament and the instructions of the officials.",
  ];
  for (const n of notes) {
    if (y < 72) break;
    text(page, "-", left + 2, y, 8.5, bold, BRAND);
    text(page, fit(n, sans, 8.5, inner - 14), left + 12, y, 8.5, sans);
    y -= 13;
  }

  // ── Footer ──
  page.drawLine({ start: { x: left, y: 50 }, end: { x: right, y: 50 }, thickness: 0.6, color: LINE });
  const paid = entries.filter((e) => e.paymentStatus === "PAID" && e.paidAt).map((e) => e.paidAt!.getTime());
  const footerLeft = `Hall ticket ${ticketNo}  |  Issued ${dateTime(new Date())} IST${paid.length ? `  |  Paid ${dateTime(new Date(Math.max(...paid)))}` : ""}`;
  text(page, fit(footerLeft, sans, 7.5, inner * 0.68), left, 36, 7.5, sans, MUTED);
  const footerRight = fit(`${settings.orgShortName}${regNo ? `  |  Reg. No. ${regNo}` : ""}`, bold, 8, inner * 0.3);
  text(page, footerRight, right - bold.widthOfTextAtSize(footerRight, 8), 36, 8, bold, BRAND);

  const bytes = await pdf.save();
  const slug = (v: string) => v.replace(/[^A-Za-z0-9_-]+/g, "_");
  return { filename: `Hall_ticket_${slug(s.studentNo ?? s.fullName)}_${slug(t.slug)}.pdf`, content: Buffer.from(bytes), contentType: "application/pdf" };
}

// ─── Issuing ─────────────────────────────────────────────────────────────────

const sending = new Set<string>();

/**
 * Email the hall ticket when the student's entries in the tournament are all paid (or free) and at
 * least one of them hasn't been on an emailed hall ticket yet. Safe to call after any change.
 */
export async function sendHallTicketIfReady(tournamentId: string, studentId: string) {
  const key = `${tournamentId}:${studentId}`;
  if (sending.has(key)) return;
  sending.add(key);
  try {
    const data = await loadHallTicket(tournamentId, studentId);
    if (!data || !data.student.email || !hallTicketReady(data.entries)) return;
    if (data.entries.every((e) => e.hallTicketSentAt)) return;
    const pdf = await hallTicketPdf(data);
    const delivery = await sendHallTicket(data.student.email, {
      fullName: data.student.fullName, studentNo: data.student.studentNo ?? "", tournament: data.tournament.title, ticketNo: hallTicketNo(data.entries), pdf,
    });
    await prisma.emailLog.create({
      data: { tournamentId, studentId, kind: "HALL_TICKET", trigger: "AUTO", toEmail: delivery.to, subject: delivery.subject, status: delivery.status, error: delivery.error },
    });
    // A failed send is tried again the next time something changes (or the student downloads it).
    if (delivery.status !== "FAILED") {
      await prisma.registration.updateMany({ where: { id: { in: data.entries.map((e) => e.id) } }, data: { hallTicketSentAt: new Date() } });
    }
  } finally {
    sending.delete(key);
  }
}

/** Fire-and-forget for request handlers: the entry or payment is saved whether or not the email goes. */
export function sendHallTicketLater(tournamentId: string, studentId: string) {
  sendHallTicketIfReady(tournamentId, studentId).catch((err) => console.error("[hall ticket] failed:", err));
}

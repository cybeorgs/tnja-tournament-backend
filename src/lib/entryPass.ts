// ─── Tournament Entry Passes ─────────────────────────────────────────────────
// One A4 page per EVENT: a player entering three age groups gets three passes. A pass is issued as
// soon as that event is paid (straight away when it is free) and emailed as a PDF; when several events
// become ready together, one email carries all their passes. Passes can be downloaded again any time
// from the student's account (and by an admin).
//
// Each page has the logo, short name, organisation name and registration number (Settings.regNo,
// "329-2017"), the passport photo, the player's registration details, the event, the additional
// details (weight, coach, manager, district president and secretary) and blank space to be filled in
// by hand at the venue: the weigh-in, remarks and signatures.
//
// Registration.hallTicketSentAt records that the event's pass was emailed (the column keeps its old name).
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import type { Registration, Student, Tournament } from "@prisma/client";
import prisma from "../db.js";
import { getSettings } from "./helpers.js";
import { sendEntryPasses, type Attachment } from "./mailer.js";
import type { EmailCause } from "./registrationEmails.js";

const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.39, 0.45, 0.55);
const LINE = rgb(0.8, 0.83, 0.87);
const SOFT = rgb(1, 0.96, 0.92);
const BRAND = rgb(1, 0.455, 0); // #FF7400
const WHITE = rgb(1, 1, 1);

export const ENTRY_PASS = "Tournament Entry Pass";

// The standard PDF fonts only cover Latin-1; drop anything else rather than crash.
const safe = (text: string) => text.replace(/[^\x20-\x7E\xA0-\xFF]/g, "").trim();
const IST = "Asia/Kolkata";
const day = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: IST });
const dateTime = (d: Date) => d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: IST });
const GENDER: Record<string, string> = { MALE: "Male", FEMALE: "Female", OTHER: "Other" };

function fit(text: string, font: PDFFont, size: number, maxWidth: number) {
  const full = safe(text);
  if (font.widthOfTextAtSize(full, size) <= maxWidth) return full;
  let t = full;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}...`;
}

type Entry = Pick<Registration, "id" | "ageGroup" | "gender" | "weightCategory" | "weightKg" | "fee" | "paymentStatus" | "amountPaid" | "paidAt" | "paymentMode" | "hallTicketSentAt" | "createdAt">;
export type EntryPassData = { tournament: Tournament; student: Student; entry: Entry; photo: { mime: string; data: Uint8Array } | null };

/** Stable number printed on the pass, from the event's entry. */
export const entryPassNo = (entry: Pick<Entry, "id">) => `TEP-${entry.id.replace(/-/g, "").slice(0, 10).toUpperCase()}`;

/** An event's pass is issued once it is paid, or straight away when it is free. */
export const entryPassReady = (entry: Pick<Entry, "paymentStatus">) => entry.paymentStatus !== "PENDING";

const loadPhoto = (studentId: string) =>
  prisma.studentDocument.findUnique({ where: { studentId_kind: { studentId, kind: "PHOTO" } }, select: { mime: true, data: true } });

/** Everything printed on one event's pass, or null when the entry doesn't exist. */
export async function loadEntryPass(registrationId: string): Promise<EntryPassData | null> {
  const entry = await prisma.registration.findUnique({ where: { id: registrationId }, include: { tournament: true, student: true } });
  if (!entry) return null;
  const { tournament, student, ...rest } = entry;
  return { tournament, student, entry: rest, photo: await loadPhoto(student.id) };
}

export async function entryPassPdf({ tournament: t, student: s, entry: e, photo }: EntryPassData): Promise<Attachment> {
  const settings = await getSettings();
  const passNo = entryPassNo(e);
  const regNo = settings.regNo.trim();
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${ENTRY_PASS} - ${s.fullName} - ${e.ageGroup} ${e.weightCategory} - ${t.title}`);
  pdf.setAuthor(`${settings.orgShortName}${regNo ? ` (Reg. No. ${regNo})` : ""}`);
  const page = pdf.addPage([595.28, 841.89]); // A4 portrait
  const { width, height } = page.getSize();
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const left = 36;
  const right = width - 36;
  const inner = right - left;

  const text = (p: PDFPage, value: string, x: number, y: number, size: number, font = sans, color = INK) => p.drawText(safe(value), { x, y, size, font, color });
  const centred = (value: string, cx: number, y: number, size: number, font: PDFFont, color = INK) => text(page, value, cx - font.widthOfTextAtSize(safe(value), size) / 2, y, size, font, color);
  const embed = async (mime: string, data: Uint8Array): Promise<PDFImage | null> => {
    try {
      return mime.includes("png") ? await pdf.embedPng(data) : await pdf.embedJpg(data);
    } catch (err) {
      console.error("[entry pass] Could not embed an image:", err);
      return null;
    }
  };

  // Page border, for a clean printed edge
  page.drawRectangle({ x: 18, y: 18, width: width - 36, height: height - 36, borderColor: BRAND, borderWidth: 1.2 });

  // ── Header: logo, TNJA, organisation, registration number, TOURNAMENT ENTRY PASS ──
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
  const badgeW = 150;
  const textW = right - badgeW - 14 - textX;
  text(page, fit(settings.orgShortName.toUpperCase(), bold, 26, textW), textX, headerTop - 34, 26, bold, WHITE);
  text(page, fit(settings.orgName, bold, 11, textW), textX, headerTop - 52, 11, bold, WHITE);
  const sub = [regNo && `Reg. No. ${regNo}`, settings.tagline].filter(Boolean).join("  |  ");
  if (sub) text(page, fit(sub, sans, 8.5, textW), textX, headerTop - 67, 8.5, sans, rgb(1, 0.93, 0.86));
  // Badge: TOURNAMENT / ENTRY PASS, with the pass number underneath
  const badgeX = right - badgeW - 14;
  const badgeCx = badgeX + badgeW / 2;
  page.drawRectangle({ x: badgeX, y: headerTop - 66, width: badgeW, height: 46, color: WHITE });
  centred("TOURNAMENT", badgeCx, headerTop - 35, 9, bold, BRAND);
  centred("ENTRY PASS", badgeCx, headerTop - 56, 17, bold, BRAND);
  centred(fit(passNo, bold, 8, badgeW), badgeCx, headerTop - 80, 8, bold, WHITE);

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
    ["Affix recent", "passport-size", "photograph", "(blue / white", "background)"].forEach((line, i) => centred(line, photoX + photoW / 2, photoTop - 42 - i * 11, 8, sans, MUTED));
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
    ["Parent / emergency", s.parentPhone || s.emergencyPhone], ["District", s.district],
    ["Club / academy", s.club], ["Belt", s.belt],
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

  // ── The event this pass is for ──
  const section = (label: string) => {
    text(page, label.toUpperCase(), left, y, 9, bold, BRAND);
    page.drawLine({ start: { x: left, y: y - 5 }, end: { x: right, y: y - 5 }, thickness: 0.8, color: BRAND });
    y -= 20;
  };
  section("Event");
  const fee = e.paymentStatus === "WAIVED" || !e.fee ? "Free" : `Rs. ${(e.paymentStatus === "PAID" ? e.amountPaid || e.fee : e.fee).toLocaleString("en-IN")} ${e.paymentStatus === "PAID" ? "Paid" : "Unpaid"}`;
  const eventCells: [string, string][] = [
    ["Age group", e.ageGroup], ["Section", e.gender === "FEMALE" ? "Girls" : "Boys"], ["Weight class", e.weightCategory],
    ["Weight entered", `${e.weightKg} kg`], ["Entry fee", fee],
  ];
  const boxH = 40;
  page.drawRectangle({ x: left, y: y - boxH + 12, width: inner, height: boxH, color: SOFT, borderColor: rgb(1, 0.82, 0.66), borderWidth: 0.8 });
  const widths = [0.3, 0.13, 0.17, 0.18, 0.22].map((f) => f * inner);
  let ex = left + 10;
  eventCells.forEach(([label, value], i) => {
    text(page, label.toUpperCase(), ex, y, 7, bold, MUTED);
    text(page, fit(value, bold, i === 0 || i === 2 ? 12 : 10.5, widths[i]! - 14), ex, y - 16, i === 0 || i === 2 ? 12 : 10.5, bold, i === 2 ? BRAND : INK);
    ex += widths[i]!;
  });
  y -= boxH + 8;

  // ── Additional details (blank lines where nothing was given, to fill in by hand) ──
  section("Additional details");
  const extra: [string, string][] = [
    ["Weight (kg)", s.weightKg ? `${s.weightKg} kg` : ""], ["Coach name", s.coachName],
    ["Manager name", s.managerName], ["District president", s.districtPresident],
    ["District secretary", s.districtSecretary],
  ];
  const halfW = (inner - 16) / 2;
  for (let i = 0; i < extra.length; i += 2) {
    for (const [j, [label, value]] of extra.slice(i, i + 2).entries()) {
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
  const signW = (inner - 12 * (signers.length - 1)) / signers.length;
  const signH = 46;
  signers.forEach((label, i) => {
    const x = left + i * (signW + 12);
    page.drawRectangle({ x, y: y - signH, width: signW, height: signH, borderColor: LINE, borderWidth: 0.8 });
    centred(fit(label, bold, 8, signW - 8), x + signW / 2, y - signH + 7, 8, bold, MUTED);
  });
  y -= signH + 18;

  // ── Instructions ──
  section("Instructions");
  const notes = [
    "Bring this entry pass (printed on A4) and your Aadhaar card to the venue. Entry without it may be refused.",
    "This pass is for the event shown above only. Each event you entered has its own pass.",
    "Report for the weigh-in at the time given by the organisers. Your weight must be within the weight class.",
    "The photograph must match the player. Tampered or altered passes are invalid.",
  ];
  for (const n of notes) {
    if (y < 64) break;
    text(page, "-", left + 2, y, 8.5, bold, BRAND);
    text(page, fit(n, sans, 8.5, inner - 14), left + 12, y, 8.5, sans);
    y -= 13;
  }

  // ── Footer ──
  page.drawLine({ start: { x: left, y: 50 }, end: { x: right, y: 50 }, thickness: 0.6, color: LINE });
  const footerLeft = `${ENTRY_PASS} ${passNo}  |  Issued ${dateTime(new Date())} IST${e.paymentStatus === "PAID" && e.paidAt ? `  |  Paid ${dateTime(e.paidAt)}` : ""}`;
  text(page, fit(footerLeft, sans, 7, inner * 0.74), left, 36, 7, sans, MUTED);
  const footerRight = fit(`${settings.orgShortName}${regNo ? `  |  Reg. No. ${regNo}` : ""}`, bold, 8, inner * 0.25);
  text(page, footerRight, right - bold.widthOfTextAtSize(footerRight, 8), 36, 8, bold, BRAND);

  const bytes = await pdf.save();
  const slug = (v: string) => v.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_+/g, "_");
  return {
    filename: `Entry_Pass_${slug(s.studentNo ?? s.fullName)}_${slug(e.ageGroup)}_${slug(e.weightCategory)}.pdf`,
    content: Buffer.from(bytes),
    contentType: "application/pdf",
  };
}

// ─── Issuing ─────────────────────────────────────────────────────────────────

const sending = new Set<string>();

/**
 * Email the passes of the student's events in the tournament that are ready (paid or free) and
 * haven't been emailed yet: one email, one PDF per event. Safe to call after any change.
 */
export async function sendEntryPassesIfReady(tournamentId: string, studentId: string, cause: EmailCause = { trigger: "SYSTEM" }) {
  const key = `${tournamentId}:${studentId}`;
  if (sending.has(key)) return;
  sending.add(key);
  try {
    const [tournament, student, entries] = await Promise.all([
      prisma.tournament.findUnique({ where: { id: tournamentId } }),
      prisma.student.findUnique({ where: { id: studentId } }),
      prisma.registration.findMany({ where: { tournamentId, studentId, hallTicketSentAt: null, paymentStatus: { not: "PENDING" } }, orderBy: { createdAt: "asc" } }),
    ]);
    if (!tournament || !student?.email || !entries.length) return;
    const photo = await loadPhoto(studentId);
    const pdfs = [];
    for (const entry of entries) pdfs.push(await entryPassPdf({ tournament, student, entry, photo }));
    const delivery = await sendEntryPasses(student.email, {
      fullName: student.fullName, studentNo: student.studentNo ?? "", tournament: tournament.title,
      events: entries.map((e) => ({ name: `${e.ageGroup} · ${e.gender === "FEMALE" ? "Girls" : "Boys"} ${e.weightCategory}`, passNo: entryPassNo(e) })),
      pdfs,
    }, {
      ...cause, studentId, tournamentId, registrationIds: entries.map((e) => e.id),
      // One email per set of entries: the same passes are never emailed twice, even from two processes.
      idempotencyKey: `entry-pass:${entries.map((e) => e.id).sort().join(",")}`,
    });
    if (delivery.status !== "DUPLICATE") {
      await prisma.emailLog.create({
        data: { tournamentId, studentId, kind: "ENTRY_PASS", trigger: "AUTO", toEmail: delivery.to, subject: delivery.subject, status: delivery.status, error: delivery.error },
      });
    }
    // Not sent (failed, suppressed, or held by the daily limit): tried again the next time something
    // changes, or when an admin releases held emails.
    if (!["FAILED", "HELD", "LIMITED", "SUPPRESSED"].includes(delivery.status)) {
      await prisma.registration.updateMany({ where: { id: { in: entries.map((e) => e.id) } }, data: { hallTicketSentAt: new Date() } });
    }
  } finally {
    sending.delete(key);
  }
}

/** Fire-and-forget for request handlers: the entry or payment is saved whether or not the email goes. */
export function sendEntryPassesLater(tournamentId: string, studentId: string, cause: EmailCause = { trigger: "SYSTEM" }) {
  sendEntryPassesIfReady(tournamentId, studentId, cause).catch((err) => console.error("[entry pass] failed:", err));
}

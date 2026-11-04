// ─── Registration confirmation PDF ───────────────────────────────────────────
// One A4 page emailed when a student's registration is successful (straight away for Tamil Nadu
// residents, on approval for everyone else): the organisation's logo, the permanent student ID and
// the details the student registered with. The Aadhaar number is masked.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Student } from "@prisma/client";
import { getSettings } from "./helpers.js";
import { AGE_GROUPS, eligibleAgeGroups, AGE_GROUP_NAMES, competitionAge } from "./categories.js";
import type { Attachment } from "./mailer.js";

const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.39, 0.45, 0.55);
const LINE = rgb(0.89, 0.91, 0.94);
const BRAND = rgb(1, 0.455, 0); // #FF7400

// The standard PDF fonts only cover Latin-1; drop anything else rather than crash.
const safe = (text: string) => text.replace(/[^\x20-\x7E\xA0-\xFF]/g, "").trim();
const date = (d: Date, withTime = false) =>
  d.toLocaleString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata", ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}) });
const GENDER: Record<string, string> = { MALE: "Male", FEMALE: "Female", OTHER: "Other" };
const INSTITUTION: Record<string, string> = { SCHOOL: "School", COLLEGE: "College", DIPLOMA: "Diploma" };

/** The text, shortened with "..." if it doesn't fit in `maxWidth`. */
function fit(text: string, font: PDFFont, size: number, maxWidth: number) {
  const full = safe(text);
  if (font.widthOfTextAtSize(full, size) <= maxWidth) return full;
  let t = full;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}...`;
}

export async function registrationPdf(student: Student): Promise<Attachment> {
  const settings = await getSettings();
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Registration confirmation - ${student.studentNo ?? student.fullName}`);
  pdf.setAuthor(settings.orgName);
  const page = pdf.addPage([595, 842]); // A4 portrait
  const { width, height } = page.getSize();
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const left = 48;
  const right = width - 48;

  // Header band with the logo and organisation
  page.drawRectangle({ x: 0, y: height - 118, width, height: 118, color: BRAND });
  let textX = left;
  if (settings.logo && settings.logoMime) {
    try {
      const image = settings.logoMime.includes("png") ? await pdf.embedPng(settings.logo) : await pdf.embedJpg(settings.logo);
      // One clean round badge: a white disc with a soft ring, and the logo fitted well inside it
      // (within the circle's inner square, so the logo's own corners never reach the edge).
      const cx = left + 40;
      const cy = height - 59;
      const radius = 40;
      // Largest size whose corners still sit just inside the circle (the logo's white background blends into the disc)
      const halfDiagonal = Math.hypot(image.width, image.height) / 2;
      const scale = (radius * 0.97) / halfDiagonal;
      const scaled = { width: image.width * scale, height: image.height * scale };
      page.drawCircle({ x: cx, y: cy, size: radius + 3, color: rgb(1, 0.82, 0.66) });
      page.drawCircle({ x: cx, y: cy, size: radius, color: rgb(1, 1, 1) });
      page.drawImage(image, { x: cx - scaled.width / 2, y: cy - scaled.height / 2, width: scaled.width, height: scaled.height });
      textX = left + 100;
    } catch (err) {
      console.error("Could not embed the logo in the registration PDF:", err);
    }
  }
  page.drawText(fit(settings.orgName.toUpperCase(), bold, 16, right - textX), { x: textX, y: height - 52, size: 16, font: bold, color: rgb(1, 1, 1) });
  const sub = [settings.regNo.trim() && `Reg. No. ${settings.regNo.trim()}`, settings.tagline].filter(Boolean).join("  |  ");
  if (sub) page.drawText(fit(sub, sans, 10, right - textX), { x: textX, y: height - 70, size: 10, font: sans, color: rgb(1, 0.93, 0.86) });
  page.drawText("Registration confirmation", { x: textX, y: height - 92, size: 12, font: bold, color: rgb(1, 1, 1) });

  // Student ID
  let y = height - 168;
  page.drawText("STUDENT ID", { x: left, y, size: 9, font: bold, color: MUTED });
  page.drawText(safe(student.studentNo ?? "Pending approval"), { x: left, y: y - 28, size: 26, font: bold, color: BRAND });
  page.drawText("REGISTERED ON", { x: right - 170, y, size: 9, font: bold, color: MUTED });
  page.drawText(date(student.createdAt), { x: right - 170, y: y - 20, size: 12, font: bold, color: INK });
  page.drawText(`Status: ${student.status === "APPROVED" ? "Registered" : student.status === "PENDING" ? "Waiting for approval" : "Not approved"}`, { x: right - 170, y: y - 36, size: 10, font: sans, color: MUTED });
  y -= 62;

  const age = competitionAge(student.dob, new Date());
  const own = AGE_GROUPS.find((g) => age >= g.minAge && age <= g.maxAge)?.name ?? "";
  const canPlay = eligibleAgeGroups(student.dob, new Date(), AGE_GROUP_NAMES).join(", ");
  const sections: [string, [string, string][]][] = [
    ["Personal details", [
      ["Full name", student.fullName], ["Gender", GENDER[student.gender] ?? student.gender], ["Date of birth", date(student.dob)],
      ["Age group", own ? `${own} (age ${age} this year)` : `Age ${age} this year`], ["Events they can play", canPlay || "-"],
      ["Father's name", student.fatherName], ["Mother's name", student.motherName], ["Blood group", student.bloodGroup],
      ["Aadhaar", student.aadhaarNumber ? `XXXX XXXX ${student.aadhaarNumber.slice(-4)}` : "-"], ["Nationality", student.nationality],
    ]],
    ["Contact", [
      ["Mobile", student.phone], ["Parent / emergency contact", student.parentPhone || student.emergencyPhone || "-"],
      ["Email (username)", student.email],
    ]],
    ["Address", [
      ["Address", student.address], ["City", student.city], ["District", student.district], ["Taluk", student.taluk || "-"],
      ["State", student.state], ["Pincode", student.pincode], ["Residing pincode", student.residingPincode],
    ]],
    ["Education & club", [
      ["Institution", `${student.institutionName}${student.institutionType ? ` (${INSTITUTION[student.institutionType] ?? student.institutionType})` : ""}`],
      ["Standard / year", student.grade], ...(student.degreeDepartment ? [["Department", student.degreeDepartment] as [string, string]] : []),
      ["Club", student.club || "-"], ["Coach", student.coachName || "-"], ["Belt", student.belt || "-"],
    ]],
  ];

  const row = (p: PDFPage, label: string, value: string, x: number, yy: number, w: number) => {
    p.drawText(label, { x, y: yy, size: 8, font: sans, color: MUTED });
    p.drawText(fit(value || "-", bold, 10, w), { x, y: yy - 13, size: 10, font: bold, color: INK });
  };
  const colWidth = (right - left - 24) / 2;
  for (const [title, fields] of sections) {
    page.drawText(title.toUpperCase(), { x: left, y, size: 9, font: bold, color: BRAND });
    page.drawLine({ start: { x: left, y: y - 5 }, end: { x: right, y: y - 5 }, thickness: 0.8, color: LINE });
    y -= 22;
    for (let i = 0; i < fields.length; i += 2) {
      row(page, fields[i]![0], fields[i]![1], left, y, colWidth);
      if (fields[i + 1]) row(page, fields[i + 1]![0], fields[i + 1]![1], left + colWidth + 24, y, colWidth);
      y -= 31;
    }
    y -= 6;
  }

  // Footer
  page.drawLine({ start: { x: left, y: 70 }, end: { x: right, y: 70 }, thickness: 0.8, color: LINE });
  page.drawText(safe(`Issued by ${settings.orgName}${settings.regNo.trim() ? ` (Reg. No. ${settings.regNo.trim()})` : ""} on ${date(new Date(), true)} (IST).`), { x: left, y: 54, size: 8, font: sans, color: MUTED });
  page.drawText("Bring your student ID to every tournament weigh-in.", { x: left, y: 42, size: 8, font: sans, color: MUTED });

  const bytes = await pdf.save();
  return {
    filename: `Registration_${(student.studentNo ?? student.fullName).replace(/[^A-Za-z0-9_-]+/g, "_")}.pdf`,
    content: Buffer.from(bytes),
    contentType: "application/pdf",
  };
}

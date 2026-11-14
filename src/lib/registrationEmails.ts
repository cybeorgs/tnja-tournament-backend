// ─── Sending the registration emails ─────────────────────────────────────────
// The only emails the system sends on its own (see lib/mailer.ts):
//   registered & approved (Tamil Nadu), fee to pay → "Registration incomplete": username, password, amount due
//   ... once that fee is paid                       → "Registration successful": student ID, PDF
//   registered & approved, nothing to pay          → "Registration successful": student ID, username, password, PDF
//   registered, waiting for approval               → "Application received": temporary ID, username, password
//   approved later by an admin                     → "Registration approved": student ID, PDF
// Each is one logical email per student (idempotency keys registration-incomplete:<id> / registration:<id> /
// approval:<id>), so it can never be sent twice — not by a double click, a retry, an import run twice or a
// second server process.
import type { Student } from "@prisma/client";
import prisma from "../db.js";
import { issueTemporaryPassword } from "./accounts.js";
import { sendApplicationReceived, sendRegistrationApproved, sendRegistrationIncomplete, sendRegistrationSuccess, type Delivery, type EmailContext } from "./mailer.js";
import { registrationPdf } from "./registrationSlip.js";
import { RETRYABLE_STATUSES } from "./emailService.js";

/** Temporary ID shown to applicants waiting for approval (they can log in with it, or their email). */
export const tempIdOf = (student: { id: string }) => `TMP-${student.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;

export const registrationKey = (studentId: string) => `registration:${studentId}`;
export const incompleteKey = (studentId: string) => `registration-incomplete:${studentId}`;
export const approvalKey = (studentId: string) => `approval:${studentId}`;

/** Entry fees the student still owes (unpaid entries in any tournament), in rupees. */
async function amountDue(studentId: string) {
  const unpaid = await prisma.registration.findMany({ where: { studentId, paymentStatus: "PENDING" }, select: { fee: true } });
  return unpaid.reduce((sum, r) => sum + r.fee, 0);
}

/** The password to email: a new one only when the login has never had one set (a sibling's email keeps theirs). */
async function loginFor(student: Student) {
  const account = await prisma.studentAccount.findUnique({ where: { email: student.email.toLowerCase() } });
  const password = account && !account.passwordSetAt ? await issueTemporaryPassword(account.id) : null;
  return { username: student.email, password };
}

const duplicate = (student: Student, subject: string): Delivery => ({ to: student.email, subject, status: "DUPLICATE", error: "" });

/** Who caused the email, without the key (added here). */
export type EmailCause = Omit<EmailContext, "idempotencyKey" | "studentId">;

/** True if this logical email was already sent (or may have been): sending it again would duplicate it. */
async function alreadySent(key: string) {
  const row = await prisma.emailMessage.findUnique({ where: { idempotencyKey: key }, select: { status: true } });
  return !!row && !RETRYABLE_STATUSES.includes(row.status);
}

/**
 * Right after a student registers (by themselves, an admin or an import). A login that has never had
 * a password set gets a new one, which is emailed; an email that already logs in keeps its password.
 * With an entry fee still to pay, this is "Registration incomplete"; "Registration successful" (student
 * ID and PDF) then follows from emailRegistrationComplete once it's paid.
 */
export async function emailRegistration(student: Student, cause: EmailCause): Promise<Delivery> {
  const key = registrationKey(student.id);
  // Checked before issuing a password: a repeat must not replace the password the player already got.
  if (await alreadySent(key)) return duplicate(student, "Registration email");
  if (student.status === "APPROVED" && student.studentNo) {
    const due = await amountDue(student.id);
    if (due > 0) {
      const pendingKey = incompleteKey(student.id);
      if (await alreadySent(pendingKey)) return duplicate(student, "Registration incomplete");
      const login = await loginFor(student);
      return sendRegistrationIncomplete(student.email, { fullName: student.fullName, login, amountDue: due }, { ...cause, studentId: student.id, idempotencyKey: pendingKey });
    }
    const login = await loginFor(student);
    return sendRegistrationSuccess(student.email, { fullName: student.fullName, studentNo: student.studentNo, login, pdf: await registrationPdf(student) }, { ...cause, studentId: student.id, idempotencyKey: key });
  }
  const login = await loginFor(student);
  return sendApplicationReceived(student.email, { fullName: student.fullName, tempId: tempIdOf(student), login }, { ...cause, studentId: student.id, idempotencyKey: key });
}

/**
 * After a payment (or an admin marking an entry paid / waived): "Registration successful" with the student
 * ID and registration PDF, for a player who was sent "Registration incomplete". Once per student; does
 * nothing if it already went (e.g. nothing was due at registration) or nothing has been paid yet.
 * The password isn't repeated (or replaced) when Email 1 already delivered it; if Email 1 never got
 * through (held or failed), this email carries the login instead.
 */
export async function emailRegistrationComplete(student: Student, cause: EmailCause): Promise<Delivery | null> {
  if (student.status !== "APPROVED" || !student.studentNo) return null;
  const key = registrationKey(student.id);
  if (await alreadySent(key)) return null;
  const settled = await prisma.registration.count({ where: { studentId: student.id, paymentStatus: { not: "PENDING" } } });
  if (!settled) return null;
  const login = (await alreadySent(incompleteKey(student.id))) ? null : await loginFor(student);
  return sendRegistrationSuccess(
    student.email,
    { fullName: student.fullName, studentNo: student.studentNo, login, pdf: await registrationPdf(student), afterPayment: true },
    { ...cause, studentId: student.id, idempotencyKey: key },
  );
}

/** When an admin approves an application from outside Tamil Nadu. */
export async function emailApproval(student: Student, cause: EmailCause): Promise<Delivery> {
  const key = approvalKey(student.id);
  if (await alreadySent(key)) return { to: student.email, subject: "Registration approved", status: "DUPLICATE", error: "" };
  return sendRegistrationApproved(student.email, { fullName: student.fullName, studentNo: student.studentNo!, pdf: await registrationPdf(student) }, { ...cause, studentId: student.id, idempotencyKey: key });
}

/** Fire-and-forget for request handlers: the registration is saved whether or not the email goes. */
export function emailRegistrationLater(student: Student, cause: EmailCause) {
  emailRegistration(student, cause).catch((err) => console.error("[registration email] failed:", err));
}

/** QUEUED: today's email limit was reached; an admin can release it from Admin → Emails. */
export type LoginEmailStatus = "SENT" | "FAILED" | "NOT_CONFIGURED" | "QUEUED";

/**
 * Send the registration email (username and password) while the player waits, so the screen can say
 * whether it went. No retry here: the email service has the one retry layer. Never throws.
 */
export async function emailRegistrationNow(student: Student, cause: EmailCause): Promise<LoginEmailStatus> {
  try {
    const delivery = await emailRegistration(student, cause);
    switch (delivery.status) {
      case "SENT":
      case "UNCERTAIN":
      case "DUPLICATE":
        return "SENT";
      case "LOGGED":
      case "NOT_CONFIGURED":
        return "NOT_CONFIGURED";
      case "HELD":
        return "QUEUED";
      default:
        return "FAILED";
    }
  } catch (err) {
    console.error(`[registration email] to ${student.email} failed:`, err);
    return "FAILED";
  }
}

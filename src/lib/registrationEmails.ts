// ─── Sending the registration emails ─────────────────────────────────────────
// The only emails the system sends on its own (see lib/mailer.ts):
//   registered & approved (Tamil Nadu)  → "Registration successful": student ID, username, password, PDF
//   registered, waiting for approval    → "Application received": temporary ID, username, password
//   approved later by an admin           → "Registration approved": student ID, PDF
// Each is one logical email per student (idempotency keys registration:<id> / approval:<id>), so it can
// never be sent twice — not by a double click, a retry, an import run twice or a second server process.
import type { Student } from "@prisma/client";
import prisma from "../db.js";
import { issueTemporaryPassword } from "./accounts.js";
import { sendApplicationReceived, sendRegistrationApproved, sendRegistrationSuccess, type Delivery, type EmailContext } from "./mailer.js";
import { registrationPdf } from "./registrationSlip.js";
import { RETRYABLE_STATUSES } from "./emailService.js";

/** Temporary ID shown to applicants waiting for approval (they can log in with it, or their email). */
export const tempIdOf = (student: { id: string }) => `TMP-${student.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;

export const registrationKey = (studentId: string) => `registration:${studentId}`;
export const approvalKey = (studentId: string) => `approval:${studentId}`;

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
 */
export async function emailRegistration(student: Student, cause: EmailCause): Promise<Delivery> {
  const key = registrationKey(student.id);
  // Checked before issuing a password: a repeat must not replace the password the player already got.
  if (await alreadySent(key)) return { to: student.email, subject: "Registration email", status: "DUPLICATE", error: "" };
  const account = await prisma.studentAccount.findUnique({ where: { email: student.email.toLowerCase() } });
  const password = account && !account.passwordSetAt ? await issueTemporaryPassword(account.id) : null;
  const login = { username: student.email, password };
  const context: EmailContext = { ...cause, studentId: student.id, idempotencyKey: key };
  if (student.status === "APPROVED" && student.studentNo) {
    return sendRegistrationSuccess(student.email, { fullName: student.fullName, studentNo: student.studentNo, login, pdf: await registrationPdf(student) }, context);
  }
  return sendApplicationReceived(student.email, { fullName: student.fullName, tempId: tempIdOf(student), login }, context);
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

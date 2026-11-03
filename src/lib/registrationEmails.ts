// ─── Sending the registration emails ─────────────────────────────────────────
// The only emails the system sends on its own (see lib/mailer.ts):
//   registered & approved (Tamil Nadu)  → "Registration successful": student ID, username, password, PDF
//   registered, waiting for approval    → "Application received": temporary ID, username, password
//   approved later by an admin           → "Registration approved": student ID, PDF
import type { Student } from "@prisma/client";
import prisma from "../db.js";
import { issueTemporaryPassword } from "./accounts.js";
import { sendApplicationReceived, sendRegistrationApproved, sendRegistrationSuccess } from "./mailer.js";
import { registrationPdf } from "./registrationSlip.js";

/** Temporary ID shown to applicants waiting for approval (they can log in with it, or their email). */
export const tempIdOf = (student: { id: string }) => `TMP-${student.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;

/**
 * Right after a student registers (by themselves, an admin or an import). A login that has never had
 * a password set gets a new one, which is emailed; an email that already logs in keeps its password.
 */
export async function emailRegistration(student: Student) {
  const account = await prisma.studentAccount.findUnique({ where: { email: student.email.toLowerCase() } });
  const password = account && !account.passwordSetAt ? await issueTemporaryPassword(account.id) : null;
  const login = { username: student.email, password };
  if (student.status === "APPROVED" && student.studentNo) {
    return sendRegistrationSuccess(student.email, { fullName: student.fullName, studentNo: student.studentNo, login, pdf: await registrationPdf(student) });
  }
  return sendApplicationReceived(student.email, { fullName: student.fullName, tempId: tempIdOf(student), login });
}

/** When an admin approves an application from outside Tamil Nadu. */
export async function emailApproval(student: Student) {
  return sendRegistrationApproved(student.email, { fullName: student.fullName, studentNo: student.studentNo!, pdf: await registrationPdf(student) });
}

/** Fire-and-forget for request handlers: the registration is saved whether or not the email goes. */
export function emailRegistrationLater(student: Student) {
  emailRegistration(student).catch((err) => console.error("[registration email] failed:", err));
}

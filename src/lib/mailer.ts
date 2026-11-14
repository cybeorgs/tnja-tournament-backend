// Email templates. Sending goes through lib/emailService.ts (audit log, duplicate guard, suppression
// list, daily budget, one retry layer); nothing here talks to SMTP directly.
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errors.js";
import { getSettings } from "./helpers.js";
import { suppressionText } from "./emailSuppression.js";
import { deliverEmail, type Delivery, type EmailContext } from "./emailService.js";
import type { Attachment } from "./emailTransport.js";

export { checkMailSetup } from "./emailTransport.js";
export type { Attachment } from "./emailTransport.js";
export type { Delivery, EmailContext } from "./emailService.js";

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Branded email shell; `body` is trusted HTML (escape anything user-supplied before passing it). */
async function layout(subtitle: string, body: string) {
  const settings = await getSettings();
  const org = escape(settings.orgName);
  const regNo = settings.regNo.trim() ? `<p style="color:#ffe7d4;margin:4px 0 0;font-size:12px">Reg. No. ${escape(settings.regNo.trim())}</p>` : "";
  return `<!DOCTYPE html>
<html>
<body style="margin:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#334155">
  <div style="padding:40px 16px">
    <div style="max-width:560px;margin:auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0">
      <div style="background:#ff7400;padding:28px 32px;text-align:center">
        <h1 style="color:#fff;margin:0;font-size:20px">${org}</h1>${regNo}
        <p style="color:#ffe7d4;margin:6px 0 0">${subtitle}</p>
      </div>
      <div style="padding:32px;line-height:1.6">${body}</div>
      <div style="background:#f1f5f9;padding:16px 32px;text-align:center;color:#64748b;font-size:12px">© ${new Date().getFullYear()} ${org}</div>
    </div>
  </div>
</body>
</html>`;
}

const box = (label: string, value: string) =>
  `<p style="margin:6px 0"><span style="color:#64748b">${label}:</span> <strong style="font-family:Consolas,monospace;font-size:16px;color:#0f172a">${escape(value)}</strong></p>`;

const button = (href: string, label: string) =>
  `<p style="text-align:center;margin:28px 0 8px"><a href="${escape(href)}" style="background:#ff7400;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700">${label}</a></p>`;
const loginUrl = () => `${env.publicSiteUrl.replace(/\/$/, "")}/student/login`;
const loginButton = () => (env.publicSiteUrl ? button(loginUrl(), "Log in") : "");

/** Template output → the central email service. Never throws: failures come back as a Delivery. */
async function send(kind: Parameters<typeof deliverEmail>[0]["kind"], context: EmailContext, to: string, subject: string, html: string, attachments?: Attachment[]): Promise<Delivery> {
  try {
    return await deliverEmail({ kind, to, subject, html, attachments, context });
  } catch (err) {
    console.error(`[mailer] Unexpected error sending ${kind} to ${to}:`, err);
    return { to, subject, status: "FAILED", error: err instanceof Error ? err.message.slice(0, 500) : "Unknown error" };
  }
}

// ─── The registration emails ─────────────────────────────────────────────────
// Only these go out on their own:
//   • Tamil Nadu students with an entry fee still to pay: registration incomplete — username, password,
//     the amount due and a Continue Payment button (no student ID, PDF or entry pass yet).
//   • Once that fee is paid (or straight away when nothing is due): registration successful — student
//     ID and the registration PDF (plus the username and password if they weren't sent before).
//   • Applicants from other states (waiting for approval): application received — a temporary ID,
//     username and password to log in and follow the status.
//   • When such an application is approved: registration approved — the student ID and the PDF.
// "Forgot password" and the email verification code are also emailed, but only when the person asks.

type Login = { username: string; password: string | null };

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/** The username/password box, without a button. With no password: the email already had a login (e.g. a sibling). */
const loginDetails = (login: Login) =>
  `<div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px 18px;margin:18px 0">
     <p style="margin:0 0 6px;font-weight:700;color:#0f172a">Your login</p>
     ${box("Username", login.username)}
     ${login.password ? box("Password", login.password) : `<p style="margin:6px 0;color:#475569">Password: the one you already use for this email.</p>`}
     ${login.password ? `<p style="margin:8px 0 0;font-size:13px;color:#64748b">Keep this password private. You can change it after logging in.</p>` : ""}
   </div>`;

/** Username and password, then the Log in button. */
const loginBlock = (login: Login) => `${loginDetails(login)}${loginButton()}`;

/**
 * Email 1 for a player with an entry fee still to pay: registration received but incomplete. Username,
 * password, the amount due and a Continue Payment button. Deliberately no student ID, registration PDF
 * or entry pass: those come with "Registration successful" once the payment goes through.
 */
export async function sendRegistrationIncomplete(to: string, s: { fullName: string; login: Login; amountDue: number }, context: EmailContext) {
  return send("REGISTRATION_INCOMPLETE", context,
    to,
    "Your TNJA Registration Is Incomplete – Complete Your Payment",
    await layout(
      "Registration incomplete — payment pending",
      `<p>We've received ${escape(s.fullName)}'s registration.</p>
       <div style="border:1px solid #fed7aa;background:#fff7ed;border-radius:12px;padding:14px 18px;margin:18px 0">
         <p style="margin:0;font-weight:700;color:#9a3412">Your registration is not complete yet.</p>
         <p style="margin:6px 0 0;color:#7c2d12">It will be complete only after the registration fee is paid successfully. Until then you can't play in the tournament, and no Tournament Entry Pass is issued.</p>
         <p style="margin:12px 0 0"><span style="color:#9a3412">Registration fee due:</span> <strong style="font-size:20px;color:#0f172a">${rupees(s.amountDue)}</strong></p>
       </div>
       ${loginDetails(s.login)}
       ${env.publicSiteUrl ? button(loginUrl(), "Continue Payment") : ""}
       <p style="font-size:13px;color:#64748b">Log in with the username and password above and pay from your account. Once the payment is successful we'll email your Student ID and registration confirmation, followed by your Tournament Entry Pass.</p>`,
    ),
  );
}

/**
 * Email 2: registration successful — student ID and the registration PDF. Sent straight away when nothing
 * is due, otherwise once the fee is paid. `login` is null when Email 1 already gave the password.
 */
export async function sendRegistrationSuccess(to: string, s: { fullName: string; studentNo: string; login: Login | null; pdf: Attachment; afterPayment?: boolean }, context: EmailContext) {
  return send("REGISTRATION_SUCCESS", context,
    to,
    `Registration successful — ${s.studentNo}`,
    await layout(
      "Registration successful",
      `<p>${s.afterPayment ? `Payment received — ${escape(s.fullName)}'s registration is now complete.` : `${escape(s.fullName)} is registered.`}</p>${box("Student ID", s.studentNo)}
       <p>The registration confirmation is attached as a PDF.${s.afterPayment ? " Your Tournament Entry Pass will be emailed to you separately." : ""}</p>
       ${s.login ? loginBlock(s.login) : `<p>Log in with the username and password from our earlier email.</p>${loginButton()}`}`,
    ),
    [s.pdf],
  );
}

export async function sendApplicationReceived(to: string, s: { fullName: string; tempId: string; login: Login }, context: EmailContext) {
  return send("APPLICATION_RECEIVED", context,
    to,
    `Application received — ${s.tempId}`,
    await layout(
      "Application received",
      `<p>We've received ${escape(s.fullName)}'s application. Because the address is outside Tamil Nadu, our team will check the documents you uploaded.</p>
       ${box("Temporary ID", s.tempId)}
       <p>Log in any time to see the status. Once it's approved we'll email the registration confirmation (PDF) with the permanent student ID.</p>
       ${loginBlock(s.login)}`,
    ),
  );
}

export async function sendRegistrationApproved(to: string, s: { fullName: string; studentNo: string; pdf: Attachment }, context: EmailContext) {
  return send("REGISTRATION_APPROVED", context,
    to,
    `Registration approved — ${s.studentNo}`,
    await layout(
      "Registration approved",
      `<p>Good news — ${escape(s.fullName)}'s registration has been approved.</p>${box("Student ID", s.studentNo)}
       <p>The registration confirmation is attached as a PDF. Log in with the same username and password as before.</p>${loginButton()}`,
    ),
    [s.pdf],
  );
}

/**
 * Sent by an admin from Payments to a player who still hasn't paid: pay by the given date, or the
 * registration (the ID, the login and every detail) is deleted from the database.
 */
export async function sendUnpaidDeletionNotice(
  to: string,
  s: { fullName: string; tournament: string; events: { name: string; fee: number }[]; amountDue: number; payBy: Date },
  context: EmailContext,
) {
  const payBy = s.payBy.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
  const rows = s.events
    .map((e) => `<tr><td style="padding:8px 12px;border-top:1px solid #e2e8f0">${escape(e.name)}</td><td style="padding:8px 12px;border-top:1px solid #e2e8f0;text-align:right;font-weight:700">${rupees(e.fee)}</td></tr>`)
    .join("");
  return send("UNPAID_NOTICE", context,
    to,
    `Action required: pay your TNJA registration fee by ${payBy}, or your registration will be deleted`,
    await layout(
      "Payment pending — final notice",
      `<p>Dear ${escape(s.fullName)},</p>
       <p>Your registration for <strong>${escape(s.tournament)}</strong> is still incomplete because the registration fee has not been paid.</p>
       <div style="border:1px solid #fecaca;background:#fef2f2;border-radius:12px;padding:14px 18px;margin:18px 0">
         <p style="margin:0;font-weight:700;color:#991b1b">Pay by ${payBy}.</p>
         <p style="margin:6px 0 0;color:#7f1d1d">If the fee is not paid by then, we will delete your registration — your ID, your login and all the details you entered — from our database. You will not be able to play in the tournament, and you would have to register again from the start.</p>
         <p style="margin:12px 0 0"><span style="color:#991b1b">Amount due:</span> <strong style="font-size:20px;color:#0f172a">${rupees(s.amountDue)}</strong></p>
       </div>
       <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:10px;margin:14px 0;font-size:14px">
         <tr><th style="padding:8px 12px;text-align:left;color:#64748b;font-size:12px">Event</th><th style="padding:8px 12px;text-align:right;color:#64748b;font-size:12px">Fee</th></tr>${rows}
       </table>
       ${box("Username", to)}
       ${env.publicSiteUrl ? button(loginUrl(), "Continue Payment") : ""}
       <p style="font-size:13px;color:#64748b">Log in with your username and the password from your registration email (forgot it? use "Forgot password?" on the login page), then pay from your account. Already paid in the last few minutes? You can ignore this email.</p>`,
    ),
  );
}

/** After payment (or straight away when free): a Tournament Entry Pass per event, each as its own PDF. */
export async function sendEntryPasses(to: string, s: { fullName: string; studentNo: string; tournament: string; events: { name: string; passNo: string }[]; pdfs: Attachment[] }, context: EmailContext) {
  const many = s.events.length > 1;
  const list = s.events
    .map((e) => `<tr><td style="padding:8px 12px;border-top:1px solid #e2e8f0">${escape(e.name)}</td><td style="padding:8px 12px;border-top:1px solid #e2e8f0;font-family:monospace;font-weight:700;color:#ff7400;text-align:right">${escape(e.passNo)}</td></tr>`)
    .join("");
  return send("ENTRY_PASS", context,
    to,
    `Tournament Entry Pass${many ? "es" : ""} — ${s.tournament}`,
    await layout(
      `Tournament Entry Pass${many ? "es" : ""}`,
      `<p>${escape(s.fullName)}'s Tournament Entry Pass${many ? `es for ${s.events.length} events` : ""} for <strong>${escape(s.tournament)}</strong> ${many ? "are" : "is"} attached — one PDF per event.</p>
       ${s.studentNo ? box("Student ID", s.studentNo) : ""}
       <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:10px;margin:14px 0;font-size:14px">
         <tr><th style="padding:8px 12px;text-align:left;color:#64748b;font-size:12px">Event</th><th style="padding:8px 12px;text-align:right;color:#64748b;font-size:12px">Pass no.</th></tr>${list}
       </table>
       <p>Print ${many ? "each pass" : "it"} on A4 paper and bring ${many ? "them" : "it"}, with your Aadhaar card, to the weigh-in. You can download ${many ? "them" : "it"} again any time after logging in.</p>${loginButton()}`,
    ),
    s.pdfs,
  );
}

/**
 * Email a registration verification code (one email per code: its key is the challenge id). Returns
 * how it went for the OTP limits; anything that means the user won't get the code is an error for them.
 * The code is never recorded or logged in production (the audit keeps a neutral subject).
 */
export async function sendEmailOtp(to: string, otp: string, validMinutes: number, challengeId: string, ip: string): Promise<{ status: "SENT" | "NOT_CONFIGURED"; messageId: string }> {
  const html = await layout(
    "Email verification",
    `<p>Use this code to verify your email address for registration. It expires in <strong>${validMinutes} minutes</strong>.</p>
     <p style="text-align:center;margin:28px 0;font-size:32px;font-weight:700;letter-spacing:10px;color:#ff7400">${otp}</p>
     <p>If you did not start a registration, you can ignore this email. Never share this code with anyone.</p>`,
  );
  const delivery = await deliverEmail({
    kind: "OTP", to, subject: `${otp} is your email verification code`, auditSubject: "Email verification code", html,
    context: { trigger: "SELF", actor: ip ? `${to} (IP ${ip})` : to, idempotencyKey: `otp:${challengeId}` },
  });
  switch (delivery.status) {
    case "SENT":
    case "UNCERTAIN": // very likely delivered; asking for another code would only cost more
    case "DUPLICATE":
      return { status: "SENT", messageId: delivery.id ?? "" };
    case "LOGGED":
      return { status: "NOT_CONFIGURED", messageId: delivery.id ?? "" };
    case "NOT_CONFIGURED":
      throw new HttpError(503, "Email verification is not available right now. Please contact the organiser.");
    case "SUPPRESSED":
      throw new HttpError(400, `We can't send email to this address because ${suppressionText(delivery.error)}. Please use a different email address.`);
    case "HELD":
    case "LIMITED":
      throw new HttpError(503, "Email verification is temporarily unavailable because today's email limit was reached. Please try again later or contact the organiser.");
    default:
      throw new HttpError(502, "We couldn't send the code to this email address. Check it and try again.");
  }
}

/** Each request is its own email (no idempotency key); the reset link is never recorded. */
export async function sendPasswordReset(to: string, setPasswordUrl: string, context: EmailContext) {
  return send("PASSWORD_RESET", context,
    to,
    "Reset your password",
    await layout(
      "Reset your password",
      `<p>We received a request to reset the password for this account.</p>${box("Username", to)}${button(setPasswordUrl, "Choose a new password")}<p style="font-size:13px;color:#64748b">This link works once and expires in 1 hour. If you didn't ask for this, ignore this email — your password hasn't changed.</p>`,
    ),
  );
}

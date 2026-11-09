import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errors.js";
import { getSettings } from "./helpers.js";
import { suppress, suppressionOf, suppressionText } from "./emailSuppression.js";

let transporter: Transporter | null = null;

const smtpConfigured = () => !!(env.smtp.host && env.smtp.user && env.smtp.pass);

/**
 * Startup check: providers such as Brevo log in with an SMTP login (e.g. 1234@smtp-brevo.com) that is not a
 * mailbox; mail "from" it is dropped. The sender must be an address verified with the provider (SMTP_FROM_EMAIL).
 */
export function checkMailSetup() {
  if (!smtpConfigured()) return console.warn("[mailer] SMTP is not configured — emails are only written to this log.");
  if (!process.env.SMTP_FROM_EMAIL || /@smtp-brevo.com$/i.test(env.smtp.fromEmail)) {
    console.warn("[mailer] SMTP_FROM_EMAIL is not set to a real sender address (it falls back to the SMTP login). Set it to a sender verified in your email provider (Brevo → Senders & domains), or emails may never arrive.");
  }
}

export type Attachment = { filename: string; content: Buffer; contentType: string };

/** The address is on the suppression list (bounced, blocked, spam complaint…): nothing was sent. */
export class SuppressedRecipientError extends Error {
  constructor(public reason: string) {
    super(`Not sent: the address is suppressed (${reason}).`);
  }
}

// Temporary failures (busy server, dropped connection, SMTP 4xx) get at most 2 more tries, spaced out.
const RETRY_DELAYS_MS = [1000, 3000];
const TEMPORARY_CODES = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNRESET", "EDNS"]);
type SmtpError = Error & { code?: string; responseCode?: number };
const isTemporary = (err: SmtpError) => TEMPORARY_CODES.has(err.code ?? "") || (!!err.responseCode && err.responseCode >= 400 && err.responseCode < 500);
// The server refused this recipient outright (550 mailbox unavailable, 551/553 bad address). Not our
// login or the message, which have other codes: only these mean "never send to this address again".
const isRecipientRejected = (err: SmtpError) => err.code === "EENVELOPE" && [550, 551, 553].includes(err.responseCode ?? 0);

/**
 * Sends one email and returns the mail server's Message-ID. Suppressed addresses are never sent to;
 * a recipient the server rejects is suppressed (and not retried); temporary failures are retried twice.
 */
async function sendMail(message: { to: string; subject: string; html: string; attachments?: Attachment[] }): Promise<string> {
  const suppressed = await suppressionOf(message.to);
  if (suppressed) throw new SuppressedRecipientError(suppressed.reason);
  const settings = await getSettings();
  transporter ??= nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.port === 465, // 465 is implicit TLS; others (e.g. 587) use STARTTLS
    requireTLS: env.smtp.port !== 465,
    auth: { user: env.smtp.user, pass: env.smtp.pass },
  });
  for (let attempt = 0; ; attempt++) {
    try {
      const info = await transporter.sendMail({ from: `"${env.smtp.fromName || settings.orgName}" <${env.smtp.fromEmail}>`, ...message });
      return String(info.messageId ?? "");
    } catch (err) {
      const e = err as SmtpError;
      if (isRecipientRejected(e)) {
        await suppress(message.to, e.responseCode === 550 ? "HARD_BOUNCE" : "INVALID", "SMTP", e.message);
        throw err;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTemporary(e)) throw err;
      console.warn(`[mailer] Temporary failure sending "${message.subject}" (${e.code ?? e.responseCode}); retry ${attempt + 1} of ${RETRY_DELAYS_MS.length} in ${delay / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

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

/**
 * Send an email. Failures are logged, not thrown: the registration that triggered it has already
 * succeeded, and the student can always use "Forgot password" on the login page.
 */
export type Delivery = { to: string; subject: string; status: "SENT" | "FAILED" | "NOT_CONFIGURED"; error: string };

async function notify(to: string, subject: string, html: string, attachments?: Attachment[]): Promise<Delivery> {
  if (!smtpConfigured()) {
    console.log(`[mailer] SMTP not configured — would email ${to}: ${subject}\n${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}`);
    return { to, subject, status: "NOT_CONFIGURED", error: "" };
  }
  try {
    await sendMail({ to, subject, html, attachments });
    return { to, subject, status: "SENT", error: "" };
  } catch (err) {
    if (err instanceof SuppressedRecipientError) {
      console.warn(`[mailer] Skipped "${subject}" to ${to}: suppressed (${err.reason})`);
      return { to, subject, status: "FAILED", error: `Not sent: ${suppressionText(err.reason)}.` };
    }
    console.error(`[mailer] Could not send "${subject}" to ${to}:`, err);
    return { to, subject, status: "FAILED", error: err instanceof Error ? err.message.slice(0, 500) : "Unknown error" };
  }
}

// ─── The registration emails ─────────────────────────────────────────────────
// Only these go out on their own:
//   • Tamil Nadu students (approved straight away): registration successful — student ID, username,
//     password and the registration PDF.
//   • Applicants from other states (waiting for approval): application received — a temporary ID,
//     username and password to log in and follow the status.
//   • When such an application is approved: registration approved — the student ID and the PDF.
// "Forgot password" and the email verification code are also emailed, but only when the person asks.

type Login = { username: string; password: string | null };

/** Username and password; when the email already had a login (e.g. a sibling), their existing password. */
const loginBlock = (login: Login) =>
  `<div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px 18px;margin:18px 0">
     <p style="margin:0 0 6px;font-weight:700;color:#0f172a">Your login</p>
     ${box("Username", login.username)}
     ${login.password ? box("Password", login.password) : `<p style="margin:6px 0;color:#475569">Password: the one you already use for this email.</p>`}
     ${login.password ? `<p style="margin:8px 0 0;font-size:13px;color:#64748b">Keep this password private. You can change it after logging in.</p>` : ""}
   </div>${loginButton()}`;

export async function sendRegistrationSuccess(to: string, s: { fullName: string; studentNo: string; login: Login; pdf: Attachment }) {
  return notify(
    to,
    `Registration successful — ${s.studentNo}`,
    await layout(
      "Registration successful",
      `<p>${escape(s.fullName)} is registered.</p>${box("Student ID", s.studentNo)}
       <p>The registration confirmation is attached as a PDF.</p>${loginBlock(s.login)}`,
    ),
    [s.pdf],
  );
}

export async function sendApplicationReceived(to: string, s: { fullName: string; tempId: string; login: Login }) {
  return notify(
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

export async function sendRegistrationApproved(to: string, s: { fullName: string; studentNo: string; pdf: Attachment }) {
  return notify(
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

/** After payment (or straight away when free): a Tournament Entry Pass per event, each as its own PDF. */
export async function sendEntryPasses(to: string, s: { fullName: string; studentNo: string; tournament: string; events: { name: string; passNo: string }[]; pdfs: Attachment[] }) {
  const many = s.events.length > 1;
  const list = s.events
    .map((e) => `<tr><td style="padding:8px 12px;border-top:1px solid #e2e8f0">${escape(e.name)}</td><td style="padding:8px 12px;border-top:1px solid #e2e8f0;font-family:monospace;font-weight:700;color:#ff7400;text-align:right">${escape(e.passNo)}</td></tr>`)
    .join("");
  return notify(
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
 * Email a registration verification code; returns the delivery status and the mail server's Message-ID.
 * Without SMTP (local development only) the code is written to the console so it can be tested;
 * in production that is refused instead.
 */
export async function sendEmailOtp(to: string, otp: string, validMinutes: number): Promise<{ status: "SENT" | "NOT_CONFIGURED"; messageId: string }> {
  if (!smtpConfigured()) {
    if (env.isProduction) throw new HttpError(503, "Email verification is not available right now. Please contact the organiser.");
    console.log(`[mailer] SMTP not configured (development) — email OTP for ${to}: ${otp}`);
    return { status: "NOT_CONFIGURED", messageId: "" };
  }

  const html = await layout(
    "Email verification",
    `<p>Use this code to verify your email address for registration. It expires in <strong>${validMinutes} minutes</strong>.</p>
     <p style="text-align:center;margin:28px 0;font-size:32px;font-weight:700;letter-spacing:10px;color:#ff7400">${otp}</p>
     <p>If you did not start a registration, you can ignore this email. Never share this code with anyone.</p>`,
  );
  try {
    return { status: "SENT", messageId: await sendMail({ to, subject: `${otp} is your email verification code`, html }) };
  } catch (err) {
    if (err instanceof SuppressedRecipientError) {
      throw new HttpError(400, `We can't send email to this address because ${suppressionText(err.reason)}. Please use a different email address.`);
    }
    // Log the failure, never the code.
    console.error(`[mailer] Could not send email OTP to ${to}:`, (err as Error).message);
    throw new HttpError(502, "We couldn't send the code to this email address. Check it and try again.");
  }
}

export async function sendPasswordReset(to: string, setPasswordUrl: string) {
  await notify(
    to,
    "Reset your password",
    await layout(
      "Reset your password",
      `<p>We received a request to reset the password for this account.</p>${box("Username", to)}${button(setPasswordUrl, "Choose a new password")}<p style="font-size:13px;color:#64748b">This link works once and expires in 1 hour. If you didn't ask for this, ignore this email — your password hasn't changed.</p>`,
    ),
  );
}

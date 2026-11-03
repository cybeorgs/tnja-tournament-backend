import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errors.js";
import { getSettings } from "./helpers.js";

let transporter: Transporter | null = null;

const smtpConfigured = () => !!(env.smtp.host && env.smtp.user && env.smtp.pass);

async function sendMail(message: { to: string; subject: string; html: string }) {
  const settings = await getSettings();
  transporter ??= nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.port === 465, // 465 is implicit TLS; others (e.g. 587) use STARTTLS
    requireTLS: env.smtp.port !== 465,
    auth: { user: env.smtp.user, pass: env.smtp.pass },
  });
  await transporter.sendMail({ from: `"${env.smtp.fromName || settings.orgName}" <${env.smtp.fromEmail}>`, ...message });
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Branded email shell; `body` is trusted HTML (escape anything user-supplied before passing it). */
async function layout(subtitle: string, body: string) {
  const org = escape((await getSettings()).orgName);
  return `<!DOCTYPE html>
<html>
<body style="margin:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#334155">
  <div style="padding:40px 16px">
    <div style="max-width:560px;margin:auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0">
      <div style="background:#ff7400;padding:28px 32px;text-align:center">
        <h1 style="color:#fff;margin:0;font-size:20px">${org}</h1>
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
 * Send a notification. Failures are logged, not thrown: the action that triggered the email has
 * already succeeded, and the student can always ask for a new set-password link from the login page.
 */
export type Delivery = { to: string; subject: string; status: "SENT" | "FAILED" | "NOT_CONFIGURED"; error: string };

async function notify(to: string, subject: string, html: string): Promise<Delivery> {
  if (!smtpConfigured()) {
    console.log(`[mailer] SMTP not configured — would email ${to}: ${subject}\n${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}`);
    return { to, subject, status: "NOT_CONFIGURED", error: "" };
  }
  try {
    await sendMail({ to, subject, html });
    return { to, subject, status: "SENT", error: "" };
  } catch (err) {
    console.error(`[mailer] Could not send "${subject}" to ${to}:`, err);
    return { to, subject, status: "FAILED", error: err instanceof Error ? err.message.slice(0, 500) : "Unknown error" };
  }
}

/** Email a registration verification code. Without SMTP (outside production) the code is logged instead. */
export async function sendEmailOtp(to: string, otp: string) {
  if (!smtpConfigured()) {
    if (env.isProduction) throw new HttpError(503, "Email verification is not available right now. Please contact the organiser.");
    console.log(`[mailer] SMTP not configured — email OTP for ${to}: ${otp}`);
    return;
  }

  const html = await layout(
    "Email verification",
    `<p>Use this code to verify your email address for student registration. It expires in <strong>10 minutes</strong>.</p>
     <p style="text-align:center;margin:28px 0;font-size:32px;font-weight:700;letter-spacing:10px;color:#ff7400">${otp}</p>
     <p>If you did not start a registration, you can ignore this email. Never share this code with anyone.</p>`,
  );
  try {
    await sendMail({ to, subject: `${otp} is your email verification code`, html });
  } catch (err) {
    console.error("[mailer] Could not send email OTP:", err);
    throw new HttpError(502, "We couldn't send the code to this email address. Check it and try again.");
  }
}

/**
 * After registering: the student's status and the account. A new account gets its username and a
 * one-time link to set the password (passwords are never emailed); an existing one just a login button.
 */
export async function sendStudentRegistered(to: string, s: { fullName: string; studentNo: string | null; setPasswordUrl: string | null }) {
  const status = s.studentNo
    ? `<p>${escape(s.fullName)} is registered.</p>${box("Student ID", s.studentNo)}`
    : `<p>We've received ${escape(s.fullName)}'s application. Because the address is outside Tamil Nadu, our team will check the documents you uploaded. We'll email you once it's approved — then you can register for tournaments.</p>`;
  const account = s.setPasswordUrl
    ? `<p style="margin-top:24px">Your account is ready. You can log in any time to see your registration and pay any pending entry fee.</p>${box("Username", to)}${button(s.setPasswordUrl, "Set your password")}<p style="font-size:13px;color:#64748b">This link works once and expires in 7 days. If it expires, use “Forgot password” on the login page.</p>`
    : `<p style="margin-top:24px">${escape(s.fullName)} has been added to your existing account (${escape(to)}) — log in with your usual password.</p>${loginButton()}`;
  await notify(to, s.studentNo ? `Registration complete — ${s.studentNo}` : "We've received your application", await layout("Student registration", status + account));
}

export async function sendStudentApproved(to: string, s: { fullName: string; studentNo: string }) {
  await notify(
    to,
    `Application approved — ${s.studentNo}`,
    await layout("Application approved", `<p>Good news — ${escape(s.fullName)}'s application has been approved.</p>${box("Student ID", s.studentNo)}<p>You can now log in and register for tournaments.</p>${loginButton()}`),
  );
}

export async function sendStudentRejected(to: string, s: { fullName: string; reason: string }) {
  await notify(
    to,
    "Your application needs attention",
    await layout(
      "Application update",
      `<p>We couldn't approve ${escape(s.fullName)}'s application.</p>${s.reason ? `<p style="background:#fef2f2;border-radius:10px;padding:12px 16px;color:#991b1b">${escape(s.reason)}</p>` : ""}<p>Please contact the organiser if you have questions.</p>`,
    ),
  );
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

// ─── Tournament registration emails ──────────────────────────────────────────
// The three automated emails of a tournament entry. Everything shown (fees, dates, amounts) comes
// from the tournament's settings and the entries themselves, passed in by lib/notifications.ts.

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const ist = (d: Date) =>
  d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

export type EmailEntry = { category: string; fee: number; isLate: boolean; paymentStatus: string; amountPaid: number };
type EmailTournament = { title: string; venue: string; startDate: Date };

const tournamentLine = (t: EmailTournament) =>
  `<p style="margin:0 0 16px;color:#64748b;font-size:14px">${escape(t.venue)} · starts ${escape(ist(t.startDate))} (IST)</p>`;

const statusLabel = (e: EmailEntry) => (e.paymentStatus === "PAID" ? "Paid" : e.paymentStatus === "WAIVED" ? (e.fee ? "Waived" : "No fee") : "Payment pending");

/** Table of entries: category, fee, status. */
function entriesTable(entries: EmailEntry[], { showStatus = true } = {}) {
  const cell = "padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:14px";
  const rows = entries
    .map(
      (e) =>
        `<tr><td style="${cell}">${escape(e.category)}${e.isLate ? ' <span style="color:#b91c1c;font-size:12px">(late)</span>' : ""}</td>` +
        `<td style="${cell};text-align:right;white-space:nowrap">${e.fee ? inr(e.fee) : "Free"}</td>` +
        (showStatus ? `<td style="${cell};text-align:right;white-space:nowrap;color:${e.paymentStatus === "PENDING" ? "#b45309" : "#047857"}">${statusLabel(e)}</td>` : "") +
        `</tr>`,
    )
    .join("");
  return `<table style="width:100%;border-collapse:collapse;margin:8px 0 16px">${rows}</table>`;
}

const accountBlock = (to: string, setPasswordUrl: string | null) =>
  setPasswordUrl
    ? `<p style="margin-top:24px">Your account:</p>${box("Username", to)}${button(setPasswordUrl, "Set your password")}<p style="font-size:13px;color:#64748b">This link works once and expires in 7 days. If it expires, use “Forgot password” on the login page.</p>`
    : `${box("Username", to)}${loginButton()}`;

/** Fees of the tournament, as configured by the admin. */
type EmailFees = { regularFee: number; lateFee: number; closesAt: Date };

/** 1. Sent as soon as a player's tournament entries are saved. */
export async function sendRegistrationConfirmation(
  to: string,
  d: { playerName: string; tournament: EmailTournament; entries: EmailEntry[]; isLate: boolean; fees: EmailFees; setPasswordUrl: string | null },
): Promise<Delivery> {
  const due = d.entries.filter((e) => e.paymentStatus === "PENDING").reduce((sum, e) => sum + e.fee, 0);
  // Before the regular deadline an unpaid entry's fee rises to the late fee at the deadline; say so.
  const rises = !d.isLate && d.fees.lateFee > d.fees.regularFee;
  const payment = due
    ? `<p style="background:#fffbeb;border-radius:10px;padding:12px 16px;color:#92400e"><strong>Payment pending: ${inr(due)}.</strong> ` +
      (rises
        ? `Pay before regular registration closes on ${escape(ist(d.fees.closesAt))} (IST) — after that the fee rises to ${inr(d.fees.lateFee)} per category.`
        : `Pay any time before the tournament starts on ${escape(ist(d.tournament.startDate))} (IST).`) +
      ` Log in to your dashboard to pay.</p>`
    : `<p style="background:#ecfdf5;border-radius:10px;padding:12px 16px;color:#065f46"><strong>Nothing to pay</strong> — your registration is complete.</p>`;
  return notify(
    to,
    `Registration confirmed — ${d.tournament.title}`,
    await layout(
      "Registration confirmation",
      `<h2 style="margin:0 0 4px;font-size:18px;color:#0f172a">${escape(d.tournament.title)}</h2>${tournamentLine(d.tournament)}
       <p>${escape(d.playerName)} is registered${d.isLate ? " (late registration, at the late entry fee)" : ""}:</p>
       ${entriesTable(d.entries)}${payment}${accountBlock(to, d.setPasswordUrl)}`,
    ),
  );
}

/** 2. Sent at the admin's reminder time to players whose entries are still unpaid. */
export async function sendDeadlineReminder(
  to: string,
  d: { playerName: string; tournament: EmailTournament; entries: EmailEntry[]; fees: EmailFees },
): Promise<Delivery> {
  const due = d.entries.reduce((sum, e) => sum + e.fee, 0);
  return notify(
    to,
    `Reminder: pay before ${ist(d.fees.closesAt)} — ${d.tournament.title}`,
    await layout(
      "Registration deadline reminder",
      `<h2 style="margin:0 0 4px;font-size:18px;color:#0f172a">${escape(d.tournament.title)}</h2>${tournamentLine(d.tournament)}
       <p>${escape(d.playerName)}'s registration is waiting for payment:</p>
       ${entriesTable(d.entries)}
       <p>Regular registration closes on <strong>${escape(ist(d.fees.closesAt))}</strong> (IST). The current fee is <strong>${inr(d.fees.regularFee)}</strong> per category.
       After the deadline the late entry fee of <strong>${inr(d.fees.lateFee)}</strong> per category applies, also to registrations that are still unpaid.</p>
       <p style="background:#fffbeb;border-radius:10px;padding:12px 16px;color:#92400e"><strong>Amount due now: ${inr(due)}.</strong></p>
       ${loginButton()}`,
    ),
  );
}

/** 3. Sent once the payment gateway has verified a payment: a receipt. */
export async function sendPaymentReceipt(
  to: string,
  d: { playerName: string; tournament: EmailTournament; entries: EmailEntry[]; transactionId: string; receiptNo: string; paidAt: Date },
): Promise<Delivery> {
  const total = d.entries.reduce((sum, e) => sum + e.amountPaid, 0);
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#64748b;font-size:14px">${label}</td><td style="padding:6px 0;text-align:right;font-size:14px;font-weight:700;color:#0f172a">${escape(value)}</td></tr>`;
  return notify(
    to,
    `Payment received — ${inr(total)} — ${d.tournament.title}`,
    await layout(
      "Payment successful",
      `<h2 style="margin:0 0 4px;font-size:18px;color:#0f172a">${escape(d.tournament.title)}</h2>${tournamentLine(d.tournament)}
       <p>Thank you — we've received the payment for ${escape(d.playerName)}. Registration payment status: <strong style="color:#047857">Paid</strong>.</p>
       <div style="border:1px solid #e2e8f0;border-radius:12px;padding:16px 20px;margin:16px 0">
         <p style="margin:0 0 8px;font-weight:700;color:#0f172a">Payment receipt</p>
         <table style="width:100%;border-collapse:collapse">
           ${row("Receipt no.", d.receiptNo)}${row("Player", d.playerName)}${row("Transaction ID", d.transactionId)}${row("Date & time (IST)", ist(d.paidAt))}
         </table>
         ${entriesTable(d.entries.map((e) => ({ ...e, fee: e.amountPaid })), { showStatus: false })}
         <table style="width:100%;border-collapse:collapse">${row("Amount paid", inr(total))}${row("Status", "Paid")}</table>
       </div>
       ${loginButton()}`,
    ),
  );
}

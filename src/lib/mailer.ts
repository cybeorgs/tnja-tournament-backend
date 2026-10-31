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

/** Email a registration verification code. Without SMTP (outside production) the code is logged instead. */
export async function sendEmailOtp(to: string, otp: string) {
  if (!smtpConfigured()) {
    if (env.isProduction) throw new HttpError(503, "Email verification is not available right now. Please contact the organiser.");
    console.log(`[mailer] SMTP not configured — email OTP for ${to}: ${otp}`);
    return;
  }

  const org = escape((await getSettings()).orgName);
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#334155">
  <div style="padding:40px 16px">
    <div style="max-width:560px;margin:auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0">
      <div style="background:#ff7400;padding:28px 32px;text-align:center">
        <h1 style="color:#fff;margin:0;font-size:20px">${org}</h1>
        <p style="color:#ffe7d4;margin:6px 0 0">Email verification</p>
      </div>
      <div style="padding:32px">
        <p style="line-height:1.6">Use this code to verify your email address for student registration. It expires in <strong>10 minutes</strong>.</p>
        <p style="text-align:center;margin:28px 0;font-size:32px;font-weight:700;letter-spacing:10px;color:#ff7400">${otp}</p>
        <p style="line-height:1.6">If you did not start a registration, you can ignore this email. Never share this code with anyone.</p>
      </div>
      <div style="background:#f1f5f9;padding:16px 32px;text-align:center;color:#64748b;font-size:12px">© ${new Date().getFullYear()} ${org}</div>
    </div>
  </div>
</body>
</html>`;

  try {
    await sendMail({ to, subject: `${otp} is your email verification code`, html });
  } catch (err) {
    console.error("[mailer] Could not send email OTP:", err);
    throw new HttpError(502, "We couldn't send the code to this email address. Check it and try again.");
  }
}

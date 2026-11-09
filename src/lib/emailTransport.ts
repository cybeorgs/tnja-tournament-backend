// How emails physically leave the app: real SMTP (Brevo) or the console. Plus the single retry layer.
//
// Development never emails real people by accident:
//   • EMAIL_TRANSPORT=console|smtp chooses explicitly.
//   • Unset, SMTP is used only for a production deployment (NODE_ENV=production, or PUBLIC_SITE_URL
//     an https address that isn't localhost); anywhere else emails are written to the console.
//   • Even with EMAIL_TRANSPORT=smtp outside production, only addresses in EMAIL_DEV_ALLOWLIST
//     (comma-separated emails or @domains) are really sent to; the rest go to the console.
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env.js";

export type Attachment = { filename: string; content: Buffer; contentType: string };
export type OutgoingMessage = {
  to: string;
  subject: string;
  html: string;
  attachments?: Attachment[];
  /** Our Message-ID (without <>), so the email can be found in the provider's logs */
  messageId: string;
  /** Extra headers, e.g. Brevo tags */
  headers?: Record<string, string>;
};

const smtpConfigured = () => !!(env.smtp.host && env.smtp.user && env.smtp.pass);

/** A real deployment, as opposed to someone's computer. */
export function isProductionDeployment() {
  if (env.isProduction) return true;
  try {
    const url = new URL(env.publicSiteUrl);
    return url.protocol === "https:" && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(url.hostname);
  } catch {
    return false;
  }
}

export type TransportMode = "smtp" | "console";

export function transportMode(): TransportMode {
  const chosen = (process.env.EMAIL_TRANSPORT || "").trim().toLowerCase();
  if (chosen === "console") return "console";
  if (chosen === "smtp") return "smtp";
  return isProductionDeployment() ? "smtp" : "console";
}

const allowlist = () =>
  (process.env.EMAIL_DEV_ALLOWLIST || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Outside production, SMTP only reaches allow-listed test addresses. */
export function devRecipientAllowed(to: string) {
  if (isProductionDeployment()) return true;
  const address = to.trim().toLowerCase();
  return allowlist().some((entry) => (entry.startsWith("@") ? address.endsWith(entry) : address === entry));
}

/** Where this particular message would go. */
export function routeFor(to: string): "smtp" | "console" | "unavailable" {
  if (transportMode() === "console") return "console";
  if (!smtpConfigured()) return isProductionDeployment() ? "unavailable" : "console";
  return devRecipientAllowed(to) ? "smtp" : "console";
}

/**
 * Startup check, logged once. Problems are reported, not fatal: a mail misconfiguration mustn't take
 * registrations, payments and logins down with it.
 */
export function checkMailSetup() {
  const mode = transportMode();
  const production = isProductionDeployment();
  const brevo = /brevo|sendinblue/i.test(env.smtp.host);
  console.log(`[mailer] Email transport: ${mode.toUpperCase()} (${production ? "production deployment" : "development"})`);
  if (mode === "smtp" && !smtpConfigured()) {
    console.error(production
      ? "[mailer] EMAIL TRANSPORT IS SMTP BUT SMTP_HOST/SMTP_USER/SMTP_PASS ARE NOT SET — emails cannot be sent."
      : "[mailer] SMTP is not configured — emails are written to this log instead.");
  }
  if (!production && smtpConfigured()) {
    if (mode === "console") {
      console.warn(`[mailer] SMTP credentials${brevo ? " for Brevo" : ""} are set in a development environment but not used (emails go to the console). Remove them from this .env so production credentials don't live on development machines.`);
    } else if (!allowlist().length) {
      console.warn("[mailer] EMAIL_TRANSPORT=smtp in development, but EMAIL_DEV_ALLOWLIST is empty: every email goes to the console.");
    } else {
      console.warn(`[mailer] EMAIL_TRANSPORT=smtp in development: only ${allowlist().join(", ")} will really be emailed.`);
    }
  }
  if (mode === "smtp" && smtpConfigured() && (!process.env.SMTP_FROM_EMAIL || /@smtp-brevo\.com$/i.test(env.smtp.fromEmail))) {
    console.warn("[mailer] SMTP_FROM_EMAIL is not a real sender address (it falls back to the SMTP login). Set it to a sender verified in Brevo (Senders & domains), or emails may never arrive.");
  }
}

// ─── Sending, with the one retry layer ───────────────────────────────────────

export type SmtpError = Error & { code?: string; responseCode?: number; command?: string };

/**
 * What a failed SMTP attempt means:
 *   RECIPIENT_REJECTED  the server refused this address (550/551/553): suppress, never retry
 *   RETRYABLE           the message was NOT accepted and may be tried again (server said 4xx, or the
 *                       connection failed before the message was handed over)
 *   UNCERTAIN           the connection was lost while/after handing the message over: the provider may
 *                       have accepted (and will deliver) it, so retrying could send it twice — don't
 *   FAILED              permanent for this message (other 5xx, bad login, message too large…)
 */
export type FailureKind = "RECIPIENT_REJECTED" | "RETRYABLE" | "UNCERTAIN" | "FAILED";

// SMTP stages before the message body is sent: a failure here means nothing was handed over.
const BEFORE_DATA = /^(CONN|EHLO|HELO|LHLO|STARTTLS|AUTH|MAIL FROM|RCPT TO)/i;
const CONNECTION_NEVER_MADE = new Set(["ECONNECTION", "EDNS", "ECONNREFUSED", "ENOTFOUND"]);

export function classifySmtpError(err: SmtpError): FailureKind {
  if (err.code === "EENVELOPE" && [550, 551, 553].includes(err.responseCode ?? 0)) return "RECIPIENT_REJECTED";
  // The server answered: it decided, and nothing was accepted.
  if (err.responseCode && err.responseCode >= 400 && err.responseCode < 500) return "RETRYABLE";
  if (err.responseCode && err.responseCode >= 500) return "FAILED";
  // No answer from the server.
  if (CONNECTION_NEVER_MADE.has(err.code ?? "")) return "RETRYABLE";
  if (err.command && BEFORE_DATA.test(err.command)) return "RETRYABLE";
  if (["ETIMEDOUT", "ESOCKET", "ECONNRESET", "ESTREAM"].includes(err.code ?? "")) return "UNCERTAIN";
  return "FAILED";
}

export type AttemptOutcome =
  | { ok: true; providerMessageId: string; attempts: number }
  | { ok: false; kind: FailureKind; error: SmtpError; attempts: number };

/** At most 2 retries for RETRYABLE failures, waiting 1 s then 2 s (exponential backoff, a little jitter). */
export const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;

export async function sendWithRetry(
  send: () => Promise<{ messageId?: string }>,
  { sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)), onRetry }: { sleep?: (ms: number) => Promise<unknown>; onRetry?: (attempt: number, err: SmtpError) => void } = {},
): Promise<AttemptOutcome> {
  for (let attempt = 1; ; attempt++) {
    try {
      const info = await send();
      return { ok: true, providerMessageId: String(info.messageId ?? ""), attempts: attempt };
    } catch (raw) {
      const err = raw as SmtpError;
      const kind = classifySmtpError(err);
      if (kind !== "RETRYABLE" || attempt > MAX_RETRIES) return { ok: false, kind, error: err, attempts: attempt };
      onRetry?.(attempt, err);
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    }
  }
}

let transporter: Transporter | null = null;
/** Tests replace the SMTP transport with a fake. */
let override: ((m: OutgoingMessage) => Promise<{ messageId?: string }>) | null = null;
export function setTransportForTests(fn: typeof override) {
  override = fn;
}

/** Hands the message to the SMTP server once (no retry here). */
export async function smtpSendOnce(message: OutgoingMessage, fromName: string): Promise<{ messageId?: string }> {
  if (override) return override(message);
  transporter ??= nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.port === 465, // 465 is implicit TLS; others (e.g. 587) use STARTTLS
    requireTLS: env.smtp.port !== 465,
    auth: { user: env.smtp.user, pass: env.smtp.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return transporter.sendMail({
    from: `"${fromName}" <${env.smtp.fromEmail}>`,
    to: message.to,
    subject: message.subject,
    html: message.html,
    attachments: message.attachments,
    messageId: `<${message.messageId}>`,
    headers: message.headers,
  });
}

/** Domain for our Message-IDs: the sender's domain. */
export const messageIdDomain = () => env.smtp.fromEmail.split("@")[1] || "tnja-tournament.local";

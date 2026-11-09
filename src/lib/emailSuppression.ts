// Addresses we must not email again: hard bounces, blocked or invalid recipients, spam complaints and
// unsubscribes. Every send checks this first (see mailer.ts), so a dead address stops costing credits.
import prisma from "../db.js";
import { emailProblem, normaliseEmail } from "./emailAddress.js";

export type SuppressionReason = "HARD_BOUNCE" | "BLOCKED" | "INVALID" | "SPAM" | "UNSUBSCRIBED";
export type SuppressionSource = "SMTP" | "BREVO_WEBHOOK" | "ADMIN";

// Brevo transactional email webhook events (developers.brevo.com → Transactional webhooks) that mean
// "don't email this address again". Everything else is ignored:
//   • soft_bounce, deferred: temporary — Brevo retries those itself
//   • error: a sending error on Brevo's side, not a fact about the recipient
//   • request, delivered, opened, unique_opened, click, proxy_open, unique_proxy_open: not failures
const BREVO_SUPPRESS: Record<string, SuppressionReason> = {
  hard_bounce: "HARD_BOUNCE",
  blocked: "BLOCKED",
  invalid_email: "INVALID",
  spam: "SPAM",
  unsubscribed: "UNSUBSCRIBED",
};

/** What one Brevo webhook payload means for the suppression list, or null if nothing. */
export function brevoSuppression(payload: unknown): { email: string; reason: SuppressionReason; detail: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const reason = typeof p.event === "string" ? BREVO_SUPPRESS[p.event] : undefined;
  // Some events (e.g. unique_proxy_open) can arrive with an empty email.
  const email = typeof p.email === "string" ? normaliseEmail(p.email) : "";
  if (!reason || emailProblem(email)) return null;
  const detail = [
    p.event,
    typeof p.reason === "string" && p.reason ? `reason: ${p.reason}` : "",
    typeof p["message-id"] === "string" ? `message-id: ${p["message-id"]}` : "",
    typeof p.date === "string" ? `date: ${p.date}` : "",
  ].filter(Boolean).join("; ");
  return { email, reason, detail };
}

const REASON_TEXT: Record<string, string> = {
  HARD_BOUNCE: "earlier emails to it bounced",
  BLOCKED: "the email provider blocked earlier emails to it",
  INVALID: "it was reported as not existing",
  SPAM: "earlier emails were reported as spam",
  UNSUBSCRIBED: "it unsubscribed from our emails",
};

/** The suppression entry for this address, or null if it may be emailed. */
export async function suppressionOf(email: string) {
  return prisma.emailSuppression.findUnique({ where: { email: normaliseEmail(email) } });
}

/** Why we won't email this address, worded for the user. */
export const suppressionText = (reason: string) => REASON_TEXT[reason] ?? "earlier emails to it could not be delivered";

export async function suppress(email: string, reason: SuppressionReason, source: SuppressionSource, detail = "") {
  const address = normaliseEmail(email);
  await prisma.emailSuppression.upsert({
    where: { email: address },
    create: { email: address, reason, source, detail: detail.slice(0, 500) },
    update: { reason, source, detail: detail.slice(0, 500) },
  });
  console.warn(`[mailer] Suppressed ${address}: ${reason} (${source})`);
}

/** Take an address off the list, e.g. after the person fixed their mailbox. */
export async function unsuppress(email: string) {
  await prisma.emailSuppression.deleteMany({ where: { email: normaliseEmail(email) } });
}

// The one door every email goes through. For each logical email it:
//   1. records it in EmailMessage (the audit log) under its idempotency key — a second request for
//      the same email (double click, retry, another server process) finds the row and sends nothing;
//   2. skips addresses on the suppression list;
//   3. takes one email from the category's daily budget (over budget → HELD, visible to admins,
//      who can allow more and send the held ones; nothing is dropped silently);
//   4. hands it to SMTP (one retry layer, see emailTransport.ts) or the console in development;
//   5. records the outcome: SENT, FAILED, SUPPRESSED, HELD, UNCERTAIN or LOGGED.
//
// Never stored: the email body, OTP codes, passwords or reset links.
// If the database can't record the email, it is not sent (no unaudited, unbudgeted email).
import { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { env } from "../config/env.js";
import { getSettings } from "./helpers.js";
import { normaliseEmail } from "./emailAddress.js";
import { suppress, suppressionOf } from "./emailSuppression.js";
import { budgetDay, releaseEmail, reserveEmail, type EmailCategory } from "./emailBudget.js";
import { isProductionDeployment, messageIdDomain, routeFor, sendWithRetry, smtpSendOnce, type Attachment } from "./emailTransport.js";

export type EmailKind = "OTP" | "REGISTRATION_INCOMPLETE" | "REGISTRATION_SUCCESS" | "APPLICATION_RECEIVED" | "REGISTRATION_APPROVED" | "PASSWORD_RESET" | "ENTRY_PASS" | "UNPAID_NOTICE";
export type EmailTrigger = "SELF" | "ADMIN" | "IMPORT" | "PAYMENT" | "SYSTEM";

export const CATEGORY_OF: Record<EmailKind, EmailCategory> = {
  OTP: "OTP",
  REGISTRATION_INCOMPLETE: "REGISTRATION",
  REGISTRATION_SUCCESS: "REGISTRATION",
  APPLICATION_RECEIVED: "REGISTRATION",
  REGISTRATION_APPROVED: "ADMIN",
  PASSWORD_RESET: "PASSWORD_RESET",
  ENTRY_PASS: "ENTRY_PASS",
  // Sent in bulk by an admin; not held over the daily limit (a late deadline notice would be wrong), so
  // anything over the limit is reported back as not sent and can be sent again another day.
  UNPAID_NOTICE: "ADMIN",
};

/** Who/what caused an email, and what it's about (for the audit log and the duplicate guard). */
export type EmailContext = {
  trigger: EmailTrigger;
  /** Admin username or the player's email */
  actor?: string;
  studentId?: string | null;
  tournamentId?: string | null;
  registrationIds?: string[];
  /** One per logical email; null/undefined = this email may legitimately repeat (e.g. password reset) */
  idempotencyKey?: string | null;
};

export type DeliveryStatus = "SENT" | "LOGGED" | "NOT_CONFIGURED" | "FAILED" | "SUPPRESSED" | "HELD" | "LIMITED" | "UNCERTAIN" | "DUPLICATE";
export type Delivery = { to: string; subject: string; status: DeliveryStatus; error: string; id?: string };

/**
 * Over the daily limit, these are HELD for an admin to release. Codes and reset links are only useful
 * right away, so those are LIMITED instead: the person is told to try later, and nothing is queued.
 */
export const HOLDABLE_KINDS: EmailKind[] = ["REGISTRATION_INCOMPLETE", "REGISTRATION_SUCCESS", "APPLICATION_RECEIVED", "REGISTRATION_APPROVED", "ENTRY_PASS"];

/** Statuses after which the same logical email may be attempted again (by a later trigger or an admin). */
export const RETRYABLE_STATUSES = ["FAILED", "HELD", "LIMITED", "SUPPRESSED"];
const RETRYABLE = RETRYABLE_STATUSES;

type Claimed = { id: string; attempts: number } | { duplicate: { id: string; status: string } };

async function claim(data: Omit<Prisma.EmailMessageUncheckedCreateInput, "status" | "attempts">): Promise<Claimed> {
  if (!data.idempotencyKey) return prisma.emailMessage.create({ data: { ...data, status: "SENDING" }, select: { id: true, attempts: true } });
  try {
    return await prisma.emailMessage.create({ data: { ...data, status: "SENDING" }, select: { id: true, attempts: true } });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
    const existing = await prisma.emailMessage.findUnique({ where: { idempotencyKey: data.idempotencyKey }, select: { id: true, status: true, attempts: true } });
    if (!existing) throw err;
    // Only one caller can move a retryable email back to SENDING.
    const taken = await prisma.emailMessage.updateMany({
      where: { id: existing.id, status: { in: RETRYABLE } },
      data: { status: "SENDING", toEmail: data.toEmail, subject: data.subject, error: "", trigger: data.trigger, actor: data.actor ?? "" },
    });
    return taken.count ? { id: existing.id, attempts: existing.attempts } : { duplicate: existing };
  }
}

async function finish(id: string, data: Prisma.EmailMessageUpdateInput) {
  try {
    await prisma.emailMessage.update({ where: { id }, data });
  } catch (err) {
    // The email's fate is already decided; a stuck SENDING row is treated as "may have been sent".
    console.error(`[email] Couldn't record the outcome of email ${id}:`, (err as Error).message);
  }
}

const textOf = (html: string) => html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

export async function deliverEmail(input: {
  kind: EmailKind;
  to: string;
  /** The subject as sent */
  subject: string;
  /** The subject as recorded/logged, when the real one holds a secret (the OTP subject holds the code) */
  auditSubject?: string;
  html: string;
  attachments?: Attachment[];
  context: EmailContext;
}): Promise<Delivery> {
  const to = normaliseEmail(input.to);
  const category = CATEGORY_OF[input.kind];
  const shownSubject = input.auditSubject ?? input.subject;
  const result = (status: DeliveryStatus, error = "", id?: string): Delivery => ({ to, subject: shownSubject, status, error, id });

  // 1. Record it (and claim its idempotency key).
  let claimed: Claimed;
  try {
    claimed = await claim({
      idempotencyKey: input.context.idempotencyKey || null,
      kind: input.kind,
      category,
      trigger: input.context.trigger,
      actor: input.context.actor ?? "",
      toEmail: to,
      subject: shownSubject,
      studentId: input.context.studentId ?? null,
      tournamentId: input.context.tournamentId ?? null,
      registrationIds: input.context.registrationIds ?? [],
    });
  } catch (err) {
    console.error(`[email] Not sent — couldn't record "${shownSubject}" to ${to}:`, (err as Error).message);
    return result("FAILED", "The email could not be recorded, so it was not sent.");
  }
  if ("duplicate" in claimed) {
    console.log(`[email] Duplicate of ${claimed.duplicate.id} (${claimed.duplicate.status}) — "${shownSubject}" to ${to} not sent again`);
    return result("DUPLICATE", "", claimed.duplicate.id);
  }
  const id = claimed.id;

  // 2. Console (development) or nowhere (production without SMTP)?
  const route = routeFor(to);
  if (route === "console") {
    // Development only shows the body (it's how OTPs are tested locally); production never logs it.
    const body = isProductionDeployment() ? "" : `\n${textOf(input.html)}`;
    console.log(`[email:console] ${input.kind} to ${to}: ${isProductionDeployment() ? shownSubject : input.subject}${body}`);
    await finish(id, { status: "LOGGED", sentAt: new Date() });
    return result("LOGGED", "", id);
  }
  if (route === "unavailable") {
    await finish(id, { status: "FAILED", error: "SMTP is not configured on the server" });
    return result("NOT_CONFIGURED", "SMTP is not configured on the server", id);
  }

  // 3. Suppressed address?
  try {
    const suppressed = await suppressionOf(to);
    if (suppressed) {
      await finish(id, { status: "SUPPRESSED", error: `Address suppressed (${suppressed.reason})` });
      return result("SUPPRESSED", suppressed.reason, id);
    }
  } catch (err) {
    console.error("[email] Suppression check failed, not sending:", (err as Error).message);
    await finish(id, { status: "FAILED", error: "Suppression check failed" });
    return result("FAILED", "Suppression check failed", id);
  }

  // 4. Daily budget.
  const day = budgetDay();
  try {
    if (!(await reserveEmail(category, day))) {
      const status = HOLDABLE_KINDS.includes(input.kind) ? "HELD" : "LIMITED";
      console.warn(`[email] Daily ${category} limit reached — "${shownSubject}" to ${to} ${status === "HELD" ? "is HELD for an admin to release" : "was not sent (the user is told to try later)"}`);
      await finish(id, { status, error: `Daily ${category} email limit reached` });
      return result(status, `Daily ${category} email limit reached`, id);
    }
  } catch (err) {
    console.error("[email] Budget check failed, not sending:", (err as Error).message);
    await finish(id, { status: "FAILED", error: "Budget check failed" });
    return result("FAILED", "Budget check failed", id);
  }

  // 5. Send (one retry layer, inside sendWithRetry).
  const messageId = `${id}@${messageIdDomain()}`;
  const fromName = env.smtp.fromName || (await getSettings()).orgName;
  const outcome = await sendWithRetry(
    () => smtpSendOnce({
      to, subject: input.subject, html: input.html, attachments: input.attachments, messageId,
      // Brevo tags these, so its logs show which app and which email each message was.
      headers: { "X-Mailin-Tag": "tnja-tournament", "X-Mailin-custom": `tnja-tournament|${input.kind}|${id}` },
    }, fromName),
    { onRetry: (attempt, err) => console.warn(`[email] Temporary failure sending ${input.kind} to ${to} (${err.code ?? err.responseCode}); retry ${attempt}`) },
  );
  const attempts = { increment: outcome.attempts };

  if (outcome.ok) {
    await finish(id, { status: "SENT", messageId, sentAt: new Date(), attempts, error: "" });
    return result("SENT", "", id);
  }
  const reason = `${outcome.error.code ?? ""} ${outcome.error.responseCode ?? ""} ${outcome.error.message}`.trim().slice(0, 500);
  if (outcome.kind === "UNCERTAIN") {
    // Possibly delivered: not retried, and its credit stays counted.
    console.warn(`[email] Connection lost after handing over ${input.kind} to ${to}; it may have been delivered, so it is not retried (${reason})`);
    await finish(id, { status: "UNCERTAIN", messageId, attempts, error: reason });
    return result("UNCERTAIN", reason, id);
  }
  // Refused before acceptance: no credit used.
  await releaseEmail(category, day).catch(() => {});
  if (outcome.kind === "RECIPIENT_REJECTED") {
    await suppress(to, outcome.error.responseCode === 550 ? "HARD_BOUNCE" : "INVALID", "SMTP", outcome.error.message).catch(() => {});
    await finish(id, { status: "SUPPRESSED", attempts, error: reason });
    return result("SUPPRESSED", reason, id);
  }
  console.error(`[email] Could not send ${input.kind} to ${to}: ${reason}`);
  await finish(id, { status: "FAILED", attempts, error: reason });
  return result("FAILED", reason, id);
}

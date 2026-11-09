// Database-backed tests for the email service (audit log, duplicate guard, budgets, failures).
// They need the local development database (DATABASE_URL) and are skipped when it's unreachable.
// Nothing can leave the machine: SMTP points at an unreachable address AND a fake transport is installed,
// and every recipient is on the reserved .test domain.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import prisma from "../db.js";
import { env } from "../config/env.js";
import { setTransportForTests, type OutgoingMessage, type SmtpError } from "./emailTransport.js";
import { deliverEmail, type EmailKind } from "./emailService.js";
import { budgetDay } from "./emailBudget.js";

const dbUp = await prisma.$queryRaw`SELECT 1`.then(() => true, () => false);

const run = randomUUID().slice(0, 8);
const addr = (tag: string) => `t-${run}-${tag}@example.test`;
const sent: OutgoingMessage[] = [];
let behaviour: (m: OutgoingMessage) => Promise<{ messageId?: string }> = async () => ({ messageId: "<fake>" });
const smtpError = (props: Partial<SmtpError>) => Object.assign(new Error("simulated"), props) as SmtpError;

const saved = { smtp: { ...env.smtp }, transport: process.env.EMAIL_TRANSPORT, allow: process.env.EMAIL_DEV_ALLOWLIST };
let usageBefore: { day: string; category: string; sent: number; extraAllowance: number; extraGrantedBy: string }[] = [];

describe("email service (database)", { skip: !dbUp && "local database not reachable" }, () => {
  before(async () => {
    env.smtp = { ...env.smtp, host: "127.0.0.1", port: 1, user: "test", pass: "test", fromEmail: "noreply@tnja.test" };
    process.env.EMAIL_TRANSPORT = "smtp";
    process.env.EMAIL_DEV_ALLOWLIST = "@example.test";
    setTransportForTests(async (m) => { sent.push(m); return behaviour(m); });
    usageBefore = await prisma.emailDailyUsage.findMany({ where: { day: budgetDay() } });
  });

  after(async () => {
    setTransportForTests(null);
    env.smtp = saved.smtp;
    if (saved.transport === undefined) delete process.env.EMAIL_TRANSPORT; else process.env.EMAIL_TRANSPORT = saved.transport;
    if (saved.allow === undefined) delete process.env.EMAIL_DEV_ALLOWLIST; else process.env.EMAIL_DEV_ALLOWLIST = saved.allow;
    delete process.env.EMAIL_DAILY_LIMIT_ENTRY_PASS;
    // Leave the development database as we found it.
    await prisma.emailMessage.deleteMany({ where: { toEmail: { startsWith: `t-${run}-` } } });
    await prisma.emailSuppression.deleteMany({ where: { email: { startsWith: `t-${run}-` } } });
    const day = budgetDay();
    await prisma.emailDailyUsage.deleteMany({ where: { day } });
    if (usageBefore.length) await prisma.emailDailyUsage.createMany({ data: usageBefore.map(({ day, category, sent, extraAllowance, extraGrantedBy }) => ({ day, category, sent, extraAllowance, extraGrantedBy })) });
  });

  const email = (kind: EmailKind, to: string, key?: string, subject = `Test ${kind}`) =>
    deliverEmail({ kind, to, subject, html: "<p>test</p>", context: { trigger: "SYSTEM", actor: "test", idempotencyKey: key } });

  it("records an audit row for every email type, with the right budget category", async () => {
    behaviour = async () => ({ messageId: "<fake>" });
    const kinds: [EmailKind, string][] = [
      ["OTP", "OTP"], ["REGISTRATION_SUCCESS", "REGISTRATION"], ["APPLICATION_RECEIVED", "REGISTRATION"],
      ["REGISTRATION_APPROVED", "ADMIN"], ["PASSWORD_RESET", "PASSWORD_RESET"], ["ENTRY_PASS", "ENTRY_PASS"],
    ];
    for (const [kind, category] of kinds) {
      const d = await email(kind, addr(`audit-${kind}`), `test:${run}:audit:${kind}`);
      assert.equal(d.status, "SENT", kind);
      const row = await prisma.emailMessage.findUnique({ where: { id: d.id! } });
      assert.equal(row?.kind, kind);
      assert.equal(row?.category, category);
      assert.equal(row?.status, "SENT");
      assert.equal(row?.trigger, "SYSTEM");
      assert.equal(row?.attempts, 1);
      assert.match(row!.messageId, new RegExp(`^${row!.id}@tnja\\.test$`));
      assert.ok(row?.sentAt);
    }
  });

  it("never stores or logs the OTP code (the audit keeps a neutral subject)", async () => {
    const d = await deliverEmail({
      kind: "OTP", to: addr("otp-secret"), subject: "482913 is your email verification code", auditSubject: "Email verification code",
      html: "<p>482913</p>", context: { trigger: "SELF", idempotencyKey: `test:${run}:otp-secret` },
    });
    const row = await prisma.emailMessage.findUnique({ where: { id: d.id! } });
    assert.equal(row?.subject, "Email verification code");
    assert.ok(!JSON.stringify(row).includes("482913"));
  });

  it("sends one email when the same logical email is requested many times at once", async () => {
    sent.length = 0;
    behaviour = async () => { await new Promise((r) => setTimeout(r, 50)); return { messageId: "<fake>" }; };
    const to = addr("dup");
    const results = await Promise.all(Array.from({ length: 6 }, () => email("REGISTRATION_SUCCESS", to, `test:${run}:dup`)));
    assert.equal(sent.filter((m) => m.to === to).length, 1, "exactly one SMTP send");
    assert.equal(results.filter((r) => r.status === "SENT").length, 1);
    assert.equal(results.filter((r) => r.status === "DUPLICATE").length, 5);
    // And later, too.
    assert.equal((await email("REGISTRATION_SUCCESS", to, `test:${run}:dup`)).status, "DUPLICATE");
    assert.equal(await prisma.emailMessage.count({ where: { toEmail: to } }), 1);
  });

  it("retries a temporary SMTP failure once more and records 2 attempts", async () => {
    let calls = 0;
    behaviour = async () => { if (++calls === 1) throw smtpError({ responseCode: 421, command: "MAIL FROM" }); return { messageId: "<fake>" }; };
    const d = await email("ENTRY_PASS", addr("temp"), `test:${run}:temp`);
    assert.equal(d.status, "SENT");
    assert.equal(calls, 2);
    assert.equal((await prisma.emailMessage.findUnique({ where: { id: d.id! } }))?.attempts, 2);
  });

  it("suppresses a hard-bounced address after one attempt, and never sends to it again", async () => {
    let calls = 0;
    behaviour = async () => { calls++; throw smtpError({ code: "EENVELOPE", responseCode: 550, command: "RCPT TO", message: "550 mailbox unavailable" }); };
    const to = addr("bounce");
    const d = await email("REGISTRATION_SUCCESS", to, `test:${run}:bounce`);
    assert.equal(d.status, "SUPPRESSED");
    assert.equal(calls, 1);
    assert.equal((await prisma.emailSuppression.findUnique({ where: { email: to } }))?.reason, "HARD_BOUNCE");
    behaviour = async () => { calls++; return { messageId: "<fake>" }; };
    assert.equal((await email("ENTRY_PASS", to, `test:${run}:bounce-2`)).status, "SUPPRESSED");
    assert.equal(calls, 1, "nothing handed to SMTP for a suppressed address");
  });

  it("does not resend when the connection was lost after the provider may have accepted the email", async () => {
    let calls = 0;
    behaviour = async () => { calls++; throw smtpError({ code: "ETIMEDOUT", command: "DATA" }); };
    const d = await email("REGISTRATION_SUCCESS", addr("uncertain"), `test:${run}:uncertain`);
    assert.equal(d.status, "UNCERTAIN");
    assert.equal(calls, 1, "no retry");
    behaviour = async () => { calls++; return { messageId: "<fake>" }; };
    assert.equal((await email("REGISTRATION_SUCCESS", addr("uncertain"), `test:${run}:uncertain`)).status, "DUPLICATE");
    assert.equal(calls, 1, "a later request doesn't resend it either");
  });

  it("records a permanent failure, and a later trigger may try again", async () => {
    behaviour = async () => { throw smtpError({ responseCode: 552, command: "DATA" }); };
    const first = await email("ENTRY_PASS", addr("perm"), `test:${run}:perm`);
    assert.equal(first.status, "FAILED");
    behaviour = async () => ({ messageId: "<fake>" });
    const second = await email("ENTRY_PASS", addr("perm"), `test:${run}:perm`);
    assert.equal(second.status, "SENT");
    assert.equal(second.id, first.id, "same audit row, not a second email record");
  });

  it("enforces the daily limit atomically under concurrent sends, holds the rest, and sends more only when .env allows", async () => {
    behaviour = async () => { await new Promise((r) => setTimeout(r, 20)); return { messageId: "<fake>" }; };
    const used = (await prisma.emailDailyUsage.findUnique({ where: { day_category: { day: budgetDay(), category: "ENTRY_PASS" } } }))?.sent ?? 0;
    process.env.EMAIL_DAILY_LIMIT_ENTRY_PASS = String(used + 2); // room for exactly 2 more
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => email("ENTRY_PASS", addr(`budget-${i}`), `test:${run}:budget:${i}`)));
    assert.equal(results.filter((r) => r.status === "SENT").length, 2, "exactly the limit");
    const held = results.filter((r) => r.status === "HELD");
    assert.equal(held.length, 6, "the rest are held, not dropped");

    // Only raising the limit (in .env) lets more through.
    process.env.EMAIL_DAILY_LIMIT_ENTRY_PASS = String(used + 3);
    const i = results.findIndex((r) => r.status === "HELD");
    const released = await email("ENTRY_PASS", addr(`budget-${i}`), `test:${run}:budget:${i}`);
    assert.equal(released.status, "SENT", "one more after the limit is raised");
    const j = results.findIndex((r, k) => r.status === "HELD" && k !== i);
    assert.equal((await email("ENTRY_PASS", addr(`budget-${j}`), `test:${run}:budget:${j}`)).status, "HELD", "and no more than that");
  });

  it("over the limit, OTPs are refused (LIMITED) rather than queued", async () => {
    const used = (await prisma.emailDailyUsage.findUnique({ where: { day_category: { day: budgetDay(), category: "OTP" } } }))?.sent ?? 0;
    process.env.EMAIL_DAILY_LIMIT_OTP = String(used);
    try {
      assert.equal((await email("OTP", addr("otp-limit"), `test:${run}:otp-limit`)).status, "LIMITED");
    } finally {
      delete process.env.EMAIL_DAILY_LIMIT_OTP;
    }
  });

  it("in development without an explicit opt-in, emails go to the console (nothing sent)", async () => {
    sent.length = 0;
    process.env.EMAIL_TRANSPORT = "console";
    try {
      const d = await email("REGISTRATION_SUCCESS", addr("console"), `test:${run}:console`);
      assert.equal(d.status, "LOGGED");
      assert.equal(sent.length, 0);
    } finally {
      process.env.EMAIL_TRANSPORT = "smtp";
    }
  });
});

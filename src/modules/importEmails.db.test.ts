// End-to-end test of Admin → Students → Import and its email protection, through the real HTTP route
// and import job, against the local development database (skipped when it's unreachable).
// Nothing can leave the machine: SMTP points at an unreachable address and a fake transport is installed.
// Test students are deleted afterwards; their entries in the append-only student history stay (by design).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "crypto";
import type { AddressInfo } from "net";
import type { Server } from "http";
import jwt from "jsonwebtoken";
import prisma from "../db.js";
import { env } from "../config/env.js";
import { createApp } from "../app.js";
import { setTransportForTests, type OutgoingMessage } from "../lib/emailTransport.js";

const dbUp = await prisma.$queryRaw`SELECT 1`.then(() => true, () => false);
const run = randomUUID().slice(0, 8);
const domain = `tnja-import-${run}.example-test.com`; // never really emailed: see the safeguards above
const sent: OutgoingMessage[] = [];
let server: Server;
let base = "";
const token = jwt.sign({ adminId: `test-${run}`, username: "test-admin" }, env.jwtSecret, { expiresIn: "10m" });
const saved = { smtp: { ...env.smtp }, transport: process.env.EMAIL_TRANSPORT, allow: process.env.EMAIL_DEV_ALLOWLIST };

const HEADERS = ["Full Name", "Gender", "Date of Birth", "Father's Name", "Mother's Name", "Blood Group", "Aadhaar Number", "Mobile Number", "Email",
  "District", "Taluk", "Address", "City", "State", "Pincode", "Annual Income", "Institution Type", "Institution Name", "Standard / Year"];
const csv = (names: string[]) =>
  [HEADERS.join(","), ...names.map((n) => [
    `Test ${n}`, "Male", "15-06-2010", "Kumar S", "Lakshmi K", "O+ve", `9${String(randomInt(0, 1e11)).padStart(11, "0")}`, "9876543210",
    `${n.toLowerCase()}-${run}@${domain}`, "Chennai", "Egmore", "12 Anna Salai", "Chennai", "Tamil Nadu", "600008", "150000", "School", "Govt School", "10th",
  ].join(","))].join("\n");

async function runImport(file: string, query: string) {
  const res = await fetch(`${base}/api/students/import${query}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "X-Filename": "test.csv" }, body: file,
  });
  const body = await res.json() as { jobId?: string; error?: string };
  if (!body.jobId) return { status: res.status, error: body.error };
  for (;;) {
    const job = await (await fetch(`${base}/api/students/import/jobs/${body.jobId}`, { headers: { Authorization: `Bearer ${token}` } })).json() as { status: string; result: Record<string, unknown>; error: string | null };
    if (job.status !== "RUNNING") return { status: res.status, job };
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("bulk import email protection (database, HTTP)", { skip: !dbUp && "local database not reachable" }, () => {
  before(async () => {
    env.smtp = { ...env.smtp, host: "127.0.0.1", port: 1, user: "test", pass: "test", fromEmail: "noreply@tnja.test" };
    process.env.EMAIL_TRANSPORT = "smtp";
    process.env.EMAIL_DEV_ALLOWLIST = `@${domain}`;
    setTransportForTests(async (m) => { sent.push(m); return { messageId: "<fake>" }; });
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    setTransportForTests(null);
    env.smtp = saved.smtp;
    if (saved.transport === undefined) delete process.env.EMAIL_TRANSPORT; else process.env.EMAIL_TRANSPORT = saved.transport;
    if (saved.allow === undefined) delete process.env.EMAIL_DEV_ALLOWLIST; else process.env.EMAIL_DEV_ALLOWLIST = saved.allow;
    const ids = (await prisma.student.findMany({ where: { email: { endsWith: `@${domain}` } }, select: { id: true } })).map((s) => s.id);
    await prisma.emailMessage.deleteMany({ where: { toEmail: { endsWith: `@${domain}` } } });
    await prisma.student.deleteMany({ where: { id: { in: ids } } });
    await prisma.studentAccount.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
  });

  it("imports without emails by default, and records that emails were off", async () => {
    sent.length = 0;
    const { job } = await runImport(csv(["OffA", "OffB"]), "");
    assert.equal(job?.status, "DONE", JSON.stringify(job));
    assert.equal(job!.result.created, 2);
    assert.equal(job!.result.emailsEnabled, false);
    assert.equal(sent.length, 0, "no email");
    const student = await prisma.student.findFirst({ where: { email: `offa-${run}@${domain}` } });
    const history = await prisma.studentAuditLog.findFirst({ where: { studentId: student!.id, action: "CREATED" } });
    assert.match(history!.note, /registration email OFF/);
  });

  it("refuses to import with emails on unless the number of emails was confirmed", async () => {
    const r = await runImport(csv(["NoConfirm"]), "?sendEmails=1");
    assert.equal(r.status, 400);
    assert.match(r.error ?? "", /Confirm how many/);
    assert.equal(await prisma.student.count({ where: { email: `noconfirm-${run}@${domain}` } }), 0, "nothing imported");
  });

  it("sends nothing when more emails would go out than the admin confirmed", async () => {
    sent.length = 0;
    const { job } = await runImport(csv(["OverA", "OverB"]), "?sendEmails=1&confirmEmails=1");
    assert.equal(job!.result.created, 2);
    assert.equal(job!.result.emailsBlocked, 2);
    assert.equal(sent.length, 0);
  });

  it("with explicit confirmation, emails each new student exactly once (audited, by the admin)", async () => {
    sent.length = 0;
    const file = csv(["MailA", "MailB"]);
    const { job } = await runImport(file, "?sendEmails=1&confirmEmails=2");
    assert.equal(job!.result.created, 2);
    assert.equal(job!.result.emailsSent, 2);
    assert.equal(sent.length, 2);
    const rows = await prisma.emailMessage.findMany({ where: { toEmail: { in: [`maila-${run}@${domain}`, `mailb-${run}@${domain}`] } } });
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.kind, "REGISTRATION_SUCCESS");
      assert.equal(row.trigger, "IMPORT");
      assert.equal(row.actor, "test-admin");
      assert.equal(row.status, "SENT");
      assert.ok(row.studentId);
    }
    // The same file again: the Aadhaar numbers already exist, so nobody is created or emailed twice.
    sent.length = 0;
    const again = await runImport(file, "?sendEmails=1&confirmEmails=2");
    assert.equal(again.job!.result.created, 0);
    assert.equal(sent.length, 0);
  });
});

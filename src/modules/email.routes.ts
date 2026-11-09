// Admin → Emails: what the app has sent, today's budgets, held emails, and the suppression list.
// Every action here is recorded with the admin's username.
import { Router } from "express";
import { z } from "zod";
import prisma from "../db.js";
import { HttpError } from "../middleware/errors.js";
import { EMAIL_CATEGORIES, allowExtraToday, budgetToday } from "../lib/emailBudget.js";
import { HOLDABLE_KINDS } from "../lib/emailService.js";
import { isProductionDeployment, transportMode } from "../lib/emailTransport.js";
import { normaliseEmail } from "../lib/emailAddress.js";
import { unsuppress } from "../lib/emailSuppression.js";
import { emailApproval, emailRegistration } from "../lib/registrationEmails.js";
import { sendEntryPassesIfReady } from "../lib/entryPass.js";

const router = Router();
const adminName = (req: { admin?: { username?: string } }) => req.admin?.username || "admin";

/** Today's budgets, the transport in use, and how many emails are waiting to be released. */
router.get("/overview", async (_req, res) => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [budgets, held, byStatus] = await Promise.all([
    budgetToday(),
    prisma.emailMessage.count({ where: { status: "HELD", kind: { in: HOLDABLE_KINDS } } }),
    prisma.emailMessage.groupBy({ by: ["category", "status"], where: { createdAt: { gt: since } }, _count: { _all: true } }),
  ]);
  res.json({
    transport: transportMode(),
    productionDeployment: isProductionDeployment(),
    budgets,
    held,
    last30Days: byStatus.map((r) => ({ category: r.category, status: r.status, count: r._count._all })),
  });
});

const listQuery = z.object({
  status: z.string().trim().optional(),
  category: z.enum(EMAIL_CATEGORIES).optional(),
  q: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** The email log, newest first. */
router.get("/messages", async (req, res) => {
  const { status, category, q, page, pageSize } = listQuery.parse(req.query);
  const where = {
    ...(status ? { status } : {}),
    ...(category ? { category } : {}),
    ...(q ? { OR: [{ toEmail: { contains: q.toLowerCase() } }, { subject: { contains: q, mode: "insensitive" as const } }, { actor: { contains: q, mode: "insensitive" as const } }] } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.emailMessage.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize, omit: { idempotencyKey: true } }),
    prisma.emailMessage.count({ where }),
  ]);
  res.json({ items, total, page, pageSize });
});

/** Override: let `extra` more emails of a category go today, above its limit. */
router.post("/budget/extra", async (req, res) => {
  const { category, extra } = z.object({ category: z.enum(EMAIL_CATEGORIES), extra: z.coerce.number().int().min(1).max(10_000) }).parse(req.body);
  await allowExtraToday(category, extra, adminName(req));
  console.warn(`[email] ${adminName(req)} allowed ${extra} extra ${category} emails today`);
  res.json({ budgets: await budgetToday() });
});

/**
 * Send the emails held by the daily limit, oldest first. Each still has to fit today's budget (allow
 * extra first if needed); any that don't stay held. Each is regenerated (fresh PDF) and sent once.
 */
router.post("/held/send", async (req, res) => {
  const { max } = z.object({ max: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.body ?? {});
  const held = await prisma.emailMessage.findMany({ where: { status: "HELD", kind: { in: HOLDABLE_KINDS } }, orderBy: { createdAt: "asc" }, take: max });
  const cause = { trigger: "ADMIN" as const, actor: `${adminName(req)} (released held email)` };
  const counts = { sent: 0, stillHeld: 0, failed: 0, gone: 0 };
  for (const row of held) {
    try {
      if (row.kind === "ENTRY_PASS") {
        if (!row.tournamentId || !row.studentId) { counts.gone++; continue; }
        await sendEntryPassesIfReady(row.tournamentId, row.studentId, cause);
        // The passes may have gone in a newer email (entries added since); either way this one is done.
        const pending = await prisma.registration.count({ where: { id: { in: row.registrationIds }, hallTicketSentAt: null } });
        const after = await prisma.emailMessage.findUnique({ where: { id: row.id }, select: { status: true } });
        if (!pending && after?.status === "HELD") await prisma.emailMessage.update({ where: { id: row.id }, data: { status: "RELEASED", error: "Sent in a newer email" } });
        if (!pending) counts.sent++;
        else if (after?.status === "HELD") counts.stillHeld++;
        else counts.failed++;
        continue;
      }
      const student = row.studentId ? await prisma.student.findUnique({ where: { id: row.studentId } }) : null;
      if (!student) {
        await prisma.emailMessage.update({ where: { id: row.id }, data: { status: "FAILED", error: "Student no longer exists" } });
        counts.gone++;
        continue;
      }
      const delivery = row.kind === "REGISTRATION_APPROVED" ? await emailApproval(student, cause) : await emailRegistration(student, cause);
      if (["SENT", "LOGGED", "UNCERTAIN", "DUPLICATE"].includes(delivery.status)) counts.sent++;
      else if (delivery.status === "HELD") counts.stillHeld++;
      else counts.failed++;
    } catch (err) {
      console.error(`[email] Releasing held email ${row.id} failed:`, err);
      counts.failed++;
    }
  }
  console.warn(`[email] ${adminName(req)} released held emails: ${JSON.stringify(counts)}`);
  res.json({ ...counts, budgets: await budgetToday() });
});

// ─── Suppression list ────────────────────────────────────────────────────────

router.get("/suppressions", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
  const items = await prisma.emailSuppression.findMany({ where: q ? { email: { contains: q } } : {}, orderBy: { updatedAt: "desc" }, take: 200 });
  res.json({ items });
});

/** Allow an address again (e.g. the person fixed their mailbox). Brevo may still block it on its side. */
router.delete("/suppressions/:email", async (req, res) => {
  const email = normaliseEmail(decodeURIComponent(String(req.params.email ?? "")));
  if (!email) throw new HttpError(400, "Email required.");
  await unsuppress(email);
  console.warn(`[email] ${adminName(req)} removed ${email} from the suppression list`);
  res.json({ ok: true });
});

export default router;

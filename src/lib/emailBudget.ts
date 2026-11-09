// Daily email budgets per category, so a bug, a script or an accidental bulk action can't use up the
// month's Brevo credits in a day. Counts live in PostgreSQL (EmailDailyUsage) and are taken with one
// atomic UPDATE … WHERE sent < limit, so several server processes can't overshoot a limit together.
//
// Limits come from the environment; there are no built-in numbers:
//   EMAIL_DAILY_LIMIT_OTP, EMAIL_DAILY_LIMIT_REGISTRATION, EMAIL_DAILY_LIMIT_ENTRY_PASS,
//   EMAIL_DAILY_LIMIT_PASSWORD_RESET, EMAIL_DAILY_LIMIT_ADMIN
// Unset or empty = no limit (usage is still counted and shown to admins). 0 = that category is off.
// An admin can allow extra emails for today (an "override") from Admin → Emails.
import prisma from "../db.js";

export const EMAIL_CATEGORIES = ["OTP", "REGISTRATION", "ENTRY_PASS", "PASSWORD_RESET", "ADMIN"] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<EmailCategory, string> = {
  OTP: "Email verification codes",
  REGISTRATION: "Registration emails",
  ENTRY_PASS: "Entry passes",
  PASSWORD_RESET: "Password resets",
  ADMIN: "Admin notifications (approvals)",
};

/** The configured daily limit, or null for none. */
export function dailyLimit(category: EmailCategory): number | null {
  const raw = (process.env[`EMAIL_DAILY_LIMIT_${category}`] ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** Today's date in India, the day the budgets reset on. */
export const budgetDay = (at = new Date()) =>
  at.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // en-CA gives YYYY-MM-DD

async function ensureRow(day: string, category: EmailCategory) {
  await prisma.$executeRaw`
    INSERT INTO "EmailDailyUsage" ("day", "category", "sent", "extraAllowance", "extraGrantedBy", "updatedAt")
    VALUES (${day}, ${category}, 0, 0, '', now())
    ON CONFLICT ("day", "category") DO NOTHING`;
}

/**
 * Takes one email from today's budget. True if allowed (and counted), false if the limit is reached.
 * Atomic: two processes can never both take the last one.
 */
export async function reserveEmail(category: EmailCategory, day = budgetDay()): Promise<boolean> {
  await ensureRow(day, category);
  const limit = dailyLimit(category);
  const rows = limit === null
    ? await prisma.$queryRaw<{ sent: number }[]>`
        UPDATE "EmailDailyUsage" SET "sent" = "sent" + 1, "updatedAt" = now()
        WHERE "day" = ${day} AND "category" = ${category} RETURNING "sent"`
    : await prisma.$queryRaw<{ sent: number }[]>`
        UPDATE "EmailDailyUsage" SET "sent" = "sent" + 1, "updatedAt" = now()
        WHERE "day" = ${day} AND "category" = ${category} AND "sent" < ${limit} + "extraAllowance"
        RETURNING "sent"`;
  return rows.length > 0;
}

/** Gives back an email that was definitely not sent (the provider refused it before accepting). */
export async function releaseEmail(category: EmailCategory, day: string) {
  await prisma.$executeRaw`
    UPDATE "EmailDailyUsage" SET "sent" = GREATEST("sent" - 1, 0), "updatedAt" = now()
    WHERE "day" = ${day} AND "category" = ${category}`;
}

/** Lets `extra` more emails of this category go today, on top of the limit. */
export async function allowExtraToday(category: EmailCategory, extra: number, grantedBy: string) {
  const day = budgetDay();
  await ensureRow(day, category);
  await prisma.$executeRaw`
    UPDATE "EmailDailyUsage" SET "extraAllowance" = "extraAllowance" + ${extra}, "extraGrantedBy" = ${grantedBy}, "updatedAt" = now()
    WHERE "day" = ${day} AND "category" = ${category}`;
}

export type BudgetStatus = { category: EmailCategory; label: string; limit: number | null; extra: number; extraGrantedBy: string; sent: number; remaining: number | null };

/** Today's usage, limit and remaining emails for every category. */
export async function budgetToday(): Promise<BudgetStatus[]> {
  const day = budgetDay();
  const rows = await prisma.emailDailyUsage.findMany({ where: { day } });
  return EMAIL_CATEGORIES.map((category) => {
    const row = rows.find((r) => r.category === category);
    const limit = dailyLimit(category);
    const sent = row?.sent ?? 0;
    const extra = row?.extraAllowance ?? 0;
    return { category, label: CATEGORY_LABEL[category], limit, extra, extraGrantedBy: row?.extraGrantedBy ?? "", sent, remaining: limit === null ? null : Math.max(0, limit + extra - sent) };
  });
}

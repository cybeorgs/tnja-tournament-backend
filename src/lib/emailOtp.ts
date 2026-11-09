// Email OTP verification. Each code is a row in EmailOtpChallenge (only an HMAC of it is stored), so
// the resend cooldowns and the per-email / per-IP limits hold across restarts and server processes.
// Verifying a code returns a signed token that registration checks to prove the email was verified.
//
// Policy (all enforced here, not just by the Resend button):
//   • a code is 6 digits, valid for 5 minutes, single use
//   • resend cooldown: 60 s after the 1st code, 120 s after the 2nd, 300 s after the 3rd
//   • at most 3 codes per email in any 15 minutes; at most 10 per IP an hour and 30 a day
//   • a new code replaces the previous one, which stops working at once
//   • 5 guesses per code, then it locks and a new code is needed
import crypto from "crypto";
import jwt from "jsonwebtoken";
import prisma from "../db.js";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errors.js";
import { normaliseEmail } from "./emailAddress.js";

export const OTP_VALID_MINUTES = 5;
export const MAX_OTP_ATTEMPTS = 5;
const OTP_VALID_MS = OTP_VALID_MINUTES * 60 * 1000;
/** Wait before the next code, by how many codes were sent in the window (1st → 60 s, 2nd → 120 s, 3rd+ → 300 s). */
export const RESEND_COOLDOWNS_S = [60, 120, 300];
export const EMAIL_WINDOW_MS = 15 * 60 * 1000;
export const MAX_PER_EMAIL_WINDOW = 3;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Per-IP limits can be raised for a club registering many players from one office connection.
const maxPerIpHour = () => Number(process.env.OTP_PER_IP_HOUR) || 10;
const maxPerIpDay = () => Number(process.env.OTP_PER_IP_DAY) || 30;

const signingKey = () => crypto.createHmac("sha256", env.jwtSecret).update("otp-verification").digest("hex");
const hashCode = (challengeId: string, code: string) => crypto.createHmac("sha256", signingKey()).update(`${challengeId}:${code}`).digest("hex");

/** Codes that count towards the limits: sent (or logged, without SMTP), not the ones that failed to send. */
const COUNTED = { deliveryStatus: { not: "FAILED" } };

/** When the next code may be sent, given the counted codes of the last 15 minutes (oldest first). */
export function nextSendAt(sentAt: Date[], now = Date.now()): number {
  const n = sentAt.length;
  if (n === 0) return now;
  const last = sentAt[n - 1]!.getTime();
  let at = last + RESEND_COOLDOWNS_S[Math.min(n, RESEND_COOLDOWNS_S.length) - 1]! * 1000;
  // The rolling window: once 3 codes were sent, the next waits until the oldest of those 3 is 15 minutes old.
  if (n >= MAX_PER_EMAIL_WINDOW) at = Math.max(at, sentAt[n - MAX_PER_EMAIL_WINDOW]!.getTime() + EMAIL_WINDOW_MS);
  return at;
}

const waitText = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m} min${s ? ` ${s} s` : ""}` : `${s} seconds`;
};

/** 429 with how long to wait; `retryAfter` lets the form show the same countdown. */
function tooSoon(message: string, untilMs: number): never {
  const retryAfter = Math.max(1, Math.ceil((untilMs - Date.now()) / 1000));
  throw new HttpError(429, `${message} Please try again in ${waitText(retryAfter)}.`, { retryAfter });
}

/**
 * Creates a new code for this email (checking every limit), replacing any earlier one.
 * The caller emails `code` and then calls recordDelivery.
 */
export async function createEmailOtp(email: string, ip: string) {
  const address = normaliseEmail(email);
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  const now = Date.now();

  return prisma.$transaction(async (tx) => {
    // One request per email at a time, across all server processes: two sends can't both pass the cooldown.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`email-otp:${address}`}))`;

    const recent = await tx.emailOtpChallenge.findMany({
      where: { email: address, createdAt: { gt: new Date(now - EMAIL_WINDOW_MS) }, ...COUNTED },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    const allowedAt = nextSendAt(recent.map((r) => r.createdAt), now);
    if (allowedAt > now) {
      tooSoon(recent.length >= MAX_PER_EMAIL_WINDOW ? "Too many codes were requested for this email." : "A code was just sent to this email.", allowedAt);
    }

    if (ip) {
      const [hour, day] = await Promise.all([
        tx.emailOtpChallenge.findMany({ where: { ip, createdAt: { gt: new Date(now - HOUR_MS) }, ...COUNTED }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
        tx.emailOtpChallenge.count({ where: { ip, createdAt: { gt: new Date(now - DAY_MS) }, ...COUNTED } }),
      ]);
      if (hour.length >= maxPerIpHour()) tooSoon("Too many verification codes were requested from this network.", hour[hour.length - maxPerIpHour()]!.createdAt.getTime() + HOUR_MS);
      if (day >= maxPerIpDay()) tooSoon("Too many verification codes were requested from this network today.", now + DAY_MS);
    }

    // The previous code stops working the moment a new one is issued.
    await tx.emailOtpChallenge.updateMany({ where: { email: address, consumedAt: null, supersededAt: null }, data: { supersededAt: new Date(now) } });
    const id = crypto.randomUUID();
    await tx.emailOtpChallenge.create({ data: { id, email: address, codeHash: hashCode(id, code), ip, expiresAt: new Date(now + OTP_VALID_MS) } });
    // Old rows are only needed for the limits (a day at most).
    await tx.emailOtpChallenge.deleteMany({ where: { createdAt: { lt: new Date(now - 2 * DAY_MS) } } });

    return { id, code, email: address, expiresIn: OTP_VALID_MS / 1000 };
  });
}

/**
 * Records how the send went. A failed send is withdrawn: it doesn't count towards the limits and its
 * code can't be used. Returns the seconds until another code may be requested.
 */
export async function recordDelivery(challengeId: string, delivery: { status: "SENT" | "NOT_CONFIGURED" | "FAILED"; messageId?: string }) {
  const row = await prisma.emailOtpChallenge.update({
    where: { id: challengeId },
    data: { deliveryStatus: delivery.status, messageId: delivery.messageId ?? "", ...(delivery.status === "FAILED" ? { supersededAt: new Date() } : {}) },
    select: { email: true },
  });
  const recent = await prisma.emailOtpChallenge.findMany({
    where: { email: row.email, createdAt: { gt: new Date(Date.now() - EMAIL_WINDOW_MS) }, ...COUNTED },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  return Math.max(0, Math.ceil((nextSendAt(recent.map((r) => r.createdAt)) - Date.now()) / 1000));
}

/** Null when the code is right (it's then used up), otherwise a message for the user. */
export async function checkEmailOtp(challengeId: unknown, email: string, code: string): Promise<string | null> {
  const expired = "The code has expired. Please request a new one.";
  if (typeof challengeId !== "string" || !/^[0-9a-f-]{36}$/i.test(challengeId)) return expired;
  const challenge = await prisma.emailOtpChallenge.findUnique({ where: { id: challengeId } });
  if (!challenge || challenge.deliveryStatus === "FAILED") return expired;
  if (challenge.email !== normaliseEmail(email)) return "This code was sent to a different email address. Please request a new one.";
  if (challenge.consumedAt) return "This code has already been used. Please request a new one.";
  if (challenge.supersededAt) return "A newer code was sent to this email. Please enter the latest code.";
  if (challenge.expiresAt.getTime() <= Date.now()) return expired;

  // Count the guess first, atomically, so parallel guesses can't get past the limit.
  const counted = await prisma.emailOtpChallenge.updateMany({
    where: { id: challengeId, attempts: { lt: MAX_OTP_ATTEMPTS }, consumedAt: null, supersededAt: null },
    data: { attempts: { increment: 1 } },
  });
  if (!counted.count) return "Too many incorrect attempts. Please request a new code.";

  const expected = Buffer.from(challenge.codeHash, "hex");
  const actual = Buffer.from(hashCode(challengeId, code), "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    const left = MAX_OTP_ATTEMPTS - (challenge.attempts + 1);
    return left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.` : "Too many incorrect attempts. Please request a new code.";
  }
  // Single use: only the first correct check wins.
  const used = await prisma.emailOtpChallenge.updateMany({ where: { id: challengeId, consumedAt: null }, data: { consumedAt: new Date() } });
  return used.count ? null : "This code has already been used. Please request a new one.";
}

export const createEmailVerifiedToken = (email: string) =>
  jwt.sign({ purpose: "email-verified", target: normaliseEmail(email) }, signingKey(), { expiresIn: "2h" });

/** True if the token proves this email was verified by OTP. */
export function isEmailVerified(token: unknown, email: string) {
  if (typeof token !== "string") return false;
  try {
    const payload = jwt.verify(token, signingKey()) as jwt.JwtPayload & { purpose?: string; target?: string };
    return payload.purpose === "email-verified" && payload.target === normaliseEmail(email);
  } catch {
    return false;
  }
}

/** Every new student (and every change of a student's email) needs the address verified by OTP. */
export function assertEmailVerified(token: unknown, email: string) {
  if (!isEmailVerified(token, email)) throw new HttpError(400, "Please verify the email address with the code sent to it.");
}

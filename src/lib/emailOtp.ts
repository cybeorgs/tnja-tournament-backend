// Email OTP verification is stateless (same approach as the main TNJA site): the OTP travels in a
// short-lived signed token as an HMAC, never in plain text. Verifying it returns another signed
// token that registration checks to prove the email was verified.
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errors.js";

const MAX_ATTEMPTS = 5;

// Wrong-OTP attempts per OTP token id, and codes already used. In-memory is enough: tokens live minutes.
const failedAttempts = new Map<string, { count: number; expiresAt: number; used?: boolean }>();

const signingKey = () => crypto.createHmac("sha256", env.jwtSecret).update("otp-verification").digest("hex");
const normalise = (email: string) => email.trim().toLowerCase();
const hashOtp = (email: string, otp: string, jti: string) =>
  crypto.createHmac("sha256", signingKey()).update(`email:${normalise(email)}:${otp}:${jti}`).digest("hex");

type OtpPayload = jwt.JwtPayload & { purpose: string; target: string; otpHash?: string };

function decode(token: unknown): OtpPayload | null {
  if (typeof token !== "string") return null;
  try {
    return jwt.verify(token, signingKey()) as OtpPayload;
  } catch {
    return null;
  }
}

/** A 6-digit code and the token that must be sent back with it. */
export function createEmailOtp(email: string) {
  const otp = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  const jti = crypto.randomUUID();
  const token = jwt.sign({ purpose: "email-otp", target: normalise(email), otpHash: hashOtp(email, otp, jti) }, signingKey(), { expiresIn: "10m", jwtid: jti });
  return { otp, token };
}

/** Null when the code is right, otherwise a message for the user. */
export function checkEmailOtp(token: unknown, email: string, otp: string): string | null {
  const payload = decode(token);
  if (!payload || payload.purpose !== "email-otp" || !payload.jti || !payload.otpHash || !payload.exp) {
    return "The code has expired. Please send a new one.";
  }
  if (payload.target !== normalise(email)) return "This code was sent to a different email address. Please send a new one.";

  const now = Date.now();
  for (const [key, entry] of failedAttempts) if (entry.expiresAt < now) failedAttempts.delete(key);
  const attempts = failedAttempts.get(payload.jti);
  if (attempts?.used) return "This code has already been used. Please send a new one.";
  if (attempts && attempts.count >= MAX_ATTEMPTS) return "Too many incorrect attempts. Please send a new code.";

  const expected = Buffer.from(payload.otpHash, "hex");
  const actual = Buffer.from(hashOtp(email, otp, payload.jti), "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    failedAttempts.set(payload.jti, { count: (attempts?.count ?? 0) + 1, expiresAt: payload.exp * 1000 });
    return "Incorrect code. Please check and try again.";
  }
  failedAttempts.set(payload.jti, { count: 0, used: true, expiresAt: payload.exp * 1000 }); // single use
  return null;
}

export const createEmailVerifiedToken = (email: string) =>
  jwt.sign({ purpose: "email-verified", target: normalise(email) }, signingKey(), { expiresIn: "2h" });

/** True if the token proves this email was verified by OTP. */
export function isEmailVerified(token: unknown, email: string) {
  const payload = decode(token);
  return payload?.purpose === "email-verified" && payload.target === normalise(email);
}

/** Every new student (and every change of a student's email) needs the address verified by OTP. */
export function assertEmailVerified(token: unknown, email: string) {
  if (!isEmailVerified(token, email)) throw new HttpError(400, "Please verify the email address with the code sent to it.");
}

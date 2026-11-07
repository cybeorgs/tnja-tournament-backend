// Aadhaar verification is stateless (same approach as the main TNJA site): the DigiLocker session id
// and the verified result travel in short-lived signed tokens. Both are bound to the Aadhaar number,
// the residing pincode AND the date of birth the student entered, so a verification can't be reused
// with another pincode or date of birth. The key is derived from JWT_SECRET so these tokens are never accepted as login tokens.
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errors.js";
import { isSandboxConfigured } from "./sandbox.js";

const SESSION_PURPOSE = "aadhaar-digilocker-session";
const VERIFIED_PURPOSE = "aadhaar-verified";

const signingKey = () => crypto.createHmac("sha256", env.jwtSecret).update("aadhaar-verification").digest("hex");

export const isValidAadhaar = (value: unknown): value is string => typeof value === "string" && /^[2-9]\d{11}$/.test(value);
export { isValidPincode } from "./locations.js";

/** YYYY-MM-DD, as the registration form sends it */
export const isValidDob = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

/**
 * The date of birth on an Aadhaar as YYYY-MM-DD, or just YYYY when the Aadhaar only records the year
 * of birth. DigiLocker gives DD-MM-YYYY (sometimes with "/"), occasionally YYYY-MM-DD.
 */
export function normaliseAadhaarDob(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  let m = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(v);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return /^\d{4}$/.test(v) ? v : null;
}

/** Whether the entered date of birth matches the Aadhaar (only the year, when that is all it records). */
export const dobMatches = (aadhaarDob: string, entered: string) => (aadhaarDob.length === 4 ? entered.startsWith(aadhaarDob) : aadhaarDob === entered);

type Payload = jwt.JwtPayload & { purpose: string; aadhaar: string; pincode: string; dob?: string; sessionId?: string };

function decode(token: unknown): Payload | null {
  if (typeof token !== "string") return null;
  try {
    return jwt.verify(token, signingKey()) as Payload;
  } catch {
    return null;
  }
}

export const createSessionToken = (aadhaar: string, pincode: string, dob: string, sessionId: string) =>
  jwt.sign({ purpose: SESSION_PURPOSE, aadhaar, pincode, dob, sessionId }, signingKey(), { expiresIn: "30m" });

/** The session id, pincode and date of birth if the token is valid for this Aadhaar, otherwise null. */
export function readSessionToken(token: unknown, aadhaar: string): { sessionId: string; pincode: string; dob: string } | null {
  const payload = decode(token);
  if (payload?.purpose !== SESSION_PURPOSE || payload.aadhaar !== aadhaar || !payload.sessionId || !payload.dob) return null;
  return { sessionId: payload.sessionId, pincode: payload.pincode, dob: payload.dob };
}

export const createVerifiedToken = (aadhaar: string, pincode: string, dob: string) =>
  jwt.sign({ purpose: VERIFIED_PURPOSE, aadhaar, pincode, dob }, signingKey(), { expiresIn: "2h" });

/**
 * Self-registration needs the Aadhaar verified through DigiLocker, with the Aadhaar address in the
 * same pincode, and the same date of birth, as the student entered. Skipped only when Sandbox isn't
 * configured (local development).
 */
export function assertAadhaarVerified(token: unknown, aadhaar: string, pincode: string, dob: Date) {
  if (!isSandboxConfigured()) return;
  const payload = decode(token);
  if (payload?.purpose !== VERIFIED_PURPOSE || payload.aadhaar !== aadhaar) {
    throw new HttpError(400, "Please verify your Aadhaar with DigiLocker before registering.");
  }
  if (payload.pincode !== pincode) {
    throw new HttpError(400, "The pincode was changed after Aadhaar verification. Please verify your Aadhaar again.");
  }
  if (payload.dob !== dob.toISOString().slice(0, 10)) {
    throw new HttpError(400, "The date of birth was changed after Aadhaar verification. Please verify your Aadhaar again.");
  }
}

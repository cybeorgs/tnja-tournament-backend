// Aadhaar verification is stateless (same approach as the main TNJA site): the DigiLocker session id
// and the verified result travel in short-lived signed tokens. Both are bound to the Aadhaar number
// AND the residing pincode the student entered, so a verification can't be reused with another
// pincode. The key is derived from JWT_SECRET so these tokens are never accepted as login tokens.
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errors.js";
import { isSandboxConfigured } from "./sandbox.js";

const SESSION_PURPOSE = "aadhaar-digilocker-session";
const VERIFIED_PURPOSE = "aadhaar-verified";

const signingKey = () => crypto.createHmac("sha256", env.jwtSecret).update("aadhaar-verification").digest("hex");

export const isValidAadhaar = (value: unknown): value is string => typeof value === "string" && /^[2-9]\d{11}$/.test(value);
export const isValidPincode = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{5}$/.test(value);

type Payload = jwt.JwtPayload & { purpose: string; aadhaar: string; pincode: string; sessionId?: string };

function decode(token: unknown): Payload | null {
  if (typeof token !== "string") return null;
  try {
    return jwt.verify(token, signingKey()) as Payload;
  } catch {
    return null;
  }
}

export const createSessionToken = (aadhaar: string, pincode: string, sessionId: string) =>
  jwt.sign({ purpose: SESSION_PURPOSE, aadhaar, pincode, sessionId }, signingKey(), { expiresIn: "30m" });

/** The session id and pincode if the token is valid for this Aadhaar, otherwise null. */
export function readSessionToken(token: unknown, aadhaar: string): { sessionId: string; pincode: string } | null {
  const payload = decode(token);
  if (payload?.purpose !== SESSION_PURPOSE || payload.aadhaar !== aadhaar || !payload.sessionId) return null;
  return { sessionId: payload.sessionId, pincode: payload.pincode };
}

export const createVerifiedToken = (aadhaar: string, pincode: string) =>
  jwt.sign({ purpose: VERIFIED_PURPOSE, aadhaar, pincode }, signingKey(), { expiresIn: "2h" });

/**
 * Self-registration needs the Aadhaar verified through DigiLocker, with the Aadhaar address in the
 * same pincode the student entered. Skipped only when Sandbox isn't configured (local development).
 */
export function assertAadhaarVerified(token: unknown, aadhaar: string, pincode: string) {
  if (!isSandboxConfigured()) return;
  const payload = decode(token);
  if (payload?.purpose !== VERIFIED_PURPOSE || payload.aadhaar !== aadhaar) {
    throw new HttpError(400, "Please verify your Aadhaar with DigiLocker before registering.");
  }
  if (payload.pincode !== pincode) {
    throw new HttpError(400, "The pincode was changed after Aadhaar verification. Please verify your Aadhaar again.");
  }
}

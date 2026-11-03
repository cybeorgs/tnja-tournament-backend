// Aadhaar verification through DigiLocker (via Sandbox), with the same call limits as the main TNJA
// site. The student signs in to DigiLocker in a popup and consents to share their Aadhaar; the form
// then calls /check. Verification passes only when the Aadhaar's last 4 digits match the number
// entered AND the pincode on the Aadhaar address matches the residing pincode the student gave.
import { Router, type Request, type Response } from "express";
import prisma from "../db.js";
import { aadhaarLimits } from "../middleware/rateLimit.js";
import { SandboxError, fetchDigilockerAadhaar, getDigilockerSessionStatus, initDigilockerSession, isSandboxConfigured } from "../lib/sandbox.js";
import { createSessionToken, createVerifiedToken, isValidAadhaar, isValidPincode, readSessionToken } from "../lib/aadhaar.js";

const router = Router();

function notConfigured(res: Response) {
  console.error("[Aadhaar] Sandbox credentials are not configured (SANDBOX_API_KEY / SANDBOX_API_SECRET).");
  return res.status(503).json({ error: "Aadhaar verification is not available right now. Please try again later or contact the TNJA office." });
}

const sandboxFailure = (res: Response, error: SandboxError) => res.status(error.status >= 500 ? 502 : 400).json({ error: error.message });

// ─── Start ───────────────────────────────────────────────────────────────────

// Each start is a paid Sandbox session: repeated clicks for one Aadhaar are refused for a few seconds.
const START_COOLDOWN_MS = 15 * 1000;
const lastStartAt = new Map<string, number>();

router.post("/aadhaar/digilocker/start", aadhaarLimits.start, async (req: Request, res: Response) => {
  const { aadhaarNumber, pincode } = req.body ?? {};
  if (!isValidAadhaar(aadhaarNumber)) return res.status(400).json({ error: "Please enter a valid 12-digit Aadhaar number." });
  if (!isValidPincode(pincode)) return res.status(400).json({ error: "Please enter your 6-digit pincode first." });
  if (!isSandboxConfigured()) return notConfigured(res);

  // Don't pay for a session that can't lead to a registration.
  if (await prisma.student.findUnique({ where: { aadhaarNumber }, select: { id: true } })) {
    return res.status(409).json({ error: "This Aadhaar number is already registered. Log in with your email to register for tournaments." });
  }

  const now = Date.now();
  const last = lastStartAt.get(aadhaarNumber);
  if (last && now - last < START_COOLDOWN_MS) {
    return res.status(429).json({ error: `Please wait ${Math.ceil((START_COOLDOWN_MS - (now - last)) / 1000)} seconds before trying again.` });
  }
  lastStartAt.set(aadhaarNumber, now);
  for (const [key, at] of lastStartAt) if (now - at > START_COOLDOWN_MS) lastStartAt.delete(key);

  try {
    const { sessionId, authorizationUrl } = await initDigilockerSession();
    res.json({ authorizationUrl, digilockerSessionToken: createSessionToken(aadhaarNumber, pincode, sessionId) });
  } catch (error) {
    if (error instanceof SandboxError) return sandboxFailure(res, error);
    throw error;
  }
});

// ─── Check ───────────────────────────────────────────────────────────────────

// Each check is a billed Sandbox status call. Several tabs polling the same session must not
// multiply that, so a session is checked against Sandbox at most this often.
const CHECK_MIN_GAP_MS = 4 * 1000;
// Session tokens expire after 30 minutes, so nothing about a session is useful for longer.
const SESSION_TTL_MS = 30 * 60 * 1000;
const lastCheckAt = new Map<string, number>();

type CheckOutcome = { httpStatus: number; body: Record<string, unknown> };
// A verified session's answer, so re-checks don't fetch status and the Aadhaar document again.
// Keyed by session, Aadhaar and pincode, and only read after the signed session token is validated.
const verifiedSessions = new Map<string, { outcome: CheckOutcome; expiresAt: number }>();
// A check already talking to Sandbox: concurrent requests for the same session share its result.
const checksInFlight = new Map<string, Promise<CheckOutcome>>();

async function runCheck(sessionId: string, aadhaarNumber: string, pincode: string): Promise<CheckOutcome> {
  try {
    const status = await getDigilockerSessionStatus(sessionId);
    if (status === "created") return { httpStatus: 200, body: { status: "pending" } };
    if (status !== "succeeded") {
      return { httpStatus: 400, body: { error: "DigiLocker verification was cancelled or expired. Please click Verify again." } };
    }

    const details = await fetchDigilockerAadhaar(sessionId);
    // DigiLocker returns a masked number (e.g. xxxxxxxx1234); its last 4 digits must match what was entered.
    const lastFour = (details.maskedAadhaar || "").replace(/\D/g, "").slice(-4);
    if (lastFour.length !== 4 || lastFour !== aadhaarNumber.slice(-4)) {
      console.error(`[Aadhaar] DigiLocker Aadhaar ending ${lastFour || "n/a"} does not match entered number ending ${aadhaarNumber.slice(-4)}`);
      return { httpStatus: 400, body: { error: "The Aadhaar in your DigiLocker account does not match the number you entered." } };
    }

    if (!details.pincode) {
      return { httpStatus: 400, body: { error: "Your Aadhaar does not show a pincode, so it can't be matched. Please contact the TNJA office." } };
    }
    if (details.pincode !== pincode) {
      // The student is looking at their own Aadhaar, so telling them its pincode helps them fix the form.
      return {
        httpStatus: 400,
        body: { error: `The pincode on your Aadhaar (${details.pincode}) does not match the pincode you entered (${pincode}). Go back and enter the pincode on your Aadhaar.`, aadhaarPincode: details.pincode },
      };
    }

    return {
      httpStatus: 200,
      body: { status: "verified", aadhaarVerificationToken: createVerifiedToken(aadhaarNumber, pincode), aadhaarDetails: { name: details.name } },
    };
  } catch (error) {
    if (error instanceof SandboxError) return { httpStatus: error.status >= 500 ? 502 : 400, body: { error: error.message } };
    console.error("Error checking DigiLocker verification:", error);
    return { httpStatus: 500, body: { error: "Failed to verify Aadhaar." } };
  }
}

/** Returns { status: "pending" } until the student consents in DigiLocker, then verifies the Aadhaar and pincode. */
router.post("/aadhaar/digilocker/check", aadhaarLimits.check, async (req: Request, res: Response) => {
  const { aadhaarNumber, digilockerSessionToken } = req.body ?? {};
  if (!isValidAadhaar(aadhaarNumber)) return res.status(400).json({ error: "Please enter a valid 12-digit Aadhaar number." });
  if (!isSandboxConfigured()) return notConfigured(res);

  const session = readSessionToken(digilockerSessionToken, aadhaarNumber);
  if (!session) return res.status(400).json({ error: "Verification session expired. Please click Verify again." });
  const { sessionId, pincode } = session;

  const key = `${sessionId}:${aadhaarNumber}:${pincode}`;
  const now = Date.now();
  const verified = verifiedSessions.get(key);
  if (verified && verified.expiresAt > now) return res.status(verified.outcome.httpStatus).json(verified.outcome.body);

  const inFlight = checksInFlight.get(key);
  if (inFlight) {
    const outcome = await inFlight;
    return res.status(outcome.httpStatus).json(outcome.body);
  }

  const last = lastCheckAt.get(sessionId);
  if (last && now - last < CHECK_MIN_GAP_MS) return res.json({ status: "pending" });
  lastCheckAt.set(sessionId, now);
  for (const [k, at] of lastCheckAt) if (now - at > SESSION_TTL_MS) lastCheckAt.delete(k);

  const check = runCheck(sessionId, aadhaarNumber, pincode);
  checksInFlight.set(key, check);
  let outcome: CheckOutcome;
  try {
    outcome = await check;
  } finally {
    checksInFlight.delete(key);
  }

  if (outcome.httpStatus === 200 && outcome.body.status === "verified") {
    verifiedSessions.set(key, { outcome, expiresAt: now + SESSION_TTL_MS });
    for (const [k, entry] of verifiedSessions) if (entry.expiresAt <= now) verifiedSessions.delete(k);
  }
  res.status(outcome.httpStatus).json(outcome.body);
});

export default router;

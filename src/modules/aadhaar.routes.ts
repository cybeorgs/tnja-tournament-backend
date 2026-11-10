// Aadhaar verification through DigiLocker (via Sandbox). The student signs in to DigiLocker in a popup
// and consents to share their Aadhaar; the form then calls /check. Verification passes only when the
// Aadhaar's last 4 digits match the number entered, the pincode on the Aadhaar address matches the
// residing pincode the student gave, AND the date of birth on the Aadhaar matches the one entered.
//
// Every Sandbox call is billed, so one student should cost init + status + document (3 calls) and
// little more:
// - Once Sandbox gives a final answer for a session (the Aadhaar, or "cancelled/expired"), it is kept
//   here, so re-checks never call Sandbox again.
// - /resume lets the same browser reuse its session for free: after a pincode or date-of-birth
//   mismatch the corrected values are matched against the Aadhaar already fetched, and a popup closed
//   too early reopens the same DigiLocker session instead of paying for a new one.
// - Status calls per session are capped, whatever the client does.
// Sessions live in memory (one API process, like the rate limits). After a restart, checks still
// work statelessly from the signed session token; only the free reuse is lost.
import { Router, type Request, type Response } from "express";
import prisma from "../db.js";
import { aadhaarLimits } from "../middleware/rateLimit.js";
import { SandboxError, fetchDigilockerAadhaar, getDigilockerSessionStatus, initDigilockerSession, isSandboxConfigured, type AadhaarKycDetails } from "../lib/sandbox.js";
import { createSessionToken, createVerifiedToken, isValidAadhaar, isValidDob, isValidPincode, matchAadhaar, readSessionToken } from "../lib/aadhaar.js";

const router = Router();

function notConfigured(res: Response) {
  console.error("[Aadhaar] Sandbox credentials are not configured (SANDBOX_API_KEY / SANDBOX_API_SECRET).");
  return res.status(503).json({ error: "Aadhaar verification is not available right now. Please try again later or contact the TNJA office." });
}

const sandboxFailure = (res: Response, error: SandboxError) => res.status(error.status >= 500 ? 502 : 400).json({ error: error.message });

// ─── Session store ───────────────────────────────────────────────────────────

// Session tokens expire after 30 minutes, so nothing about a session is useful for longer.
const SESSION_TTL_MS = 30 * 60 * 1000;
// A session still waiting for the student is handed out again (instead of starting a new paid one)
// only while DigiLocker will surely still accept it.
const OPEN_SESSION_REUSE_MS = 8 * 60 * 1000;
// Billed status calls one session may make. The form needs 1–3 (callback, popup closed, "I've
// finished") plus a few slow safety polls; anything beyond this is a stuck or misbehaving client.
const MAX_STATUS_CHECKS_PER_SESSION = 10;
// Several tabs or clicks checking one session within this gap share one status call.
const CHECK_MIN_GAP_MS = 4 * 1000;

type CheckOutcome = { httpStatus: number; body: Record<string, unknown> };
type Final = { kind: "aadhaar"; details: AadhaarKycDetails } | { kind: "failed"; outcome: CheckOutcome };

interface SessionState {
  aadhaarNumber: string;
  /** Empty for sessions started before a restart */
  authorizationUrl: string;
  startedAt: number;
  statusChecks: number;
  lastCheckAt: number;
  /** Sandbox's last word on this session; once set, no more Sandbox calls are made for it */
  final?: Final;
  inFlight?: Promise<CheckOutcome | null>;
}

const sessions = new Map<string, SessionState>();

function pruneSessions(now: number) {
  for (const [id, s] of sessions) if (now - s.startedAt > SESSION_TTL_MS) sessions.delete(id);
}

const failed = (httpStatus: number, error: string): CheckOutcome => ({ httpStatus, body: { error } });

/** The answer for this student's entries, from a session whose Aadhaar or failure is already known. */
function answer(final: Final, aadhaarNumber: string, pincode: string, dob: string): CheckOutcome {
  if (final.kind === "failed") return final.outcome;
  const match = matchAadhaar(final.details, aadhaarNumber, pincode, dob);
  if (!match.ok) {
    return { httpStatus: 400, body: { error: match.error, ...(match.aadhaarPincode ? { aadhaarPincode: match.aadhaarPincode } : {}) } };
  }
  return {
    httpStatus: 200,
    body: { status: "verified", aadhaarVerificationToken: createVerifiedToken(aadhaarNumber, pincode, dob), aadhaarDetails: { name: final.details.name } },
  };
}

/** Asks Sandbox once. Sets `state.final` when the answer is final; otherwise returns what to tell the client. */
async function askSandbox(sessionId: string, state: SessionState): Promise<CheckOutcome | null> {
  try {
    state.statusChecks++;
    const status = await getDigilockerSessionStatus(sessionId);
    if (status === "created") return { httpStatus: 200, body: { status: "pending" } };
    if (status !== "succeeded") {
      state.final = { kind: "failed", outcome: failed(400, "DigiLocker verification was cancelled or expired. Please click Verify again.") };
      return null;
    }
    state.final = { kind: "aadhaar", details: await fetchDigilockerAadhaar(sessionId) };
    return null;
  } catch (error) {
    if (error instanceof SandboxError) {
      // 404: the student did not share Aadhaar in this session; only a new session can fix that.
      if (error.status === 404) {
        state.final = { kind: "failed", outcome: failed(400, error.message) };
        return null;
      }
      return failed(error.status >= 500 ? 502 : 400, error.message);
    }
    console.error("Error checking DigiLocker verification:", error);
    return failed(500, "Failed to verify Aadhaar.");
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

// Each start is a paid Sandbox session: repeated clicks for one Aadhaar are refused for a few seconds.
const START_COOLDOWN_MS = 15 * 1000;
const lastStartAt = new Map<string, number>();

router.post("/aadhaar/digilocker/start", aadhaarLimits.start, async (req: Request, res: Response) => {
  const { aadhaarNumber, pincode, dob } = req.body ?? {};
  if (!isValidAadhaar(aadhaarNumber)) return res.status(400).json({ error: "Please enter a valid 12-digit Aadhaar number." });
  if (!isValidPincode(pincode)) return res.status(400).json({ error: "Please enter your 6-digit pincode first." });
  if (!isValidDob(dob)) return res.status(400).json({ error: "Please enter your date of birth first." });
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
  pruneSessions(now);

  try {
    const { sessionId, authorizationUrl } = await initDigilockerSession();
    sessions.set(sessionId, { aadhaarNumber, authorizationUrl, startedAt: now, statusChecks: 0, lastCheckAt: 0 });
    res.json({ authorizationUrl, digilockerSessionToken: createSessionToken(aadhaarNumber, pincode, dob, sessionId) });
  } catch (error) {
    if (error instanceof SandboxError) return sandboxFailure(res, error);
    throw error;
  }
});

// ─── Resume (free) ───────────────────────────────────────────────────────────

/**
 * Called by the form before /start when it still holds a session token for this Aadhaar. Never calls
 * Sandbox. Answers with the verification result if the session's Aadhaar is already known (matched
 * against the pincode and date of birth sent now), { status: "open" } with the same DigiLocker link
 * if the session is still waiting for the student, or { status: "new" } when /start is needed.
 * Only the browser holding the signed session token can resume it.
 */
router.post("/aadhaar/digilocker/resume", aadhaarLimits.resume, (req: Request, res: Response) => {
  const { aadhaarNumber, pincode, dob, digilockerSessionToken } = req.body ?? {};
  if (!isValidAadhaar(aadhaarNumber)) return res.status(400).json({ error: "Please enter a valid 12-digit Aadhaar number." });
  if (!isValidPincode(pincode)) return res.status(400).json({ error: "Please enter your 6-digit pincode first." });
  if (!isValidDob(dob)) return res.status(400).json({ error: "Please enter your date of birth first." });
  if (!isSandboxConfigured()) return notConfigured(res);

  const session = readSessionToken(digilockerSessionToken, aadhaarNumber);
  const state = session ? sessions.get(session.sessionId) : undefined;
  if (!session || !state || state.aadhaarNumber !== aadhaarNumber) return res.json({ status: "new" });

  if (state.final?.kind === "aadhaar") {
    const outcome = answer(state.final, aadhaarNumber, pincode, dob);
    return res.status(outcome.httpStatus).json(outcome.body);
  }
  const now = Date.now();
  if (state.final || !state.authorizationUrl || now - state.startedAt > OPEN_SESSION_REUSE_MS || state.statusChecks >= MAX_STATUS_CHECKS_PER_SESSION) {
    return res.json({ status: "new" });
  }
  res.json({ status: "open", authorizationUrl: state.authorizationUrl, digilockerSessionToken: createSessionToken(aadhaarNumber, pincode, dob, session.sessionId) });
});

// ─── Check ───────────────────────────────────────────────────────────────────

/** Returns { status: "pending" } until the student consents in DigiLocker, then verifies the Aadhaar, pincode and date of birth. */
router.post("/aadhaar/digilocker/check", aadhaarLimits.check, async (req: Request, res: Response) => {
  const { aadhaarNumber, digilockerSessionToken } = req.body ?? {};
  if (!isValidAadhaar(aadhaarNumber)) return res.status(400).json({ error: "Please enter a valid 12-digit Aadhaar number." });
  if (!isSandboxConfigured()) return notConfigured(res);

  const session = readSessionToken(digilockerSessionToken, aadhaarNumber);
  if (!session) return res.status(400).json({ error: "Verification session expired. Please click Verify again." });
  const { sessionId, pincode, dob } = session;

  const now = Date.now();
  // A session started before a restart carries on from the token alone (no free reuse for it).
  const state = sessions.get(sessionId) ?? { aadhaarNumber, authorizationUrl: "", startedAt: now, statusChecks: 0, lastCheckAt: 0 };
  sessions.set(sessionId, state);

  const reply = (outcome: CheckOutcome | null) => {
    const final = outcome ?? answer(state.final!, aadhaarNumber, pincode, dob);
    res.status(final.httpStatus).json(final.body);
  };

  if (state.final) return reply(null);
  if (state.inFlight) return reply(await state.inFlight);
  if (now - state.lastCheckAt < CHECK_MIN_GAP_MS) return res.json({ status: "pending" });
  if (state.statusChecks >= MAX_STATUS_CHECKS_PER_SESSION) {
    console.warn(`[Aadhaar] Session reached ${MAX_STATUS_CHECKS_PER_SESSION} status checks; refusing more.`);
    state.final = { kind: "failed", outcome: failed(400, "Verification timed out. Please click Verify again.") };
    return reply(null);
  }

  state.lastCheckAt = now;
  state.inFlight = askSandbox(sessionId, state);
  try {
    reply(await state.inFlight);
  } finally {
    state.inFlight = undefined;
  }
});

export default router;

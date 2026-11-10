import type { NextFunction, Request, Response } from "express";

// In-memory fixed-window limiting for a single-process app. Counters reset on restart and are per
// process, so run the API as one instance for the limits (and the paid-API budgets) to hold.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `${minutes} minutes` : `${Math.ceil(minutes / 60)} hours`;
}

interface LimitOptions {
  windowMs: number;
  max: number;
  /** What to count by. Defaults to the client IP (trust proxy is set, so this is the real IP behind Nginx). */
  key?: (req: Request) => string | undefined;
  /** Shown before "Please try again in …". */
  message?: string;
}

export function rateLimit({ windowMs, max, key = (req) => req.ip || "unknown", message }: LimitOptions) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  // Drop expired windows now and then so the map can't grow without bound.
  setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of hits) if (entry.resetAt <= now) hits.delete(k);
  }, MINUTE_MS).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const id = key(req);
    if (!id) return next();
    const now = Date.now();
    const entry = hits.get(id);
    if (!entry || entry.resetAt <= now) {
      hits.set(id, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= max) {
      const wait = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", wait);
      return res.status(429).json({
        error: message ? `${message} Please try again in ${formatWait(wait)}.` : "Too many attempts. Please wait a few minutes and try again.",
      });
    }
    entry.count++;
    next();
  };
}

/**
 * A daily spending cap across all users for one paid provider, so a bot or a bug can never run
 * up an unbounded bill. Set the limit with the env var; 0 disables the cap.
 */
export function dailyBudget(envVar: string, defaultMax: number) {
  return rateLimit({
    windowMs: DAY_MS,
    max: Number(process.env[envVar] ?? defaultMax) || Number.MAX_SAFE_INTEGER,
    key: () => "global",
    message: "This verification is temporarily unavailable due to high demand.",
  });
}

const digitsOf = (value: unknown) => (typeof value === "string" ? value.replace(/\D/g, "") || undefined : undefined);

// Aadhaar verification through DigiLocker is billed per Sandbox call. Same limits as the main TNJA site:
// per-IP limits are generous because a club may register many players from one office connection;
// the per-Aadhaar limits stop one number being hammered (a genuine student needs 1–2 sessions, since
// /resume reuses a session for free). Status calls are also capped per session in aadhaar.routes.ts,
// and every billed Sandbox call counts against SANDBOX_DAILY_CALL_LIMIT in lib/sandbox.ts.
export const aadhaarLimits = {
  start: [
    rateLimit({ windowMs: HOUR_MS, max: 30, message: "Too many Aadhaar verification attempts from this network." }),
    rateLimit({ windowMs: HOUR_MS, max: 3, key: (req) => digitsOf(req.body?.aadhaarNumber), message: "Too many verification attempts for this Aadhaar number." }),
    rateLimit({ windowMs: DAY_MS, max: Number(process.env.AADHAAR_PER_NUMBER_DAILY_LIMIT ?? 6) || Number.MAX_SAFE_INTEGER, key: (req) => digitsOf(req.body?.aadhaarNumber), message: "Too many verification attempts for this Aadhaar number today." }),
    dailyBudget("AADHAAR_DAILY_LIMIT", 500),
  ],
  // Free (no Sandbox call), so only limited against scripted abuse.
  resume: [rateLimit({ windowMs: 10 * MINUTE_MS, max: 60, message: "Too many verification attempts." })],
  check: [rateLimit({ windowMs: 10 * MINUTE_MS, max: 120, message: "Too many status checks." })],
};

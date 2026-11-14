import type { NextFunction, Request, Response } from "express";

// In-memory fixed-window limiting for a single-process app. Counters reset on restart and are per
// process, so run the API as one instance for the limits to hold.

const MINUTE_MS = 60 * 1000;

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

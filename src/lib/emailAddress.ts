// Email address checks, before anything is sent. The frontend has the same rules
// (Tnja-frontend/src/lib/email.ts) so both give the same messages; this side is the one that counts.
//
// None of this proves a mailbox exists: syntax and MX records only show the address could receive mail.
import { promises as dns } from "dns";
import { z } from "zod";

export const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;

/** Trimmed and lower-cased: the form every address is stored, compared and rate-limited in. */
export const normaliseEmail = (email: string) => email.trim().toLowerCase();

const LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Why an (already normalised) address is malformed, or null if its format is fine. */
export function emailProblem(email: string): string | null {
  if (!email) return "Please enter your email address.";
  if (/\s/.test(email)) return "Email address can't contain spaces.";
  if (email.length > MAX_EMAIL_LENGTH) return "Email address is too long.";
  const at = email.indexOf("@");
  if (at === -1) return "Email address must contain @, e.g. name@gmail.com.";
  if (email.indexOf("@", at + 1) !== -1) return "Email address can only contain one @.";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local) return "Enter the part before @, e.g. name@gmail.com.";
  if (!domain || !domain.includes(".")) return "Email address is missing the domain, e.g. name@gmail.com.";
  if (local.length > MAX_LOCAL_LENGTH) return "Email address is too long.";
  const labels = domain.split(".");
  const tld = labels[labels.length - 1]!;
  if (!LOCAL.test(local) || !labels.every((l) => LABEL.test(l)) || !/^[a-z]{2,}$/.test(tld)) return "Enter a valid email address.";
  // A second, independent check by the validation library.
  if (!z.email().safeParse(email).success) return "Enter a valid email address.";
  return null;
}

// Domains people commonly mistype. Real providers that look like typos of each other (mail.com /
// gmail.com) are listed too, so they're never "corrected".
const KNOWN_DOMAINS = [
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.in", "ymail.com", "rocketmail.com",
  "outlook.com", "outlook.in", "hotmail.com", "live.com", "live.in", "msn.com", "icloud.com", "me.com",
  "rediffmail.com", "protonmail.com", "proton.me", "zoho.com", "zohomail.in", "aol.com", "mail.com", "gmx.com", "yandex.com",
];
const KNOWN = new Set(KNOWN_DOMAINS);

/** Edit distance (Damerau-Levenshtein, adjacent swaps count as one), e.g. gamil → gmail is 1. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * The address with its domain corrected when the domain looks like a typo of a common provider
 * (hari@gamil.com → hari@gmail.com), otherwise null. Only ever a suggestion: the user confirms.
 */
export function suggestEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const domain = email.slice(at + 1);
  if (!domain || KNOWN.has(domain)) return null;
  const maxDistance = domain.length <= 7 ? 1 : 2;
  let best: { domain: string; d: number } | null = null;
  for (const known of KNOWN_DOMAINS) {
    const d = distance(domain, known);
    if (d <= maxDistance && (!best || d < best.d)) best = { domain: known, d };
  }
  return best ? `${email.slice(0, at)}@${best.domain}` : null;
}

// MX answers, cached for an hour (the same domains come up again and again).
const MX_CACHE_MS = 60 * 60 * 1000;
const MX_TIMEOUT_MS = 3000;
const mxCache = new Map<string, { ok: boolean; at: number }>();

/**
 * False only when DNS says the domain can't receive mail (it doesn't exist, or has no MX records).
 * A slow or failing DNS lookup counts as fine: a DNS hiccup must never block a real registration.
 */
export async function domainAcceptsMail(email: string): Promise<boolean> {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (KNOWN.has(domain)) return true;
  const cached = mxCache.get(domain);
  if (cached && Date.now() - cached.at < MX_CACHE_MS) return cached.ok;
  let ok = true;
  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), MX_TIMEOUT_MS).unref()),
    ]);
    if (records === null) return true; // timed out: don't cache, don't block
    ok = records.some((r) => !!r.exchange && r.exchange !== ".");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") ok = false;
    else return true; // SERVFAIL, refused, no network…: don't block
  }
  mxCache.set(domain, { ok, at: Date.now() });
  if (mxCache.size > 5000) mxCache.clear();
  return ok;
}

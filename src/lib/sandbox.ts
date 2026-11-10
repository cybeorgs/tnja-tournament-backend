// Sandbox (api.sandbox.co.in) client for Aadhaar verification via DigiLocker — the same client and
// call limits as the main TNJA site. Credentials are optional: without them Aadhaar verification
// is simply switched off. The access token from /authenticate lasts 24 hours, so it is cached.
import crypto from "crypto";
import os from "os";
import { env } from "../config/env.js";

const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

let cachedToken: { value: string; expiresAt: number } | null = null;

function getConfig() {
  const baseUrl = (process.env.SANDBOX_BASE_URL || "https://api.sandbox.co.in").replace(/\/+$/, "");
  const apiKey = process.env.SANDBOX_API_KEY;
  const apiSecret = process.env.SANDBOX_API_SECRET;
  const apiVersion = process.env.SANDBOX_API_VERSION || "1.0.0";
  if (!apiKey || !apiSecret) return null;
  return { baseUrl, apiKey, apiSecret, apiVersion };
}

export function isSandboxConfigured(): boolean {
  return getConfig() !== null;
}

/** Thrown for any non-success Sandbox response. `message` is safe to show to the user. */
export class SandboxError extends Error {
  constructor(message: string, public status: number, public accountProblem = false) {
    super(message);
    this.name = "SandboxError";
  }
}

const ACCOUNT_PROBLEM_MESSAGE = "Aadhaar verification is temporarily unavailable. Please try again later or contact the TNJA office.";
// Our Sandbox balance/quota ran out or the key was halted: an operator problem, not something the user can fix.
const isAccountProblem = (raw: string) => /insufficient (credit|balance)|credit.*(exhaust|low)|recharge|quota|halt|limit exceeded/i.test(raw);

// Every call while the account is blocked still counts against it, so pause all calls for a while.
const ACCOUNT_PAUSE_MS = 10 * 60 * 1000;
let pausedUntil = 0;

// UIDAI / Sandbox messages that are too terse to show to users as-is.
function friendlyMessage(raw: string, status: number): string {
  if (/source unavailable|service unavailable|timed? ?out|gateway/i.test(raw) || status >= 500) {
    return "DigiLocker is temporarily unavailable. Please wait a few minutes and try again.";
  }
  if (isAccountProblem(raw)) return ACCOUNT_PROBLEM_MESSAGE;
  return raw;
}

// Hard daily cap on billed Sandbox HTTP calls from this process (authenticate, init, status and
// document calls, retries included), whatever triggered them. The per-route limits keep normal use
// far below it; this is the last line of defence against a bug or a bot running up the bill.
// Counted per calendar day in India time. SANDBOX_DAILY_CALL_LIMIT=0 switches the cap off.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const callsToday = { day: "", count: 0 };
const BUDGET_MESSAGE = "Aadhaar verification is temporarily unavailable due to high demand. Please try again later or contact the TNJA office.";

function takeCallBudget() {
  const limit = Number(process.env.SANDBOX_DAILY_CALL_LIMIT ?? 2000);
  const day = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  if (callsToday.day !== day) {
    callsToday.day = day;
    callsToday.count = 0;
  }
  if (limit > 0 && callsToday.count >= limit) {
    console.error(`[Sandbox] Daily call limit reached (${limit}). Refusing Sandbox calls until midnight IST.`);
    // accountProblem: callers must not retry, the retry would be refused too.
    throw new SandboxError(BUDGET_MESSAGE, 503, true);
  }
  callsToday.count++;
}

// Which backend made a call: several (the main site, this app, local dev) may share one API key.
const INSTANCE = process.env.INSTANCE_NAME || `tournament@${os.hostname()}:${process.pid}`;

/** Ties together the HTTP requests made for one operation (token refresh and retry included). */
interface CallContext { id: string; attempt: "initial" | "retry" }
const newCall = (): CallContext => ({ id: crypto.randomBytes(4).toString("hex"), attempt: "initial" });

/**
 * One line per HTTP request sent to Sandbox, to reconcile with Sandbox's usage page.
 * Only method, path (no query string) and status: never keys, tokens, Aadhaar numbers or documents.
 */
function logCall(call: CallContext, method: string, path: string, outcome: string, startedAt: number) {
  console.log(
    `[Sandbox] ${new Date().toISOString()} instance=${INSTANCE} call=${call.id} attempt=${call.attempt} ` +
      `${method} ${path.split("?")[0]} -> ${outcome} (${Date.now() - startedAt}ms) today=${callsToday.count}`,
  );
}

async function request(path: string, init: { method: string; headers: Record<string, string>; body?: unknown }, call: CallContext = newCall()) {
  const config = getConfig();
  if (!config) throw new SandboxError("Aadhaar verification is not configured.", 503);
  if (Date.now() < pausedUntil) throw new SandboxError(ACCOUNT_PROBLEM_MESSAGE, 503, true);
  takeCallBudget();

  const startedAt = Date.now();
  let res: globalThis.Response;
  try {
    res = await fetch(`${config.baseUrl}${path}`, {
      method: init.method,
      headers: { "Content-Type": "application/json", "x-api-key": config.apiKey, "x-api-version": config.apiVersion, ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // The request may or may not have reached Sandbox, so it is logged like any other call.
    logCall(call, init.method, path, `network error (${(err as Error).name})`, startedAt);
    throw new SandboxError("Aadhaar verification service is unreachable. Please try again.", 502);
  }

  logCall(call, init.method, path, String(res.status), startedAt);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || (json?.code && json.code >= 400)) {
    const status = res.ok ? json.code : res.status;
    const raw = json?.data?.message || json?.message || "Aadhaar verification failed.";
    console.error(`[Sandbox] call=${call.id} ${path.split("?")[0]} returned ${status}: ${raw} (transaction_id: ${json?.transaction_id ?? "n/a"})`);
    if (isAccountProblem(raw)) {
      pausedUntil = Date.now() + ACCOUNT_PAUSE_MS;
      console.error(`[Sandbox] Account blocked (quota/halt). Pausing all Sandbox calls for ${ACCOUNT_PAUSE_MS / 60000} minutes.`);
      throw new SandboxError(ACCOUNT_PROBLEM_MESSAGE, status, true);
    }
    throw new SandboxError(friendlyMessage(raw, status), status);
  }
  return json;
}

// Single flight: requests arriving while a token is being fetched wait for that fetch
// instead of each calling /authenticate. The HTTP call is logged under the first caller's id.
let tokenInFlight: Promise<string> | null = null;

/**
 * Returns a usable access token. With `rejected`, the caller's token was refused: a new one is
 * fetched unless another request has already replaced it, so concurrent 401s share one refresh.
 */
async function getAccessToken(call: CallContext, rejected?: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() && cachedToken.value !== rejected) return cachedToken.value;
  if (tokenInFlight) return tokenInFlight;

  const config = getConfig();
  if (!config) throw new SandboxError("Aadhaar verification is not configured.", 503);

  tokenInFlight = (async () => {
    const json = await request("/authenticate", { method: "POST", headers: { "x-api-secret": config.apiSecret } }, call);
    const token = json?.access_token || json?.data?.access_token;
    if (!token) throw new SandboxError("Aadhaar verification service authentication failed.", 502);
    cachedToken = { value: token, expiresAt: Date.now() + TOKEN_TTL_MS };
    return token as string;
  })();
  try {
    return await tokenInFlight;
  } finally {
    tokenInFlight = null;
  }
}

/** Calls an authenticated endpoint, refreshing the access token once if it was rejected. */
async function authed(method: "GET" | "POST", path: string, body?: unknown) {
  const call = newCall();
  // Outside the try: if /authenticate itself fails, retrying would only call it again.
  const token = await getAccessToken(call);
  try {
    return await request(path, { method, headers: { Authorization: token }, body }, call);
  } catch (err) {
    // A rejected token is worth one refresh; a blocked account is not (that would be two more billed calls).
    if (err instanceof SandboxError && !err.accountProblem && (err.status === 401 || err.status === 403)) {
      const retry: CallContext = { id: call.id, attempt: "retry" };
      return request(path, { method, headers: { Authorization: await getAccessToken(retry, token) }, body }, retry);
    }
    throw err;
  }
}

// UIDAI discontinued Aadhaar offline e-KYC (OTP), so Aadhaar is verified through DigiLocker:
// the user signs in to DigiLocker, consents to share their Aadhaar, and we fetch it by session id.

/** Where DigiLocker sends the user after consent. Sandbox requires a public HTTPS URL. */
function digilockerRedirectUrl(): string {
  if (process.env.DIGILOCKER_REDIRECT_URL) return process.env.DIGILOCKER_REDIRECT_URL;
  const site = env.publicSiteUrl.replace(/\/+$/, "");
  // Local dev runs on http: DigiLocker returns to the main site's page instead and the form's slow poll picks up the result.
  return `${site.startsWith("https://") ? site : "https://tnja-329-2017.in"}/digilocker-callback`;
}

/** Starts a DigiLocker consent session for the user's Aadhaar. */
export async function initDigilockerSession(): Promise<{ sessionId: string; authorizationUrl: string }> {
  const json = await authed("POST", "/kyc/digilocker/sessions/init", {
    "@entity": "in.co.sandbox.kyc.digilocker.session.request",
    flow: "signin",
    redirect_url: digilockerRedirectUrl(),
    doc_types: ["aadhaar"],
    purpose: "TNJA tournament registration KYC",
    options: { pinless: true },
  });
  const sessionId = json?.data?.session_id;
  const authorizationUrl = json?.data?.authorization_url;
  if (!sessionId || !authorizationUrl) throw new SandboxError("Failed to start DigiLocker verification. Please try again.", 502);
  return { sessionId: String(sessionId), authorizationUrl: String(authorizationUrl) };
}

export type DigilockerSessionStatus = "created" | "succeeded" | "failed" | "expired";

export async function getDigilockerSessionStatus(sessionId: string): Promise<DigilockerSessionStatus> {
  const json = await authed("GET", `/kyc/digilocker/sessions/${encodeURIComponent(sessionId)}/status`);
  return String(json?.data?.status || "created").toLowerCase() as DigilockerSessionStatus;
}

export interface AadhaarKycDetails {
  maskedAadhaar: string | null;
  name: string | null;
  gender: string | null;
  dateOfBirth: string | null;
  /** Pincode of the address on the Aadhaar (the `pc` attribute of <Poa>). */
  pincode: string | null;
}

function xmlAttr(xml: string, tag: string, attr: string): string | null {
  const element = xml.match(new RegExp(`<${tag}\\b[^>]*>`))?.[0];
  return element?.match(new RegExp(`\\b${attr}="([^"]*)"`))?.[1] ?? null;
}

/** Downloads the consented Aadhaar (UIDAI-signed XML) and reads the holder's basic details. */
export async function fetchDigilockerAadhaar(sessionId: string): Promise<AadhaarKycDetails> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any;
  try {
    json = await authed("GET", `/kyc/digilocker/sessions/${encodeURIComponent(sessionId)}/documents/aadhaar`);
  } catch (err) {
    // 404 "Doctype not found": the user signed in but did not share Aadhaar on DigiLocker's consent
    // screen, or has no Aadhaar linked to their DigiLocker account.
    if (err instanceof SandboxError && err.status === 404) {
      throw new SandboxError("Your Aadhaar was not shared from DigiLocker. Click Verify again and make sure Aadhaar is selected on the consent screen.", 404);
    }
    throw err;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const files: any[] = Array.isArray(json?.data?.files) ? json.data.files : [];
  const file = files.find((f) => /xml/i.test(JSON.stringify(f?.metadata ?? ""))) || files[0];
  if (!file?.url) throw new SandboxError("Aadhaar was not found in your DigiLocker account.", 404);

  // The file URL is a signed link (its query string is a credential), so only its host is logged.
  // This download is a separate HTTP request but not a Sandbox API call.
  const download = newCall();
  const startedAt = Date.now();
  let host = "unknown-host";
  try { host = new URL(file.url).host; } catch { /* malformed URL: fetch below reports it */ }
  let xml: string;
  try {
    const res = await fetch(file.url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    logCall(download, "GET", `[file download] ${host}`, String(res.status), startedAt);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } catch (err) {
    console.error(`[Sandbox] call=${download.id} Downloading DigiLocker Aadhaar failed:`, (err as Error).message);
    throw new SandboxError("Could not read your Aadhaar from DigiLocker. Please try again.", 502);
  }

  return {
    maskedAadhaar: xmlAttr(xml, "UidData", "uid"),
    name: xmlAttr(xml, "Poi", "name"),
    gender: xmlAttr(xml, "Poi", "gender"),
    dateOfBirth: xmlAttr(xml, "Poi", "dob"),
    pincode: xmlAttr(xml, "Poa", "pc")?.replace(/\D/g, "") || null,
  };
}

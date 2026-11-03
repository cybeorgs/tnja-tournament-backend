// Student (and parent) logins. One account per email covers every student registered with it.
// Passwords are never emailed: a new account gets an unguessable random password nobody knows, and
// the welcome email carries a one-time link to set their own. "Forgot password" works the same way.
import crypto from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import type { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { env } from "../config/env.js";

type Tx = Prisma.TransactionClient;
type Account = { id: string; passwordHash: string };

export const hashPassword = (password: string) => bcrypt.hash(password, 12);

/** A hash of a random secret that is thrown away, so the account can't be logged into until a password is set. */
export const unusablePasswordHash = () => hashPassword(crypto.randomBytes(32).toString("hex"));

/**
 * Make sure a login exists for this email. Returns the account and whether it was just created
 * (an email that already has an account — e.g. a sibling registered before — keeps its password).
 */
export async function ensureAccount(tx: Tx, email: string): Promise<Account & { created: boolean }> {
  const normalised = email.trim().toLowerCase();
  const existing = await tx.studentAccount.findUnique({ where: { email: normalised }, select: { id: true, passwordHash: true } });
  if (existing) return { ...existing, created: false };
  const account = await tx.studentAccount.create({ data: { email: normalised, passwordHash: await unusablePasswordHash() }, select: { id: true, passwordHash: true } });
  return { ...account, created: true };
}

// ─── Set-password links ──────────────────────────────────────────────────────
// Stateless: the link carries a signed token naming the account and a fingerprint of its current
// password hash. Setting a password changes the hash, so every earlier link stops working (single use).

const signingKey = () => crypto.createHmac("sha256", env.jwtSecret).update("password-setup").digest("hex");
const fingerprint = (passwordHash: string) => crypto.createHash("sha256").update(passwordHash).digest("hex").slice(0, 32);

/** Link to set a password. Welcome links last a week (registration emails may be read late); reset links an hour. */
export function passwordLink(account: Account, purpose: "welcome" | "reset") {
  const token = jwt.sign({ purpose: "set-password", sub: account.id, fp: fingerprint(account.passwordHash) }, signingKey(), { expiresIn: purpose === "welcome" ? "7d" : "1h" });
  return `${env.publicSiteUrl.replace(/\/+$/, "")}/student/set-password?token=${encodeURIComponent(token)}`;
}

/** For the registration email: a set-password link when the account is new, otherwise null (they already have a password). */
export const welcomeLink = (account: Account & { created: boolean }) => (account.created ? passwordLink(account, "welcome") : null);

/** The account the link is for, if the token is valid and hasn't been used yet; otherwise null. */
export async function accountFromPasswordToken(token: string) {
  let payload: jwt.JwtPayload & { purpose?: string; fp?: string };
  try {
    payload = jwt.verify(token, signingKey()) as typeof payload;
  } catch {
    return null;
  }
  if (payload.purpose !== "set-password" || !payload.sub || !payload.fp) return null;
  const account = await prisma.studentAccount.findUnique({ where: { id: payload.sub } });
  return account && fingerprint(account.passwordHash) === payload.fp ? account : null;
}

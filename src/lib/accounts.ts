// Student (and parent) logins. One account per email covers every student registered with it.
// When a student registers, the registration email carries their username (the email) and a
// temporary password generated here; they can change it after logging in. "Forgot password" emails
// a one-time link to choose a new one.
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

// Easy to read and type: no 0/O, 1/l/I.
const PASSWORD_CHARS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A random 10-character password. */
export function generatePassword(length = 10) {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => PASSWORD_CHARS[b % PASSWORD_CHARS.length]).join("");
}

/**
 * Give the account a new temporary password (for the registration email) and return it. It counts as
 * not chosen by the owner (passwordSetAt stays empty) until they change it.
 */
export async function issueTemporaryPassword(accountId: string) {
  const password = generatePassword();
  await prisma.studentAccount.update({ where: { id: accountId }, data: { passwordHash: await hashPassword(password), passwordSetAt: null } });
  return password;
}

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

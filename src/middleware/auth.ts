import type { NextFunction, Request, Response } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import prisma from "../db.js";

export interface AuthPayload {
  adminId: string;
  username: string;
}

/** A student (or parent) logged in with their email; covers every student registered with it. */
export interface StudentAuthPayload {
  kind: "student";
  accountId: string;
  email: string;
  /** Fingerprint of the password hash at login: changing or resetting the password ends every older session. */
  pv?: string;
}

/** Short fingerprint of a password hash, carried in student tokens (the hash itself never leaves the server). */
export const passwordVersion = (passwordHash: string) =>
  crypto.createHmac("sha256", env.jwtSecret).update(`session:${passwordHash}`).digest("hex").slice(0, 16);

declare global {
  namespace Express {
    interface Request {
      admin?: AuthPayload;
      student?: StudentAuthPayload;
    }
  }
}

const expiresIn = env.jwtExpiresIn as jwt.SignOptions["expiresIn"];

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn });
}

/** A session for the account, tied to its current password (see passwordVersion). */
export function signStudentToken(account: { id: string; email: string; passwordHash: string }): string {
  const payload: StudentAuthPayload = { kind: "student", accountId: account.id, email: account.email, pv: passwordVersion(account.passwordHash) };
  return jwt.sign(payload, env.jwtSecret, { expiresIn });
}

function bearer(req: Request) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: "Please log in." });
  try {
    const decoded = jwt.verify(token, env.jwtSecret) as Partial<AuthPayload & StudentAuthPayload>;
    // Student tokens are signed with the same secret; they must never open admin routes.
    if (typeof decoded.adminId !== "string" || decoded.kind) throw new Error("Not an admin token");
    req.admin = { adminId: decoded.adminId, username: decoded.username ?? "" };
    next();
  } catch {
    return res.status(401).json({ error: "Your session has expired. Please log in again." });
  }
}

/**
 * A valid student session: signed, not expired, and issued since the password was last changed or
 * reset (so a stolen or old session stops working then). The account's current email is used.
 */
export async function requireStudent(req: Request, res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: "Please log in." });
  let decoded: Partial<StudentAuthPayload>;
  try {
    decoded = jwt.verify(token, env.jwtSecret) as Partial<StudentAuthPayload>;
    if (decoded.kind !== "student" || !decoded.accountId || !decoded.pv) throw new Error("Not a student token");
  } catch {
    return res.status(401).json({ error: "Your session has expired. Please log in again." });
  }
  try {
    const account = await prisma.studentAccount.findUnique({ where: { id: decoded.accountId }, select: { id: true, email: true, passwordHash: true } });
    if (!account || passwordVersion(account.passwordHash) !== decoded.pv) {
      return res.status(401).json({ error: "Your password was changed, so you've been logged out. Please log in again." });
    }
    req.student = { kind: "student", accountId: account.id, email: account.email };
    next();
  } catch (err) {
    next(err);
  }
}

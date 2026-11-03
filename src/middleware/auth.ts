import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export interface AuthPayload {
  adminId: string;
  username: string;
}

/** A student (or parent) logged in with their email; covers every student registered with it. */
export interface StudentAuthPayload {
  kind: "student";
  accountId: string;
  email: string;
}

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

export function signStudentToken(payload: Omit<StudentAuthPayload, "kind">): string {
  return jwt.sign({ ...payload, kind: "student" }, env.jwtSecret, { expiresIn });
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

export function requireStudent(req: Request, res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: "Please log in." });
  try {
    const decoded = jwt.verify(token, env.jwtSecret) as Partial<StudentAuthPayload>;
    if (decoded.kind !== "student" || !decoded.accountId || !decoded.email) throw new Error("Not a student token");
    req.student = { kind: "student", accountId: decoded.accountId, email: decoded.email };
    next();
  } catch {
    return res.status(401).json({ error: "Your session has expired. Please log in again." });
  }
}

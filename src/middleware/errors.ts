import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";

/** Thrown from route handlers to send a specific status and message. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found.`);

// Express 5 forwards rejected promises from async handlers here.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });

  if (err instanceof ZodError) {
    const first = err.issues[0];
    const field = first?.path.join(".");
    return res.status(400).json({ error: field ? `${field}: ${first?.message}` : first?.message || "Invalid input." });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return res.status(409).json({ error: "A record with these details already exists." });
    if (err.code === "P2025") return res.status(404).json({ error: "Record not found." });
    if (err.code === "P2003") return res.status(409).json({ error: "This record is still in use and cannot be removed." });
  }

  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Request body is not valid JSON." });
  }

  console.error(err);
  return res.status(500).json({ error: "Something went wrong. Please try again." });
}

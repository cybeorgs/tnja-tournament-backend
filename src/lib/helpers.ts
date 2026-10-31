import crypto from "crypto";
import type { Request } from "express";
import prisma from "../db.js";
import { HttpError, notFound } from "../middleware/errors.js";
import type { Entrant, Rounds } from "./bracket.js";

// Crockford-style alphabet: no 0/O or 1/I/L, so numbers read back unambiguously.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function randomCode(length: number): string {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export async function newCertificateNo(): Promise<string> {
  const settings = await getSettings();
  const prefix = settings.orgShortName.replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "CERT";
  return `${prefix}-${new Date().getFullYear()}-${randomCode(8)}`;
}

export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "tournament"}-${randomCode(4).toLowerCase()}`;
}

export function getSettings() {
  return prisma.settings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
}

/** Route param as a string (Express 5 types params as string | string[]). */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || !value) throw new HttpError(400, `Missing ${name}.`);
  return value;
}

export async function findTournament(id: string) {
  const tournament = await prisma.tournament.findUnique({ where: { id } });
  if (!tournament) throw notFound("Tournament");
  return tournament;
}

export async function findDraw(drawId: string) {
  const draw = await prisma.draw.findUnique({ where: { id: drawId } });
  if (!draw) throw notFound("Draw");
  return { ...draw, rounds: draw.rounds as unknown as Rounds, entrants: draw.entrants as unknown as Entrant[] };
}

export type LoadedDraw = Awaited<ReturnType<typeof findDraw>>;

/**
 * Apply `change` to a draw's rounds and save it, retrying if someone else saved the
 * same draw in between (optimistic locking on updatedAt). `change` must be pure.
 */
export async function mutateDraw(drawId: string, change: (draw: LoadedDraw) => Rounds) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const draw = await findDraw(drawId);
    if (draw.isConcluded) throw new HttpError(409, "This category is concluded. Reopen it to change results.");
    const rounds = change(draw);
    const { count } = await prisma.draw.updateMany({
      where: { id: drawId, updatedAt: draw.updatedAt },
      data: { rounds: rounds as object[] },
    });
    if (count === 1) return findDraw(drawId);
  }
  throw new HttpError(409, "This draw was being updated by someone else. Please try again.");
}

export const categoryKey = (c: { ageGroup: string; gender: string; weightCategory: string }) =>
  `${c.ageGroup}|${c.gender}|${c.weightCategory}`;

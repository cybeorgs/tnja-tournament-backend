import { Router } from "express";
import { z } from "zod";
import prisma from "../db.js";
import { HttpError } from "../middleware/errors.js";
import { PLACEMENTS, WIN_METHODS, type Placement } from "../lib/categories.js";
import {
  DRAW_FORMATS, REPECHAGE_MIN, computePlacements, generateDraw, isRepechageFormat, isRoundRobin, recordResult, redraw, resetResult, roundRobinStandings,
  type DrawFormat, type Entrant, type Rounds,
} from "../lib/bracket.js";
import { categoryKey, findDraw, findTournament, mutateDraw, param, type LoadedDraw } from "../lib/helpers.js";

// Mounted at /tournaments/:id/... (categories, draws) and /draws/:drawId/... (see app.ts)
export const tournamentDrawsRouter = Router({ mergeParams: true });
export const drawsRouter = Router();

const playedMatches = (rounds: Rounds) => rounds.flat().filter((m) => m.status === "COMPLETED" && !m.byeResolved);

/** Draw plus everything the UI needs to show progress and medals. */
export function describeDraw(draw: LoadedDraw) {
  const matches = draw.rounds.flat().filter((m) => !m.byeResolved && !(m.isBronze && m.slotA.isBye && m.slotB.isBye));
  const { placements, complete } = computePlacements(draw.entrants, draw.rounds);
  return {
    ...draw,
    placements,
    complete,
    standings: isRoundRobin(draw.rounds) ? roundRobinStandings(draw.entrants, draw.rounds) : null,
    matchesTotal: matches.length,
    matchesDone: matches.filter((m) => m.status === "COMPLETED").length,
  };
}

// ─── Categories overview ─────────────────────────────────────────────────────

tournamentDrawsRouter.get("/categories", async (req, res) => {
  const tournamentId = param(req, "id");
  await findTournament(tournamentId);
  const [registrations, draws] = await Promise.all([
    prisma.registration.findMany({ where: { tournamentId }, select: { id: true, ageGroup: true, gender: true, weightCategory: true, paymentStatus: true, weighInStatus: true } }),
    prisma.draw.findMany({ where: { tournamentId } }),
  ]);

  type WeighIn = { cleared: number; pending: number; pendingPaid: number; disqualified: number };
  type Category = { ageGroup: string; gender: string; weightCategory: string; regIds: string[]; paid: number; weighIn: WeighIn };
  const categories = new Map<string, Category>();
  for (const r of registrations) {
    const key = categoryKey(r);
    const c = categories.get(key) ?? { ageGroup: r.ageGroup, gender: r.gender, weightCategory: r.weightCategory, regIds: [], paid: 0, weighIn: { cleared: 0, pending: 0, pendingPaid: 0, disqualified: 0 } };
    const paid = r.paymentStatus !== "PENDING";
    if (r.weighInStatus === "DISQUALIFIED") {
      c.weighIn.disqualified++; // disqualified players don't take part
    } else {
      c.regIds.push(r.id);
      if (paid) c.paid++;
      if (r.weighInStatus === "CLEARED") c.weighIn.cleared++;
      else {
        c.weighIn.pending++;
        if (paid) c.weighIn.pendingPaid++;
      }
    }
    categories.set(key, c);
  }

  const result = [...categories.values()].map((c) => {
    const raw = draws.find((d) => categoryKey(d) === categoryKey(c));
    const draw = raw ? describeDraw({ ...raw, rounds: raw.rounds as unknown as Rounds, entrants: raw.entrants as unknown as Entrant[] }) : null;
    const drawnIds = new Set(draw?.entrants.map((e) => e.id) ?? []);
    return {
      ageGroup: c.ageGroup, gender: c.gender, weightCategory: c.weightCategory,
      entrants: c.regIds.length, paid: c.paid,
      /** The draw waits until pending is 0 (pendingPaid when only paid entries are drawn) */
      weighIn: c.weighIn,
      draw: draw && {
        id: draw.id, format: draw.format, isConcluded: draw.isConcluded, matNumber: draw.matNumber,
        matchesTotal: draw.matchesTotal, matchesDone: draw.matchesDone, complete: draw.complete,
        // Students added or removed since the draw was made
        notInDraw: c.regIds.filter((id) => !drawnIds.has(id)).length,
      },
    };
  });
  result.sort((a, b) => a.ageGroup.localeCompare(b.ageGroup) || a.gender.localeCompare(b.gender) || parseFloat(a.weightCategory.replace(/[^\d.]/g, "")) - parseFloat(b.weightCategory.replace(/[^\d.]/g, "")) || a.weightCategory.localeCompare(b.weightCategory));
  res.json(result);
});

// ─── Generate ────────────────────────────────────────────────────────────────

/**
 * A manual draw. Bracket formats: `slots` lists the first round's places in order (match 1 A, match 1 B,
 * match 2 A, …), a registration id or null for a BYE. Round robin: `order` is the pool order.
 */
const manualSchema = z.object({
  slots: z.array(z.string().nullable()).max(256).optional(),
  order: z.array(z.string()).max(64).optional(),
});

const generateSchema = z.object({
  ageGroup: z.string().min(1),
  gender: z.enum(["MALE", "FEMALE"]),
  weightCategory: z.string().min(1),
  format: z.enum(["AUTO", ...DRAW_FORMATS]).default("AUTO"),
  /** Up to four registration ids in seed order (automatic draws) */
  seedIds: z.array(z.string()).max(4).default([]),
  /** Manual draw instead of an automatic one */
  manual: manualSchema.optional(),
  /** Leave out entries whose fee is still pending */
  onlyPaid: z.boolean().default(false),
  matNumber: z.coerce.number().int().min(1).max(20).optional(),
  /** Replace a draw that already has results */
  force: z.boolean().default(false),
});

/** `fallback`: a repechage format on a category too small for it uses the automatic choice instead (Draw all). */
async function buildDraw(tournamentId: string, numberOfMats: number, input: z.infer<typeof generateSchema> & { fallback?: boolean }) {
  const where = { tournamentId, ageGroup: input.ageGroup, gender: input.gender, weightCategory: input.weightCategory };
  const existing = await prisma.draw.findUnique({ where: { tournamentId_ageGroup_gender_weightCategory: where } });
  if (existing?.isConcluded) throw new HttpError(409, "This category is concluded. Reopen it before regenerating the draw.");
  if (existing && !input.force && playedMatches(existing.rounds as unknown as Rounds).length) {
    throw new HttpError(409, "Results have already been recorded in this draw. Regenerating will erase them — confirm to continue.");
  }
  if (input.matNumber && input.matNumber > numberOfMats) throw new HttpError(400, `This tournament only has ${numberOfMats} mat(s).`);

  const registrations = await prisma.registration.findMany({
    where: { ...where, weighInStatus: { not: "DISQUALIFIED" }, ...(input.onlyPaid ? { paymentStatus: { in: ["PAID", "WAIVED"] } } : {}) },
    include: { student: true },
    orderBy: { createdAt: "asc" },
  });
  if (!registrations.length) throw new HttpError(400, input.onlyPaid ? "No paid entries in this category yet." : "No students are registered in this category.");
  // Weigh-in comes first: hold the draw while anyone who would be in it hasn't been weighed.
  const notWeighed = registrations.filter((r) => r.weighInStatus !== "CLEARED");
  if (notWeighed.length) {
    const more = notWeighed.length > 5 ? ` and ${notWeighed.length - 5} more` : "";
    const names = notWeighed.slice(0, 5).map((r) => r.student.fullName).join(", ") + more;
    throw new HttpError(409, `Weigh-in pending for ${notWeighed.length} of ${registrations.length} players (${names}). Complete the weigh-in before generating this draw.`);
  }

  const entrants: Entrant[] = registrations.map((r) => ({ id: r.id, name: r.student.fullName, club: r.student.club || r.student.district || "" }));
  const seeds = input.seedIds.map((id) => entrants.find((e) => e.id === id)).filter((e): e is Entrant => !!e);
  const requested = input.fallback && input.format !== "AUTO" && isRepechageFormat(input.format) && entrants.length < REPECHAGE_MIN ? "AUTO" : input.format;
  if (input.manual && requested === "AUTO") throw new HttpError(400, "Choose the draw format for a manual draw.");
  const { format, rounds } = generateDraw(entrants, requested, input.manual ? [] : seeds, input.manual);
  const data = { format, entrants: entrants as object[], rounds: rounds as object[], matNumber: input.matNumber ?? existing?.matNumber ?? 1 };

  const draw = await prisma.draw.upsert({
    where: { tournamentId_ageGroup_gender_weightCategory: where },
    update: data,
    create: { ...where, ...data },
  });
  return describeDraw({ ...draw, rounds, entrants });
}

tournamentDrawsRouter.post("/draws", async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  res.json(await buildDraw(tournament.id, tournament.numberOfMats, generateSchema.parse(req.body)));
});

/** Generate draws for every category that doesn't have one yet, spreading them across mats. */
tournamentDrawsRouter.post("/draws/generate-all", async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  const { format, onlyPaid } = z.object({ format: generateSchema.shape.format, onlyPaid: z.boolean().default(false) }).parse(req.body);
  const [registrations, draws] = await Promise.all([
    prisma.registration.findMany({ where: { tournamentId: tournament.id }, select: { ageGroup: true, gender: true, weightCategory: true } }),
    prisma.draw.findMany({ where: { tournamentId: tournament.id }, select: { ageGroup: true, gender: true, weightCategory: true } }),
  ]);
  const drawn = new Set(draws.map(categoryKey));
  const pending = [...new Map(registrations.map((r) => [categoryKey(r), r])).values()].filter((c) => !drawn.has(categoryKey(c)));

  let created = 0;
  const skipped: string[] = [];
  for (const [i, c] of pending.entries()) {
    try {
      await buildDraw(tournament.id, tournament.numberOfMats, {
        ageGroup: c.ageGroup, gender: c.gender as "MALE" | "FEMALE", weightCategory: c.weightCategory,
        format, onlyPaid, seedIds: [], force: false, matNumber: (i % tournament.numberOfMats) + 1, fallback: true,
      });
      created++;
    } catch (err) {
      skipped.push(`${c.ageGroup} ${c.gender} ${c.weightCategory}: ${err instanceof Error ? err.message : "failed"}`);
    }
  }
  res.json({ created, skipped });
});

tournamentDrawsRouter.get("/draws", async (req, res) => {
  const tournamentId = param(req, "id");
  await findTournament(tournamentId);
  const draws = await prisma.draw.findMany({ where: { tournamentId }, orderBy: [{ ageGroup: "asc" }, { gender: "asc" }, { weightCategory: "asc" }] });
  res.json(draws.map((d) => describeDraw({ ...d, rounds: d.rounds as unknown as Rounds, entrants: d.entrants as unknown as Entrant[] })));
});

// ─── Single draw ─────────────────────────────────────────────────────────────

drawsRouter.get("/:drawId", async (req, res) => {
  res.json(describeDraw(await findDraw(param(req, "drawId"))));
});

drawsRouter.put("/:drawId", async (req, res) => {
  const draw = await findDraw(param(req, "drawId"));
  const tournament = await findTournament(draw.tournamentId);
  const { matNumber } = z.object({ matNumber: z.coerce.number().int().min(1).max(tournament.numberOfMats) }).parse(req.body);
  await prisma.draw.update({ where: { id: draw.id }, data: { matNumber } });
  res.json(describeDraw(await findDraw(draw.id)));
});

/** Change the pairings of an existing draw by hand (same format and players), until a match is played. */
drawsRouter.put("/:drawId/pairings", async (req, res) => {
  const draw = await findDraw(param(req, "drawId"));
  if (draw.isConcluded) throw new HttpError(409, "This category is concluded. Reopen it before changing the draw.");
  const manual = manualSchema.parse(req.body);
  const rounds = redraw(draw.format as DrawFormat, draw.entrants, draw.rounds, manual);
  await prisma.draw.update({ where: { id: draw.id }, data: { rounds: rounds as object[] } });
  res.json(describeDraw(await findDraw(draw.id)));
});

drawsRouter.delete("/:drawId", async (req, res) => {
  const draw = await findDraw(param(req, "drawId"));
  if (draw.isConcluded) throw new HttpError(409, "This category is concluded. Reopen it before deleting the draw.");
  await prisma.draw.delete({ where: { id: draw.id } });
  res.json({ message: "Draw deleted." });
});

const scoreSchema = z.object({
  ippon: z.coerce.number().int().min(0).max(1).default(0),
  wazaAri: z.coerce.number().int().min(0).max(2).default(0),
  shido: z.coerce.number().int().min(0).max(3).default(0),
});

const resultSchema = z.object({
  winner: z.enum(["A", "B"]),
  winMethod: z.enum(WIN_METHODS),
  scoreA: scoreSchema.default({ ippon: 0, wazaAri: 0, shido: 0 }),
  scoreB: scoreSchema.default({ ippon: 0, wazaAri: 0, shido: 0 }),
});

drawsRouter.post("/:drawId/matches/:matchId/result", async (req, res) => {
  const result = resultSchema.parse(req.body);
  const matchId = param(req, "matchId");
  const draw = await mutateDraw(param(req, "drawId"), (d) => recordResult(d.rounds, matchId, result));
  res.json(describeDraw(draw));
});

drawsRouter.delete("/:drawId/matches/:matchId/result", async (req, res) => {
  const matchId = param(req, "matchId");
  const draw = await mutateDraw(param(req, "drawId"), (d) => resetResult(d.rounds, matchId));
  res.json(describeDraw(draw));
});

// ─── Conclude / reopen ───────────────────────────────────────────────────────

const concludeSchema = z.object({
  /** Override the placements worked out from the bracket (registration id → placement) */
  placements: z.record(z.string(), z.enum(PLACEMENTS)).optional(),
});

drawsRouter.post("/:drawId/conclude", async (req, res) => {
  const draw = await findDraw(param(req, "drawId"));
  if (draw.isConcluded) throw new HttpError(409, "This category is already concluded.");
  const { placements: overrides } = concludeSchema.parse(req.body);
  const computed = computePlacements(draw.entrants, draw.rounds);

  if (!overrides && !computed.complete) {
    throw new HttpError(409, "Some matches in this category are still to be played. Finish them, or set the placements by hand.");
  }

  const final: Record<string, Placement> = { ...computed.placements };
  if (overrides) {
    for (const [regId, placement] of Object.entries(overrides)) {
      if (!(regId in final)) throw new HttpError(400, "A placement was given for a student who is not in this draw.");
      final[regId] = placement;
    }
    const count = (p: Placement) => Object.values(final).filter((v) => v === p).length;
    if (count("FIRST") > 1 || count("SECOND") > 1) throw new HttpError(400, "Only one student can be placed first and one second.");
    if (count("THIRD") > 2) throw new HttpError(400, "At most two students can be placed third.");
  }

  await prisma.$transaction([
    ...Object.entries(final).map(([regId, placement]) => prisma.registration.update({ where: { id: regId }, data: { placement } })),
    prisma.draw.update({ where: { id: draw.id }, data: { isConcluded: true, concludedAt: new Date() } }),
  ]);
  res.json(describeDraw(await findDraw(draw.id)));
});

drawsRouter.post("/:drawId/reopen", async (req, res) => {
  const draw = await findDraw(param(req, "drawId"));
  if (!draw.isConcluded) throw new HttpError(409, "This category is not concluded.");
  await prisma.$transaction([
    prisma.registration.updateMany({ where: { id: { in: draw.entrants.map((e) => e.id) } }, data: { placement: null } }),
    prisma.draw.update({ where: { id: draw.id }, data: { isConcluded: false, concludedAt: null } }),
  ]);
  res.json(describeDraw(await findDraw(draw.id)));
});

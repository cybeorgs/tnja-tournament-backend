// ─── Bracket engine ──────────────────────────────────────────────────────────
// Pure functions: no database access. Player ids inside a bracket are
// registration ids, so a result maps straight back to a registration.
//
// Elimination layout: rounds[0] is the first round; each match i in round r
// feeds match floor(i/2) of round r+1 (slot A when i is even, slot B when odd).
// From 4 entrants up, the last round holds two matches: [final, bronze], and the
// two semi-final losers meet in the bronze match.

import { HttpError } from "../middleware/errors.js";
import type { Placement } from "./categories.js";

export interface Entrant {
  id: string;
  name: string;
  club: string;
}

export interface Slot {
  playerId: string | null;
  playerName: string;
  club: string;
  isBye: boolean;
  seedNumber?: number;
}

export interface Score {
  ippon: number;
  wazaAri: number;
  shido: number;
}

export interface Match {
  matchId: string;
  round: number;
  matchNumber: number;
  slotA: Slot;
  slotB: Slot;
  winnerId: string | null;
  status: "PENDING" | "COMPLETED";
  scoreA?: Score;
  scoreB?: Score;
  winMethod?: string;
  isBronze?: boolean;
  /** True when the match was decided by a BYE rather than played. */
  byeResolved?: boolean;
  completedAt?: string;
}

export type Rounds = Match[][];
export type DrawFormat = "ELIMINATION" | "ROUND_ROBIN";

/** Categories with this many entrants or fewer are run as a round robin by default. */
export const ROUND_ROBIN_MAX = 5;

const TBD = (): Slot => ({ playerId: null, playerName: "TBD", club: "", isBye: false });
const BYE = (): Slot => ({ playerId: null, playerName: "BYE", club: "", isBye: true });
const toSlot = (e: Entrant, seedNumber?: number): Slot => ({
  playerId: e.id,
  playerName: e.name,
  club: e.club,
  isBye: false,
  ...(seedNumber ? { seedNumber } : {}),
});

const clone = (rounds: Rounds): Rounds => rounds.map((r) => r.map((m) => ({ ...m, slotA: { ...m.slotA }, slotB: { ...m.slotB } })));

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Shuffle, then deal clubs round-robin so team-mates are spread across the bracket. */
export function clubSeparatedShuffle(entrants: Entrant[]): Entrant[] {
  const groups = new Map<string, Entrant[]>();
  for (const e of shuffle(entrants)) {
    const key = e.club.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) || []), e]);
  }
  const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
  const result: Entrant[] = [];
  while (sorted.some((g) => g.length)) {
    for (const g of sorted) {
      const next = g.shift();
      if (next) result.push(next);
    }
  }
  return result;
}

// Standard IJF BYE allocation: alternate lower/upper halves, working inwards.
export function byeMatchOrder(matchCount: number): number[] {
  const order: number[] = [];
  const add = (i: number) => {
    if (i >= 0 && i < matchCount && !order.includes(i)) order.push(i);
  };
  const half = Math.floor(matchCount / 2);
  for (let k = 0; k < Math.max(1, half); k++) {
    add(matchCount - 1 - k);
    add(k);
    add(half + k);
    add(half - 1 - k);
  }
  for (let i = 0; i < matchCount; i++) add(i);
  return order;
}

/**
 * IJF elimination bracket. `seeds` are up to four entrants in seed order:
 * seed 1 bottom, seed 2 top, seed 3 third quarter, seed 4 second quarter.
 */
export function generateElimination(entrants: Entrant[], seeds: Entrant[] = []): Rounds {
  const size = nextPow2(Math.max(entrants.length, 2));
  const matchCount = size / 2;
  const slots: (Slot | null)[] = new Array(size).fill(null);

  const seedPositions = [size - 1, 0, Math.floor((3 * size) / 4), Math.floor(size / 4)];
  seeds.slice(0, 4).forEach((s, i) => {
    slots[seedPositions[i]!] = toSlot(s, i + 1);
  });

  const seededIds = new Set(seeds.slice(0, 4).map((s) => s.id));
  const unseeded = clubSeparatedShuffle(entrants.filter((e) => !seededIds.has(e.id)));

  const byes = size - entrants.length;
  for (const mi of byeMatchOrder(matchCount).slice(0, byes)) {
    const a = mi * 2;
    const b = a + 1;
    if (slots[a] && !slots[b]) slots[b] = BYE();
    else if (slots[b] && !slots[a]) slots[a] = BYE();
    else slots[b] = BYE();
  }

  let next = 0;
  for (let i = 0; i < size; i++) {
    if (!slots[i]) {
      const e = unseeded[next++];
      slots[i] = e ? toSlot(e) : BYE();
    }
  }

  const rounds: Rounds = [];
  const first: Match[] = [];
  for (let i = 0; i < matchCount; i++) {
    first.push({
      matchId: `R1M${i + 1}`, round: 1, matchNumber: i + 1,
      slotA: slots[i * 2]!, slotB: slots[i * 2 + 1]!, winnerId: null, status: "PENDING",
    });
  }
  rounds.push(first);

  let count = matchCount;
  let roundNo = 2;
  while (count > 1) {
    count /= 2;
    const round: Match[] = [];
    for (let i = 0; i < count; i++) {
      round.push({ matchId: `R${roundNo}M${i + 1}`, round: roundNo, matchNumber: i + 1, slotA: TBD(), slotB: TBD(), winnerId: null, status: "PENDING" });
    }
    if (count === 1 && size >= 4) {
      round.push({ matchId: "BRONZE", round: roundNo, matchNumber: 2, slotA: TBD(), slotB: TBD(), winnerId: null, status: "PENDING", isBronze: true });
    }
    rounds.push(round);
    roundNo++;
  }

  return settle(rounds);
}

/** Everyone meets everyone once (circle method). Three entrants use the IJF order 1v2, 2v3, 3v1. */
export function generateRoundRobin(entrants: Entrant[]): Rounds {
  const list = shuffle(entrants);
  if (list.length < 2) return [];

  const pairings: [Entrant, Entrant][][] = [];
  if (list.length === 3) {
    const [a, b, c] = list as [Entrant, Entrant, Entrant];
    pairings.push([[a, b]], [[b, c]], [[c, a]]);
  } else {
    const ring: (Entrant | null)[] = [...list];
    if (ring.length % 2) ring.push(null);
    for (let r = 0; r < ring.length - 1; r++) {
      const round: [Entrant, Entrant][] = [];
      for (let i = 0; i < ring.length / 2; i++) {
        const a = ring[i];
        const b = ring[ring.length - 1 - i];
        if (a && b) round.push([a, b]);
      }
      pairings.push(round);
      ring.splice(1, 0, ring.pop()!);
    }
  }

  return pairings.map((round, ri) =>
    round.map(([a, b], mi) => ({
      matchId: `RR${ri + 1}M${mi + 1}`, round: ri + 1, matchNumber: mi + 1,
      slotA: toSlot(a), slotB: toSlot(b), winnerId: null, status: "PENDING" as const,
    })),
  );
}

export function generateDraw(entrants: Entrant[], format: DrawFormat | "AUTO", seeds: Entrant[] = []) {
  const resolved: DrawFormat = format === "AUTO" ? (entrants.length <= ROUND_ROBIN_MAX ? "ROUND_ROBIN" : "ELIMINATION") : format;
  // A lone entrant has no matches and wins the category outright.
  if (entrants.length < 2) return { format: resolved, rounds: [] as Rounds };
  return { format: resolved, rounds: resolved === "ROUND_ROBIN" ? generateRoundRobin(entrants) : generateElimination(entrants, seeds) };
}

export const isRoundRobin = (rounds: Rounds) => !!rounds[0]?.[0]?.matchId.startsWith("RR");

function locate(rounds: Rounds, matchId: string) {
  for (let ri = 0; ri < rounds.length; ri++) {
    const mi = rounds[ri]!.findIndex((m) => m.matchId === matchId);
    if (mi >= 0) return { ri, mi, match: rounds[ri]![mi]! };
  }
  throw new HttpError(404, "Match not found in this draw.");
}

const bronzeOf = (rounds: Rounds) => rounds[rounds.length - 1]?.find((m) => m.isBronze);
const isSemiRound = (rounds: Rounds, ri: number) => !!bronzeOf(rounds) && ri === rounds.length - 2;

/** The slot a match result feeds in the next round, or null for the final/bronze/round robin. */
function feedTarget(rounds: Rounds, ri: number, mi: number) {
  if (isRoundRobin(rounds) || ri >= rounds.length - 1) return null;
  return { match: rounds[ri + 1]![Math.floor(mi / 2)]!, key: (mi % 2 === 0 ? "slotA" : "slotB") as "slotA" | "slotB" };
}

// Fill the bronze match from finished semi-finals and auto-advance through BYEs.
// Idempotent, so it runs after every change.
function settle(input: Rounds): Rounds {
  const rounds = clone(input);
  if (isRoundRobin(rounds)) return rounds;

  for (let ri = 0; ri < rounds.length; ri++) {
    rounds[ri]!.forEach((m, mi) => {
      if (m.status === "COMPLETED") return;
      const winner = m.slotA.isBye && m.slotB.playerId ? m.slotB : m.slotB.isBye && m.slotA.playerId ? m.slotA : null;
      if (!winner) return;
      Object.assign(m, { winnerId: winner.playerId, status: "COMPLETED", byeResolved: true });
      const target = feedTarget(rounds, ri, mi);
      if (target) target.match[target.key] = { ...winner };
    });

    if (isSemiRound(rounds, ri)) {
      const bronze = bronzeOf(rounds)!;
      if (bronze.status === "COMPLETED") continue;
      rounds[ri]!.forEach((semi, mi) => {
        if (semi.status !== "COMPLETED") return;
        const loser = semi.winnerId === semi.slotA.playerId ? semi.slotB : semi.slotA;
        bronze[mi === 0 ? "slotA" : "slotB"] = loser.playerId ? { ...loser } : BYE();
      });
      // Both semi-finals were walkovers: nobody is left to fight for bronze.
      if (bronze.slotA.isBye && bronze.slotB.isBye) Object.assign(bronze, { status: "COMPLETED", byeResolved: true, winnerId: null });
    }
  }
  return rounds;
}

export interface ResultInput {
  winner: "A" | "B";
  winMethod: string;
  scoreA: Score;
  scoreB: Score;
}

export function recordResult(input: Rounds, matchId: string, result: ResultInput): Rounds {
  let rounds = clone(input);
  const { ri, mi, match } = locate(rounds, matchId);
  if (!match.slotA.playerId || !match.slotB.playerId) {
    throw new HttpError(400, "Both players must be known before a result can be recorded.");
  }
  if (match.byeResolved) throw new HttpError(400, "This match was decided by a BYE.");

  const winnerSlot = result.winner === "A" ? match.slotA : match.slotB;
  const changingWinner = match.status === "COMPLETED" && match.winnerId !== winnerSlot.playerId;
  if (changingWinner) assertDownstreamOpen(rounds, ri, mi);

  Object.assign(match, {
    winnerId: winnerSlot.playerId, status: "COMPLETED", winMethod: result.winMethod,
    scoreA: result.scoreA, scoreB: result.scoreB, completedAt: new Date().toISOString(),
  });

  const target = feedTarget(rounds, ri, mi);
  if (target) target.match[target.key] = { ...winnerSlot };
  if (changingWinner && isSemiRound(rounds, ri)) clearBronzeSlot(rounds, mi);

  rounds = settle(rounds);
  return rounds;
}

export function resetResult(input: Rounds, matchId: string): Rounds {
  const rounds = clone(input);
  const { ri, mi, match } = locate(rounds, matchId);
  if (match.status !== "COMPLETED") throw new HttpError(400, "This match has no result to undo.");
  if (match.byeResolved) throw new HttpError(400, "A match decided by a BYE cannot be undone.");
  assertDownstreamOpen(rounds, ri, mi);

  Object.assign(match, { winnerId: null, status: "PENDING" });
  delete match.winMethod;
  delete match.scoreA;
  delete match.scoreB;
  delete match.completedAt;

  const target = feedTarget(rounds, ri, mi);
  if (target) target.match[target.key] = TBD();
  if (isSemiRound(rounds, ri)) clearBronzeSlot(rounds, mi);
  return rounds;
}

function clearBronzeSlot(rounds: Rounds, semiIndex: number) {
  const bronze = bronzeOf(rounds);
  if (bronze) bronze[semiIndex === 0 ? "slotA" : "slotB"] = TBD();
}

function assertDownstreamOpen(rounds: Rounds, ri: number, mi: number) {
  const target = feedTarget(rounds, ri, mi);
  if (target && target.match.status === "COMPLETED" && !target.match.byeResolved) {
    throw new HttpError(409, `Undo the result of match ${target.match.matchId} first — this match's winner already played in it.`);
  }
  const bronze = bronzeOf(rounds);
  if (isSemiRound(rounds, ri) && bronze?.status === "COMPLETED" && !bronze.byeResolved) {
    throw new HttpError(409, "Undo the bronze medal match first — this semi-final's loser already played in it.");
  }
}

export interface Standing {
  entrantId: string;
  wins: number;
  losses: number;
  points: number;
}

/** Round-robin table: wins, then head-to-head (two-way ties), then technical points. */
export function roundRobinStandings(entrants: Entrant[], rounds: Rounds): Standing[] {
  const table = new Map<string, Standing>(entrants.map((e) => [e.id, { entrantId: e.id, wins: 0, losses: 0, points: 0 }]));
  const headToHead = new Map<string, string>();

  for (const m of rounds.flat()) {
    if (m.status !== "COMPLETED" || !m.winnerId) continue;
    const a = table.get(m.slotA.playerId || "");
    const b = table.get(m.slotB.playerId || "");
    if (!a || !b) continue;
    const winner = m.winnerId === a.entrantId ? a : b;
    const loser = winner === a ? b : a;
    winner.wins++;
    loser.losses++;
    a.points += (m.scoreA?.ippon || 0) * 10 + (m.scoreA?.wazaAri || 0);
    b.points += (m.scoreB?.ippon || 0) * 10 + (m.scoreB?.wazaAri || 0);
    headToHead.set([a.entrantId, b.entrantId].sort().join("|"), winner.entrantId);
  }

  return [...table.values()].sort((x, y) => {
    if (y.wins !== x.wins) return y.wins - x.wins;
    const h2h = headToHead.get([x.entrantId, y.entrantId].sort().join("|"));
    if (h2h) return h2h === x.entrantId ? -1 : 1;
    return y.points - x.points;
  });
}

/**
 * Placements implied by the bracket so far. `complete` is true once every medal is decided.
 * Entrants without a medal are PARTICIPATION.
 */
export function computePlacements(entrants: Entrant[], rounds: Rounds): { placements: Record<string, Placement>; complete: boolean } {
  const placements: Record<string, Placement> = Object.fromEntries(entrants.map((e) => [e.id, "PARTICIPATION" as Placement]));

  if (entrants.length === 1) {
    placements[entrants[0]!.id] = "FIRST";
    return { placements, complete: true };
  }
  if (rounds.length === 0) return { placements, complete: false };

  if (isRoundRobin(rounds)) {
    const complete = rounds.flat().every((m) => m.status === "COMPLETED");
    if (complete) {
      const medals: Placement[] = ["FIRST", "SECOND", "THIRD"];
      roundRobinStandings(entrants, rounds).slice(0, 3).forEach((s, i) => {
        placements[s.entrantId] = medals[i]!;
      });
    }
    return { placements, complete };
  }

  const last = rounds[rounds.length - 1]!;
  const final = last.find((m) => !m.isBronze)!;
  const bronze = last.find((m) => m.isBronze);
  if (final.status === "COMPLETED" && final.winnerId) {
    const runnerUp = final.winnerId === final.slotA.playerId ? final.slotB : final.slotA;
    placements[final.winnerId] = "FIRST";
    if (runnerUp.playerId) placements[runnerUp.playerId] = "SECOND";
  }
  if (bronze?.status === "COMPLETED" && bronze.winnerId) placements[bronze.winnerId] = "THIRD";

  const complete = final.status === "COMPLETED" && (!bronze || bronze.status === "COMPLETED");
  return { placements, complete };
}

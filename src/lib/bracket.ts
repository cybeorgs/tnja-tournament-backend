// ─── Bracket engine ──────────────────────────────────────────────────────────
// Pure functions: no database access. Player ids inside a bracket are
// registration ids, so a result maps straight back to a registration.
//
// Elimination layout: rounds[0] is the first round; each match i in round r
// feeds match floor(i/2) of round r+1 (slot A when i is even, slot B when odd).
//
// ELIMINATION: from 4 entrants up, the last round holds two matches: [final, bronze],
// and the two semi-final losers meet in the bronze match.
//
// REPECHAGE / DOUBLE_REPECHAGE: the main bracket ends with the final alone, followed by
// two extra rounds (a repechage round, then the bronze round). Their matches carry
// `repechage: true` and `sources` saying where each player comes from; settle() fills
// them in from the main bracket's results.

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

/**
 * A repechage slot is filled by the winner or loser of an earlier match, or (single repechage) by whoever
 * the champion / runner-up beat in the quarter- or semi-final.
 */
export type Source =
  | { from: string; take: "WINNER" | "LOSER" }
  | { take: "BEATEN_BY_CHAMPION" | "BEATEN_BY_RUNNER_UP"; stage: "QF" | "SF" };

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
  /** Repechage formats: a repechage or bronze-medal match, filled from the main bracket's results */
  repechage?: boolean;
  /** Where a repechage match's two players come from (slot A, slot B) */
  sources?: [Source, Source];
  /** Display name, e.g. "Repechage 1" or "Bronze 2" */
  label?: string;
}

export type Rounds = Match[][];

/**
 * ELIMINATION: single elimination, the semi-final losers meet for one bronze.
 * REPECHAGE: single repechage, one bronze (see addRepechage).
 * DOUBLE_REPECHAGE: IJF standard, quarter-final losers get a second chance, two bronzes.
 * ROUND_ROBIN: everyone meets everyone.
 */
export const DRAW_FORMATS = ["ELIMINATION", "REPECHAGE", "DOUBLE_REPECHAGE", "ROUND_ROBIN"] as const;
export type DrawFormat = (typeof DRAW_FORMATS)[number];
export type BracketFormat = Exclude<DrawFormat, "ROUND_ROBIN">;

/** Categories with this many entrants or fewer are run as a round robin by default. */
export const ROUND_ROBIN_MAX = 5;
/** Repechage needs quarter-finals (an 8-slot bracket), so at least this many players. */
export const REPECHAGE_MIN = 5;

export const isRepechageFormat = (f: DrawFormat) => f === "REPECHAGE" || f === "DOUBLE_REPECHAGE";

const TBD = (): Slot => ({ playerId: null, playerName: "TBD", club: "", isBye: false });
const BYE = (): Slot => ({ playerId: null, playerName: "BYE", club: "", isBye: true });
const toSlot = (e: Entrant, seedNumber?: number): Slot => ({
  playerId: e.id,
  playerName: e.name,
  club: e.club,
  isBye: false,
  ...(seedNumber ? { seedNumber } : {}),
});

const clone = (rounds: Rounds): Rounds =>
  rounds.map((r) => r.map((m) => ({ ...m, slotA: { ...m.slotA }, slotB: { ...m.slotB }, ...(m.sources ? { sources: [...m.sources] as [Source, Source] } : {}) })));

export function bracketSize(entrants: number): number {
  let p = 1;
  while (p < Math.max(entrants, 2)) p <<= 1;
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
 * Automatic first-round slots. `seeds` are up to four entrants in seed order:
 * seed 1 bottom, seed 2 top, seed 3 third quarter, seed 4 second quarter.
 */
function automaticSlots(entrants: Entrant[], seeds: Entrant[]): Slot[] {
  const size = bracketSize(entrants.length);
  const slots: (Slot | null)[] = new Array(size).fill(null);

  const seedPositions = [size - 1, 0, Math.floor((3 * size) / 4), Math.floor(size / 4)];
  seeds.slice(0, 4).forEach((s, i) => {
    slots[seedPositions[i]!] = toSlot(s, i + 1);
  });

  const seededIds = new Set(seeds.slice(0, 4).map((s) => s.id));
  const unseeded = clubSeparatedShuffle(entrants.filter((e) => !seededIds.has(e.id)));

  const byes = size - entrants.length;
  for (const mi of byeMatchOrder(size / 2).slice(0, byes)) {
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
  return slots as Slot[];
}

/**
 * Manual first round: `ids` lists the bracket's slots in order (match 1 slot A, match 1 slot B, match 2 slot A, …),
 * a registration id or null for a BYE. Every entrant appears exactly once and no match is BYE against BYE.
 */
export function manualSlots(entrants: Entrant[], ids: (string | null)[]): Slot[] {
  const size = bracketSize(entrants.length);
  if (ids.length !== size) throw new HttpError(400, `This bracket has ${size} places (${size / 2} first-round matches) — got ${ids.length}.`);
  const byId = new Map(entrants.map((e) => [e.id, e]));
  const seen = new Set<string>();
  for (const id of ids) {
    if (id === null) continue;
    if (!byId.has(id)) throw new HttpError(400, "The draw includes a player who isn't in this category.");
    if (seen.has(id)) throw new HttpError(400, `${byId.get(id)!.name} is placed more than once.`);
    seen.add(id);
  }
  const missing = entrants.filter((e) => !seen.has(e.id));
  if (missing.length) throw new HttpError(400, `Place every player in the draw — missing: ${missing.map((e) => e.name).join(", ")}.`);
  for (let i = 0; i < size; i += 2) {
    if (ids[i] === null && ids[i + 1] === null) throw new HttpError(400, `Match ${i / 2 + 1} has no players — every first-round match needs at least one.`);
  }
  return ids.map((id) => (id ? toSlot(byId.get(id)!) : BYE()));
}

/** Build the whole bracket from its first-round slots. */
export function bracketFromSlots(slots: Slot[], format: BracketFormat = "ELIMINATION"): Rounds {
  const size = slots.length;
  const matchCount = size / 2;
  const repechage = isRepechageFormat(format);
  if (repechage && size < 8) throw new HttpError(400, `Repechage needs quarter-finals — at least ${REPECHAGE_MIN} players. Use elimination or round robin.`);

  const rounds: Rounds = [];
  const first: Match[] = [];
  for (let i = 0; i < matchCount; i++) {
    first.push({
      matchId: `R1M${i + 1}`, round: 1, matchNumber: i + 1,
      slotA: { ...slots[i * 2]! }, slotB: { ...slots[i * 2 + 1]! }, winnerId: null, status: "PENDING",
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
    if (count === 1 && size >= 4 && !repechage) {
      round.push({ matchId: "BRONZE", round: roundNo, matchNumber: 2, slotA: TBD(), slotB: TBD(), winnerId: null, status: "PENDING", isBronze: true });
    }
    rounds.push(round);
    roundNo++;
  }

  if (repechage) addRepechage(rounds, format === "DOUBLE_REPECHAGE");
  return settle(rounds);
}

/**
 * Appends the repechage round and the bronze round.
 *
 * Double repechage (IJF): the quarter-final losers of each half meet (Repechage 1: QF1 v QF2 losers,
 * Repechage 2: QF3 v QF4 losers); each winner fights the losing semi-finalist from the other half for
 * one of two bronze medals.
 *
 * Single repechage: once the final is decided, the players the champion beat in the quarter-final and
 * semi-final meet; the winner fights the player the runner-up beat in the semi-final for one bronze.
 */
function addRepechage(rounds: Rounds, double: boolean) {
  const qf = rounds[rounds.length - 3]!.map((m) => m.matchId);
  const sf = rounds[rounds.length - 2]!.map((m) => m.matchId);
  const repRound = rounds.length + 1;
  const make = (matchId: string, round: number, matchNumber: number, label: string, sources: [Source, Source]): Match => ({
    matchId, round, matchNumber, label, sources, repechage: true, slotA: TBD(), slotB: TBD(), winnerId: null, status: "PENDING",
  });
  if (double) {
    rounds.push([
      make("REP1", repRound, 1, "Repechage 1", [{ from: qf[0]!, take: "LOSER" }, { from: qf[1]!, take: "LOSER" }]),
      make("REP2", repRound, 2, "Repechage 2", [{ from: qf[2]!, take: "LOSER" }, { from: qf[3]!, take: "LOSER" }]),
    ]);
    rounds.push([
      make("BR1", repRound + 1, 1, "Bronze 1", [{ from: "REP1", take: "WINNER" }, { from: sf[1]!, take: "LOSER" }]),
      make("BR2", repRound + 1, 2, "Bronze 2", [{ from: "REP2", take: "WINNER" }, { from: sf[0]!, take: "LOSER" }]),
    ]);
  } else {
    rounds.push([make("REP1", repRound, 1, "Repechage", [{ take: "BEATEN_BY_CHAMPION", stage: "QF" }, { take: "BEATEN_BY_CHAMPION", stage: "SF" }])]);
    rounds.push([make("BR1", repRound + 1, 1, "Bronze", [{ from: "REP1", take: "WINNER" }, { take: "BEATEN_BY_RUNNER_UP", stage: "SF" }])]);
  }
}

/** Elimination-style bracket (any of the three bracket formats) with automatic, seeded placement. */
export function generateElimination(entrants: Entrant[], seeds: Entrant[] = [], format: BracketFormat = "ELIMINATION"): Rounds {
  return bracketFromSlots(automaticSlots(entrants, seeds), format);
}

/**
 * Everyone meets everyone once (circle method). Three entrants use the IJF order 1v2, 2v3, 3v1.
 * `ordered` keeps the entrants in the order given (a manual pool order) instead of shuffling.
 */
export function generateRoundRobin(entrants: Entrant[], ordered = false): Rounds {
  const list = ordered ? [...entrants] : shuffle(entrants);
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

/** Pool order for a manual round robin: every entrant exactly once. */
export function manualOrder(entrants: Entrant[], ids: string[]): Entrant[] {
  const byId = new Map(entrants.map((e) => [e.id, e]));
  if (ids.length !== entrants.length || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) {
    throw new HttpError(400, "List every player in the pool exactly once.");
  }
  return ids.map((id) => byId.get(id)!);
}

/** A manual draw: the first-round slots (bracket formats) or the pool order (round robin). */
export interface ManualDraw {
  slots?: (string | null)[];
  order?: string[];
}

export function generateDraw(entrants: Entrant[], format: DrawFormat | "AUTO", seeds: Entrant[] = [], manual?: ManualDraw) {
  const resolved: DrawFormat = format === "AUTO" ? (entrants.length <= ROUND_ROBIN_MAX ? "ROUND_ROBIN" : "ELIMINATION") : format;
  // A lone entrant has no matches and wins the category outright.
  if (entrants.length < 2) return { format: resolved, rounds: [] as Rounds };
  if (resolved === "ROUND_ROBIN") {
    return { format: resolved, rounds: manual?.order ? generateRoundRobin(manualOrder(entrants, manual.order), true) : generateRoundRobin(entrants) };
  }
  if (isRepechageFormat(resolved) && entrants.length < REPECHAGE_MIN) {
    throw new HttpError(400, `Repechage needs quarter-finals — at least ${REPECHAGE_MIN} players (this category has ${entrants.length}). Use elimination or round robin.`);
  }
  const slots = manual?.slots ? manualSlots(entrants, manual.slots) : automaticSlots(entrants, seeds);
  return { format: resolved, rounds: bracketFromSlots(slots, resolved) };
}

/**
 * Redo the pairings of an existing draw (same format and players). Only allowed while no match has been played.
 */
export function redraw(format: DrawFormat, entrants: Entrant[], rounds: Rounds, manual: ManualDraw): Rounds {
  if (rounds.flat().some((m) => m.status === "COMPLETED" && !m.byeResolved)) {
    throw new HttpError(409, "Matches have already been played in this draw. Undo their results before changing the pairings.");
  }
  if (format === "ROUND_ROBIN") {
    if (!manual.order) throw new HttpError(400, "Give the pool order.");
    return generateRoundRobin(manualOrder(entrants, manual.order), true);
  }
  if (!manual.slots) throw new HttpError(400, "Give the first-round pairings.");
  return bracketFromSlots(manualSlots(entrants, manual.slots), format);
}

export const isRoundRobin = (rounds: Rounds) => !!rounds[0]?.[0]?.matchId.startsWith("RR");

function locate(rounds: Rounds, matchId: string) {
  for (let ri = 0; ri < rounds.length; ri++) {
    const mi = rounds[ri]!.findIndex((m) => m.matchId === matchId);
    if (mi >= 0) return { ri, mi, match: rounds[ri]![mi]! };
  }
  throw new HttpError(404, "Match not found in this draw.");
}

/** Rounds of the main bracket (everything before the repechage rounds). */
const mainRoundCount = (rounds: Rounds) => rounds.filter((r) => !r[0]?.repechage).length;
const hasRepechage = (rounds: Rounds) => rounds.some((r) => r[0]?.repechage);
const bronzeOf = (rounds: Rounds) => (hasRepechage(rounds) ? undefined : rounds[rounds.length - 1]?.find((m) => m.isBronze));
const isSemiRound = (rounds: Rounds, ri: number) => !!bronzeOf(rounds) && ri === rounds.length - 2;

/** The slot a match result feeds in the next round, or null for the final/bronze/repechage/round robin. */
function feedTarget(rounds: Rounds, ri: number, mi: number) {
  if (isRoundRobin(rounds) || ri >= mainRoundCount(rounds) - 1) return null;
  return { match: rounds[ri + 1]![Math.floor(mi / 2)]!, key: (mi % 2 === 0 ? "slotA" : "slotB") as "slotA" | "slotB" };
}

const winnerSlotOf = (m: Match) => (m.winnerId ? (m.winnerId === m.slotA.playerId ? m.slotA : m.slotB) : null);
const loserSlotOf = (m: Match, winnerId: string) => (m.slotA.playerId === winnerId ? m.slotB : m.slotA);
const asEntry = (s: Slot): Slot => (s.playerId ? { playerId: s.playerId, playerName: s.playerName, club: s.club, isBye: false } : BYE());

// Fill the bronze match from finished semi-finals, auto-advance through BYEs and fill
// the repechage rounds. Idempotent, so it runs after every change.
function settle(input: Rounds): Rounds {
  const rounds = clone(input);
  if (isRoundRobin(rounds)) return rounds;

  const main = mainRoundCount(rounds);
  for (let ri = 0; ri < main; ri++) {
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

  if (hasRepechage(rounds)) settleRepechage(rounds, main);
  return rounds;
}

/** Recompute every repechage match that hasn't been played from the results it depends on. */
function settleRepechage(rounds: Rounds, main: number) {
  const byId = new Map(rounds.flat().map((m) => [m.matchId, m]));
  const final = rounds[main - 1]![0]!;

  // null = not decided yet (TBD); a BYE slot = nobody comes from there.
  const resolve = (s: Source): Slot | null => {
    if ("from" in s) {
      const m = byId.get(s.from);
      if (!m || m.status !== "COMPLETED") return null;
      const winner = winnerSlotOf(m);
      if (s.take === "WINNER") return winner ? asEntry(winner) : BYE();
      return winner ? asEntry(loserSlotOf(m, winner.playerId!)) : BYE();
    }
    if (final.status !== "COMPLETED" || !final.winnerId) return null;
    const who = s.take === "BEATEN_BY_CHAMPION" ? final.winnerId : loserSlotOf(final, final.winnerId).playerId;
    if (!who) return BYE();
    const stage = rounds[main - (s.stage === "QF" ? 3 : 2)]!;
    const beaten = stage.find((m) => m.status === "COMPLETED" && m.winnerId === who);
    return beaten ? asEntry(loserSlotOf(beaten, who)) : BYE();
  };

  for (let ri = main; ri < rounds.length; ri++) {
    for (const m of rounds[ri]!) {
      if (m.status === "COMPLETED" && !m.byeResolved) continue; // played: keep as it is
      Object.assign(m, { status: "PENDING", winnerId: null });
      delete m.byeResolved;
      m.slotA = resolve(m.sources![0]) ?? TBD();
      m.slotB = resolve(m.sources![1]) ?? TBD();
      const { slotA: a, slotB: b } = m;
      if (a.isBye && b.isBye) Object.assign(m, { status: "COMPLETED", winnerId: null, byeResolved: true });
      else if (a.isBye && b.playerId) Object.assign(m, { status: "COMPLETED", winnerId: b.playerId, byeResolved: true });
      else if (b.isBye && a.playerId) Object.assign(m, { status: "COMPLETED", winnerId: a.playerId, byeResolved: true });
    }
  }
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
  return settle(rounds);
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
  if (!hasRepechage(rounds)) return;

  const main = mainRoundCount(rounds);
  const played = rounds.slice(main).flat().filter((m) => m.status === "COMPLETED" && !m.byeResolved);
  const match = rounds[ri]![mi]!;
  // A repechage match feeding a played bronze match
  const fed = played.find((m) => m.sources?.some((s) => "from" in s && s.from === match.matchId));
  if (fed) throw new HttpError(409, `Undo the ${fed.label ?? fed.matchId} result first — it depends on this match.`);
  // The quarter- and semi-finals decide who is in the repechage (and, in single repechage, the final too)
  const double = rounds[main]!.length === 2;
  if (ri >= main - 3 && ri <= (double ? main - 2 : main - 1) && played.length) {
    throw new HttpError(409, "Undo the repechage and bronze results first — they depend on this match.");
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

  const main = mainRoundCount(rounds);
  const finalRound = rounds[main - 1]!;
  const final = finalRound.find((m) => !m.isBronze)!;
  if (final.status === "COMPLETED" && final.winnerId) {
    const runnerUp = loserSlotOf(final, final.winnerId);
    placements[final.winnerId] = "FIRST";
    if (runnerUp.playerId) placements[runnerUp.playerId] = "SECOND";
  }

  // Bronze: the ELIMINATION bronze match, or the repechage formats' bronze round
  const bronzeMatches = hasRepechage(rounds) ? rounds[rounds.length - 1]! : finalRound.filter((m) => m.isBronze);
  for (const m of bronzeMatches) if (m.status === "COMPLETED" && m.winnerId) placements[m.winnerId] = "THIRD";

  const complete = final.status === "COMPLETED" && rounds.slice(main).flat().concat(bronzeMatches).every((m) => m.status === "COMPLETED");
  return { placements, complete };
}

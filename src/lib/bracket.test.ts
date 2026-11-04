import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlacements, generateDraw, generateElimination, recordResult, redraw, resetResult, type Entrant, type Rounds } from "./bracket.js";
import { eligibleAgeGroups, weightCategoryFor } from "./categories.js";

const people = (n: number, clubs = 3): Entrant[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}`, club: `Club ${i % clubs}` }));

const win = (rounds: Rounds, matchId: string, winner: "A" | "B" = "A") =>
  recordResult(rounds, matchId, { winner, winMethod: "IPPON", scoreA: { ippon: 1, wazaAri: 0, shido: 0 }, scoreB: { ippon: 0, wazaAri: 0, shido: 0 } });

/** Play every playable match (slot A always wins) until nothing is left. */
function playAll(rounds: Rounds): Rounds {
  for (;;) {
    const next = rounds.flat().find((m) => m.status === "PENDING" && m.slotA.playerId && m.slotB.playerId);
    if (!next) return rounds;
    rounds = win(rounds, next.matchId);
  }
}

test("8-player elimination produces gold, silver and bronze", () => {
  const entrants = people(8);
  const rounds = playAll(generateElimination(entrants));
  const { placements, complete } = computePlacements(entrants, rounds);
  assert.equal(complete, true);
  const values = Object.values(placements);
  assert.equal(values.filter((p) => p === "FIRST").length, 1);
  assert.equal(values.filter((p) => p === "SECOND").length, 1);
  assert.equal(values.filter((p) => p === "THIRD").length, 1);
  assert.equal(values.filter((p) => p === "PARTICIPATION").length, 5);
});

test("6 players get 2 BYEs that auto-advance", () => {
  const rounds = generateElimination(people(6));
  const byeMatches = rounds[0]!.filter((m) => m.byeResolved);
  assert.equal(byeMatches.length, 2);
  for (const m of byeMatches) assert.ok(m.winnerId);
  assert.equal(computePlacements(people(6), playAll(rounds)).complete, true);
});

test("seeds 1 and 2 land at opposite ends", () => {
  const entrants = people(8);
  const rounds = generateElimination(entrants, [entrants[0]!, entrants[1]!]);
  assert.equal(rounds[0]![3]!.slotB.playerId, "p1");
  assert.equal(rounds[0]![0]!.slotA.playerId, "p2");
});

test("3 players in elimination: bronze is a walkover for the only semi-final loser", () => {
  const entrants = people(3);
  const rounds = playAll(generateDraw(entrants, "ELIMINATION").rounds);
  const { placements, complete } = computePlacements(entrants, rounds);
  assert.equal(complete, true);
  assert.deepEqual(Object.values(placements).sort(), ["FIRST", "SECOND", "THIRD"]);
});

test("2 players: a single final, no bronze", () => {
  const entrants = people(2);
  const { rounds } = generateDraw(entrants, "ELIMINATION");
  assert.equal(rounds.flat().length, 1);
  const done = playAll(rounds);
  const winner = done[0]![0]!.slotA.playerId!;
  const { placements } = computePlacements(entrants, done);
  assert.equal(placements[winner], "FIRST");
  assert.deepEqual(Object.values(placements).sort(), ["FIRST", "SECOND"]);
});

test("a lone entrant wins outright", () => {
  const entrants = people(1);
  const { rounds } = generateDraw(entrants, "AUTO");
  assert.deepEqual(computePlacements(entrants, rounds), { placements: { p1: "FIRST" }, complete: true });
});

test("AUTO uses round robin for small categories and ranks by wins", () => {
  const entrants = people(4);
  const { format, rounds } = generateDraw(entrants, "AUTO");
  assert.equal(format, "ROUND_ROBIN");
  assert.equal(rounds.flat().length, 6);
  // p1 beats everyone, p2 beats p3 and p4, p3 beats p4
  let r = rounds;
  for (const m of r.flat()) {
    const a = Number(m.slotA.playerId!.slice(1));
    const b = Number(m.slotB.playerId!.slice(1));
    r = win(r, m.matchId, a < b ? "A" : "B");
  }
  assert.deepEqual(computePlacements(entrants, r).placements, { p1: "FIRST", p2: "SECOND", p3: "THIRD", p4: "PARTICIPATION" });
});

test("changing a result moves the new winner on; undo is blocked once the next match is played", () => {
  let rounds = generateElimination(people(4));
  rounds = win(rounds, "R1M1", "A");
  const firstWinner = rounds[0]![0]!.slotA.playerId;
  assert.equal(rounds[1]![0]!.slotA.playerId, firstWinner);

  rounds = win(rounds, "R1M1", "B");
  assert.equal(rounds[1]![0]!.slotA.playerId, rounds[0]![0]!.slotB.playerId);
  assert.equal(rounds[1]![1]!.slotA.playerId, firstWinner, "loser moves to bronze");

  rounds = win(rounds, "R1M2");
  rounds = win(rounds, "R2M1");
  assert.throws(() => resetResult(rounds, "R1M1"), /Undo the result of match R2M1 first/);
  rounds = resetResult(rounds, "R2M1");
  rounds = resetResult(rounds, "R1M1");
  assert.equal(rounds[1]![0]!.slotA.playerName, "TBD");
  assert.equal(rounds[1]![1]!.slotA.playerName, "TBD");
});

test("age groups follow birth year relative to the tournament year", () => {
  const all = ["Sub-Junior", "Cadet", "Junior", "Senior"];
  assert.deepEqual(eligibleAgeGroups(new Date("2013-05-01"), new Date("2026-11-20"), all), ["Sub-Junior"]);
  assert.deepEqual(eligibleAgeGroups(new Date("2010-05-01"), new Date("2026-11-20"), all), ["Cadet", "Junior", "Senior"]);
  // Cadet 14–16 (Junior from 14, Senior from 15) · Junior 17–19 → Junior, Senior · Senior 20+ → Senior
  const at = (age: number) => eligibleAgeGroups(new Date(`${2026 - age}-05-01`), new Date("2026-11-20"), all);
  assert.deepEqual(at(14), ["Sub-Junior", "Cadet", "Junior"]);
  assert.deepEqual(at(15), ["Cadet", "Junior", "Senior"]);
  assert.deepEqual(at(17), ["Junior", "Senior"]);
  assert.deepEqual(at(19), ["Junior", "Senior"]);
  assert.deepEqual(at(20), ["Senior"]);
  assert.deepEqual(at(40), ["Senior"]);
  // Only the groups the tournament contests are offered
  assert.deepEqual(eligibleAgeGroups(new Date("2011-05-01"), new Date("2026-11-20"), ["Junior", "Senior"]), ["Junior", "Senior"]);
  assert.equal(weightCategoryFor(47.2, "Sub-Junior", "MALE"), "-50kg");
  assert.equal(weightCategoryFor(70, "Sub-Junior", "MALE"), "+66kg");
});

// ─── Repechage, manual draws ─────────────────────────────────────────────────

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const medals = (entrants: Entrant[], rounds: Rounds) => {
  const { placements, complete } = computePlacements(entrants, rounds);
  const of = (p: string) => Object.entries(placements).filter(([, v]) => v === p).map(([k]) => k).sort();
  return { complete, first: of("FIRST"), second: of("SECOND"), third: of("THIRD") };
};

test("double repechage: QF losers of each half meet, winners fight the other half's SF loser, two bronzes", () => {
  const entrants = people(8);
  // Manual: p1 v p2, p3 v p4, p5 v p6, p7 v p8 — slot A always wins
  let rounds = generateDraw(entrants, "DOUBLE_REPECHAGE", [], { slots: ids(8) }).rounds;
  assert.equal(rounds.length, 5); // QF, SF, final, repechage, bronze
  assert.equal(rounds[2]!.length, 1); // the final round has no bronze match
  rounds = playAll(rounds);
  const byId = new Map(rounds.flat().map((m) => [m.matchId, m]));
  // QF losers p2, p4 (top half) and p6, p8 (bottom half)
  assert.deepEqual([byId.get("REP1")!.slotA.playerId, byId.get("REP1")!.slotB.playerId], ["p2", "p4"]);
  assert.deepEqual([byId.get("REP2")!.slotA.playerId, byId.get("REP2")!.slotB.playerId], ["p6", "p8"]);
  // SF: p1 beat p3, p5 beat p7. Bronze 1 = REP1 winner v bottom SF loser; Bronze 2 = REP2 winner v top SF loser
  assert.deepEqual([byId.get("BR1")!.slotA.playerId, byId.get("BR1")!.slotB.playerId], ["p2", "p7"]);
  assert.deepEqual([byId.get("BR2")!.slotA.playerId, byId.get("BR2")!.slotB.playerId], ["p6", "p3"]);
  assert.deepEqual(medals(entrants, rounds), { complete: true, first: ["p1"], second: ["p5"], third: ["p2", "p6"] });
});

test("single repechage: champion's QF and SF victims meet, winner fights the runner-up's SF victim, one bronze", () => {
  const entrants = people(8);
  let rounds = generateDraw(entrants, "REPECHAGE", [], { slots: ids(8) }).rounds;
  // Repechage waits for the final
  rounds = playAll(rounds);
  const byId = new Map(rounds.flat().map((m) => [m.matchId, m]));
  // Champion p1 beat p2 (QF) and p3 (SF); runner-up p5 beat p7 in the SF
  assert.deepEqual([byId.get("REP1")!.slotA.playerId, byId.get("REP1")!.slotB.playerId], ["p2", "p3"]);
  assert.deepEqual([byId.get("BR1")!.slotA.playerId, byId.get("BR1")!.slotB.playerId], ["p2", "p7"]);
  assert.deepEqual(medals(entrants, rounds), { complete: true, first: ["p1"], second: ["p5"], third: ["p2"] });
});

test("repechage with BYEs completes, and needs at least 5 players", () => {
  for (const n of [5, 6, 7, 11]) {
    for (const format of ["REPECHAGE", "DOUBLE_REPECHAGE"] as const) {
      const entrants = people(n);
      const rounds = playAll(generateDraw(entrants, format).rounds);
      const m = medals(entrants, rounds);
      assert.equal(m.complete, true, `${format} ${n}`);
      assert.equal(m.first.length, 1);
      assert.ok(m.third.length >= 1 && m.third.length <= (format === "REPECHAGE" ? 1 : 2));
    }
  }
  assert.throws(() => generateDraw(people(4), "DOUBLE_REPECHAGE"), /at least 5/);
});

test("results the repechage depends on can't be undone while it has results", () => {
  const entrants = people(8);
  const rounds = playAll(generateDraw(entrants, "DOUBLE_REPECHAGE", [], { slots: ids(8) }).rounds);
  assert.throws(() => resetResult(rounds, "R1M1"), /R2M1/);
  // The semi-final decides who is in a bronze match; the final doesn't feed double repechage
  const finalChanged = win(resetResult(rounds, "R3M1"), "R3M1", "B");
  assert.deepEqual(medals(entrants, finalChanged).first, ["p5"]);
  assert.throws(() => resetResult(win(resetResult(rounds, "R3M1"), "R3M1"), "R2M1"), /R3M1/);
  assert.throws(() => resetResult(rounds, "REP1"), /Bronze 1/);
  // Single repechage: the final decides who enters, so it is locked once the repechage is played
  const single = playAll(generateDraw(entrants, "REPECHAGE", [], { slots: ids(8) }).rounds);
  assert.throws(() => resetResult(single, "R3M1"), /repechage/);
  const undone = resetResult(resetResult(rounds, "BR1"), "REP1");
  assert.equal(undone.flat().find((m) => m.matchId === "BR1")!.slotA.playerName, "TBD");
});

test("manual elimination draw: exact pairings, validation, BYEs advance", () => {
  const entrants = people(6);
  const slots = ["p6", "p1", "p2", null, "p3", "p4", null, "p5"];
  const rounds = generateDraw(entrants, "ELIMINATION", [], { slots }).rounds;
  assert.deepEqual(rounds[0]!.map((m) => [m.slotA.playerId, m.slotB.playerId]), [["p6", "p1"], ["p2", null], ["p3", "p4"], [null, "p5"]]);
  assert.equal(rounds[1]![0]!.slotB.playerId, "p2"); // p2's BYE sent them through
  assert.equal(rounds[1]![1]!.slotB.playerId, "p5");
  assert.throws(() => generateDraw(entrants, "ELIMINATION", [], { slots: ["p1", "p1", "p2", null, "p3", "p4", null, "p5"] }), /more than once/);
  assert.throws(() => generateDraw(entrants, "ELIMINATION", [], { slots: ["p1", "p6", "p2", "p3", null, null, "p4", "p5"] }), /no players/);
  assert.throws(() => generateDraw(entrants, "ELIMINATION", [], { slots: ["p1", "p6"] }), /8 places/);
});

test("manual round robin keeps the pool order; pairings can be edited until a match is played", () => {
  const entrants = people(4);
  const rounds = generateDraw(entrants, "ROUND_ROBIN", [], { order: ["p4", "p3", "p2", "p1"] }).rounds;
  assert.deepEqual([rounds[0]![0]!.slotA.playerId, rounds[0]![0]!.slotB.playerId], ["p4", "p1"]);

  const elim = generateDraw(people(4), "ELIMINATION").rounds;
  const edited = redraw("ELIMINATION", people(4), elim, { slots: ["p1", "p2", "p3", "p4"] });
  assert.deepEqual(edited[0]!.map((m) => [m.slotA.playerId, m.slotB.playerId]), [["p1", "p2"], ["p3", "p4"]]);
  assert.throws(() => redraw("ELIMINATION", people(4), win(edited, "R1M1"), { slots: ["p1", "p3", "p2", "p4"] }), /already been played/);
});

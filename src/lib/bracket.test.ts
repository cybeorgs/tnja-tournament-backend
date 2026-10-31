import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlacements, generateDraw, generateElimination, recordResult, resetResult, type Entrant, type Rounds } from "./bracket.js";
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
  assert.deepEqual(eligibleAgeGroups(new Date("2012-05-01"), new Date("2026-11-20"), all), ["Sub-Junior"]);
  assert.deepEqual(eligibleAgeGroups(new Date("2009-05-01"), new Date("2026-11-20"), all), ["Cadet", "Junior", "Senior"]);
  assert.equal(weightCategoryFor(47.2, "Sub-Junior", "MALE"), "-50kg");
  assert.equal(weightCategoryFor(70, "Sub-Junior", "MALE"), "+66kg");
});

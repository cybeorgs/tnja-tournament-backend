// ─── Age groups and weight classes ───────────────────────────────────────────
// Ported from the main TNJA app. Age is counted as (tournament year − birth year),
// which is how the federation's birth-year bands work, so the same table stays
// valid every season instead of hard-coding birth years.

export interface AgeGroupDef {
  name: string;
  minAge: number;
  maxAge: number;
  /** Upper limits in kg; the last class is "+<last limit>kg". */
  weights: { MALE: number[]; FEMALE: number[] };
}

export const AGE_GROUPS: AgeGroupDef[] = [
  { name: "Mini Sub-Junior Age Group 1", minAge: 7, maxAge: 8, weights: { MALE: [20, 25, 30], FEMALE: [18, 22, 26] } },
  { name: "Mini Sub-Junior Age Group 2", minAge: 9, maxAge: 10, weights: { MALE: [25, 30, 35], FEMALE: [22, 26, 30] } },
  { name: "Mini Sub-Junior Age Group 3", minAge: 11, maxAge: 12, weights: { MALE: [30, 35, 40, 45], FEMALE: [28, 32, 36, 40] } },
  { name: "Sub-Junior", minAge: 13, maxAge: 15, weights: { MALE: [30, 35, 40, 45, 50, 55, 60, 66], FEMALE: [28, 32, 36, 40, 44, 48, 52, 57] } },
  { name: "Cadet", minAge: 16, maxAge: 18, weights: { MALE: [50, 55, 60, 66, 73, 81, 90], FEMALE: [40, 44, 48, 52, 57, 63, 70] } },
  { name: "Junior", minAge: 16, maxAge: 21, weights: { MALE: [55, 60, 66, 73, 81, 90, 100], FEMALE: [44, 48, 52, 57, 63, 70, 78] } },
  { name: "Senior", minAge: 16, maxAge: 120, weights: { MALE: [60, 66, 73, 81, 90, 100], FEMALE: [48, 52, 57, 63, 70, 78] } },
];

export const AGE_GROUP_NAMES = AGE_GROUPS.map((g) => g.name);

export type Gender = "MALE" | "FEMALE";

export function findAgeGroup(name: string): AgeGroupDef | undefined {
  return AGE_GROUPS.find((g) => g.name === name);
}

export function competitionAge(dob: Date, tournamentDate: Date): number {
  return tournamentDate.getFullYear() - dob.getFullYear();
}

/** Age groups (out of `allowed`) a student born on `dob` may enter for a tournament on `tournamentDate`. */
export function eligibleAgeGroups(dob: Date, tournamentDate: Date, allowed: string[]): string[] {
  const age = competitionAge(dob, tournamentDate);
  return AGE_GROUPS.filter((g) => allowed.includes(g.name) && age >= g.minAge && age <= g.maxAge).map((g) => g.name);
}

export function weightClasses(ageGroup: string, gender: Gender): string[] {
  const def = findAgeGroup(ageGroup);
  if (!def) return [];
  const limits = def.weights[gender];
  const last = limits[limits.length - 1];
  return [...limits.map((l) => `-${l}kg`), `+${last}kg`];
}

export function weightCategoryFor(weightKg: number, ageGroup: string, gender: Gender): string {
  const def = findAgeGroup(ageGroup);
  if (!def) throw new Error(`Unknown age group ${ageGroup}`);
  const limits = def.weights[gender];
  const limit = limits.find((l) => weightKg <= l);
  return limit !== undefined ? `-${limit}kg` : `+${limits[limits.length - 1]}kg`;
}

export const PLACEMENTS = ["FIRST", "SECOND", "THIRD", "PARTICIPATION"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export const REFEREE_ROLES = ["REFEREE", "JUDGE", "TIMEKEEPER", "SCOREKEEPER", "TECHNICAL_OFFICIAL"] as const;
export const TOURNAMENT_LEVELS = ["DISTRICT", "ZONAL", "STATE", "NATIONAL", "OPEN"] as const;
export const WIN_METHODS = ["IPPON", "WAZA_ARI", "HANSOKU_MAKE", "DECISION", "FUSEN_GACHI", "KIKEN_GACHI"] as const;

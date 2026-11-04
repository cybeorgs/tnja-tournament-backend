// ─── Age groups and weight classes ───────────────────────────────────────────
// Categories go by BIRTH YEAR only: the month and day of birth never matter. Age is counted as
// (tournament year − birth year), so the same table stays valid every season instead of
// hard-coding birth years. For a 2026 tournament this gives (TNJA circular):
//   Mini Sub-Junior I 2019–2020 · II 2017–2018 · III 2015–2016 · Sub-Junior 2012–2014
//   Cadet 2010–2012 · Junior 2007–2009 (cadets 2010–2012 may play up) · Senior 2006 and earlier
//   (players born 2011 and earlier may play up)

export interface AgeGroupDef {
  name: string;
  minAge: number;
  maxAge: number;
  /** Younger players may "play up" into this group from this age (e.g. a 15-year-old cadet may also enter Junior
   *  and Senior). Defaults to minAge: only the group's own ages. */
  playUpFrom?: number;
  /** Upper limits in kg; the last class is "+<last limit>kg". */
  weights: { MALE: number[]; FEMALE: number[] };
}

export const AGE_GROUPS: AgeGroupDef[] = [
  // Per the TNJA circular (Super Trophy Judo Championship 2026-27). Classes are upper limits; the last is "over".
  { name: "Mini Sub-Junior Age Group 1", minAge: 6, maxAge: 7, weights: { MALE: [20, 25, 30], FEMALE: [18, 22, 26] } },
  { name: "Mini Sub-Junior Age Group 2", minAge: 8, maxAge: 9, weights: { MALE: [25, 30, 35], FEMALE: [22, 26, 30] } },
  { name: "Mini Sub-Junior Age Group 3", minAge: 10, maxAge: 11, weights: { MALE: [30, 35, 40, 45], FEMALE: [28, 32, 36, 40] } },
  { name: "Sub-Junior", minAge: 12, maxAge: 14, weights: { MALE: [30, 35, 40, 45, 50, 55, 60, 66], FEMALE: [28, 32, 36, 40, 44, 48, 52, 57] } },
  // Cadets (14–16) may also enter Junior (from 14) and Senior (from 15); juniors (17–19) Junior and Senior; seniors (20+) Senior only.
  { name: "Cadet", minAge: 14, maxAge: 16, weights: { MALE: [50, 55, 60, 66, 73, 81, 90], FEMALE: [40, 44, 48, 52, 57, 63, 70] } },
  { name: "Junior", minAge: 17, maxAge: 19, playUpFrom: 14, weights: { MALE: [55, 60, 66, 73, 81, 90, 100], FEMALE: [44, 48, 52, 57, 63, 70, 78] } },
  { name: "Senior", minAge: 20, maxAge: 120, playUpFrom: 15, weights: { MALE: [60, 66, 73, 81, 90, 100], FEMALE: [48, 52, 57, 63, 70, 78] } },
];

/** True when a player of competition age `age` may enter `group` (its own ages, or playing up). */
export function canEnter(group: AgeGroupDef, age: number): boolean {
  return age >= (group.playUpFrom ?? group.minAge) && age <= group.maxAge;
}

export const AGE_GROUP_NAMES = AGE_GROUPS.map((g) => g.name);

export type Gender = "MALE" | "FEMALE";

export function findAgeGroup(name: string): AgeGroupDef | undefined {
  return AGE_GROUPS.find((g) => g.name === name);
}

/** Birth year as entered: dates of birth are stored as midnight UTC, so read the UTC year (never the server's time zone). */
export const birthYear = (dob: Date) => dob.getUTCFullYear();

/** The calendar year of a moment in India (a tournament starting 1 Jan 00:30 IST is that new year). */
export const yearInIndia = (d: Date) => Number(d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric" }));

/** Tournament year − birth year. Month and day of birth are ignored. */
export function competitionAge(dob: Date, tournamentDate: Date): number {
  return yearInIndia(tournamentDate) - birthYear(dob);
}

/** Age groups (out of `allowed`) a student born on `dob` may enter for a tournament on `tournamentDate`. */
export function eligibleAgeGroups(dob: Date, tournamentDate: Date, allowed: string[]): string[] {
  const age = competitionAge(dob, tournamentDate);
  return AGE_GROUPS.filter((g) => allowed.includes(g.name) && canEnter(g, age)).map((g) => g.name);
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

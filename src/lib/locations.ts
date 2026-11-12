// District / taluk reference data and pincode lookup (India Post), as on the main TNJA site.
import { HttpError } from "../middleware/errors.js";
import { TN_LOCATIONS } from "./locations.data.js";

export { TN_LOCATIONS };

// Loose key so "Kuttalam"/"Kuthalam", "Kancheepuram"/"Kanchipuram",
// "The Nilgiris"/"Nilgiris" etc. compare equal.
const baseKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/\b(taluk|taluka|block|district)\b/g, "")
    .replace(/[^a-z]/g, "")
    .replace(/ee/g, "i")
    .replace(/oo/g, "u")
    .replace(/h/g, "")
    .replace(/(.)\1+/g, "$1");

// India Post spellings that baseKey alone can't reconcile with our names.
const NAME_ALIASES = new Map(
  Object.entries({
    Tuticorin: "Thoothukudi",
    Tiruchy: "Tiruchirappalli",
    Trichy: "Tiruchirappalli",
    Kanyakumari: "Kanniyakumari",
    Sivagangai: "Sivaganga",
    Ooty: "Udhagamandalam",
    // Tenkasi district; India Post uses both "Sengottai" and "Shenkottai"
    Shenkottai: "Sengottai",
    Shencottai: "Sengottai",
    Senkottai: "Sengottai",
  }).map(([from, to]) => [baseKey(from), baseKey(to)]),
);

const nameKey = (s: string) => {
  const k = baseKey(s);
  return NAME_ALIASES.get(k) ?? k;
};

/** `district`'s taluk with this name, allowing other spellings (e.g. "Shenkottai" → "Sengottai"). */
export function findTaluk(district: string, taluk: string): string | undefined {
  return TN_LOCATIONS.find((d) => nameKey(d.district) === nameKey(district))?.taluks.find((t) => nameKey(t) === nameKey(taluk));
}

/** True when `taluk` is one of `district`'s taluks. */
export function isKnownLocation(district: string, taluk: string) {
  return !!TN_LOCATIONS.find((d) => d.district === district)?.taluks.includes(taluk);
}

type PostOffice = { Name: string; District: string; Block: string; State: string };

const pincodeCache = new Map<string, PostOffice[]>();

async function fetchPostOffices(pincode: string): Promise<PostOffice[]> {
  const cached = pincodeCache.get(pincode);
  if (cached) return cached;
  const r = await fetch(`https://api.postalpincode.in/pincode/${pincode}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Pincode API responded ${r.status}`);
  const body = (await r.json()) as { Status: string; PostOffice: PostOffice[] | null }[];
  const offices = body?.[0]?.Status === "Success" ? body[0].PostOffice ?? [] : [];
  pincodeCache.set(pincode, offices);
  return offices;
}

/**
 * Result of a pincode lookup: a Tamil Nadu district and its candidate taluks, or the state elsewhere.
 * `found` is false when the India Post directory has no record of the pincode. That directory is
 * incomplete, so a missing record doesn't make the pincode invalid. `district` is "" when it couldn't
 * be worked out, and the student picks it.
 */
export type PincodeLocation =
  | { pincode: string; found: boolean; inTamilNadu: true; state: "Tamil Nadu"; district: string; taluks: string[]; postOffices: string[] }
  | { pincode: string; found: boolean; inTamilNadu: false; state: string; district: string; taluks: []; postOffices: string[] };

/** An Indian PIN: exactly 6 digits, the first 1–9 (no Indian PIN starts with 0). */
export const PINCODE_PATTERN = /^[1-9]\d{5}$/;
export const PINCODE_FORMAT_MESSAGE = "must be exactly 6 digits (numbers only, not starting with 0)";
export const isValidPincode = (value: unknown): value is string => typeof value === "string" && PINCODE_PATTERN.test(value);

// PINs in the Tamil Nadu postal circle start 60–64 (the circle also covers Puducherry and Karaikal).
const inTamilNaduCircle = (pincode: string) => /^6[0-4]/.test(pincode);

/**
 * Where a pincode is. For Tamil Nadu: the district and taluk(s).
 * India Post's District field still uses pre-2019/2020 boundaries, while its Block field
 * matches current taluk names, so taluks are matched first and the district follows from them.
 */
export async function lookupPincode(pincode: string): Promise<PincodeLocation> {
  if (!isValidPincode(pincode)) throw new HttpError(400, `Pincode ${PINCODE_FORMAT_MESSAGE}.`);

  let all: PostOffice[];
  try {
    all = await fetchPostOffices(pincode);
  } catch (err) {
    console.error("Pincode lookup failed:", err);
    throw new HttpError(502, "Couldn't look up this pincode right now. Please try again.");
  }
  if (!all.length) {
    // Not in the India Post directory (e.g. 600112, Choolai, Chennai). The format is valid, so accept it:
    // the postal circle decides which form applies, and the student picks the district (and taluk).
    return inTamilNaduCircle(pincode)
      ? { pincode, found: false, inTamilNadu: true, state: "Tamil Nadu", district: "", taluks: [], postOffices: [] }
      : { pincode, found: false, inTamilNadu: false, state: "", district: "", taluks: [], postOffices: [] };
  }

  const offices = all.filter((o) => nameKey(o.State) === "tamilnadu");
  if (!offices.length) {
    const first = all[0]!;
    return { pincode, found: true, inTamilNadu: false, state: first.State, district: first.District, taluks: [], postOffices: all.map((o) => o.Name) };
  }

  const blockKeys = new Set(offices.map((o) => nameKey(o.Block)));
  const matched = TN_LOCATIONS.flatMap((d) => d.taluks.filter((t) => blockKeys.has(nameKey(t))).map((taluk) => ({ taluk, district: d.district })));

  let district: string | undefined;
  if (matched.length) {
    // Each post office votes for the district of the taluk its block matches;
    // a pincode straddling two districts goes to the one with more offices.
    const votes = new Map<string, number>();
    for (const o of offices) {
      const m = matched.find((t) => nameKey(t.taluk) === nameKey(o.Block));
      if (m) votes.set(m.district, (votes.get(m.district) ?? 0) + 1);
    }
    district = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  } else {
    const postDistricts = new Set(offices.map((o) => nameKey(o.District)));
    district = TN_LOCATIONS.find((d) => postDistricts.has(nameKey(d.district)))?.district;
  }
  // A Tamil Nadu pincode we can't place in a district: the student picks the district and taluk.
  if (!district) return { pincode, found: true, inTamilNadu: true, state: "Tamil Nadu", district: "", taluks: [], postOffices: offices.map((o) => o.Name) };

  const taluks = [...new Set(matched.filter((m) => m.district === district).map((m) => m.taluk))].sort();
  return { pincode, found: true, inTamilNadu: true, state: "Tamil Nadu", district, taluks, postOffices: offices.map((o) => o.Name) };
}

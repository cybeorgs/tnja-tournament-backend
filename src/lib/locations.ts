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
  }).map(([from, to]) => [baseKey(from), baseKey(to)]),
);

const nameKey = (s: string) => {
  const k = baseKey(s);
  return NAME_ALIASES.get(k) ?? k;
};

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

/** Result of a pincode lookup: a Tamil Nadu district and its candidate taluks, or the state elsewhere. */
export type PincodeLocation =
  | { pincode: string; inTamilNadu: true; state: "Tamil Nadu"; district: string; taluks: string[]; postOffices: string[] }
  | { pincode: string; inTamilNadu: false; state: string; district: string; taluks: []; postOffices: string[] };

/**
 * Where a pincode is. For Tamil Nadu: the district and taluk(s).
 * India Post's District field still uses pre-2019/2020 boundaries, while its Block field
 * matches current taluk names, so taluks are matched first and the district follows from them.
 */
export async function lookupPincode(pincode: string): Promise<PincodeLocation> {
  if (!/^[1-9]\d{5}$/.test(pincode)) throw new HttpError(400, "Pincode must be 6 digits.");

  let all: PostOffice[];
  try {
    all = await fetchPostOffices(pincode);
  } catch (err) {
    console.error("Pincode lookup failed:", err);
    throw new HttpError(502, "Couldn't look up this pincode right now. Please try again.");
  }
  if (!all.length) throw new HttpError(404, "This pincode wasn't found. Please check it.");

  const offices = all.filter((o) => nameKey(o.State) === "tamilnadu");
  if (!offices.length) {
    const first = all[0]!;
    return { pincode, inTamilNadu: false, state: first.State, district: first.District, taluks: [], postOffices: all.map((o) => o.Name) };
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
  if (!district) throw new HttpError(404, "Pincode not recognised. Pick the district and taluk below.");

  const taluks = [...new Set(matched.filter((m) => m.district === district).map((m) => m.taluk))].sort();
  return { pincode, inTamilNadu: true, state: "Tamil Nadu", district, taluks, postOffices: offices.map((o) => o.Name) };
}

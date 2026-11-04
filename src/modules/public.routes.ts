// Unauthenticated endpoints for the public site. Only PUBLISHED / COMPLETED tournaments
// are visible, and results and certificates only once results are published.
import { Router } from "express";
import { z } from "zod";
import prisma from "../db.js";
import { HttpError, notFound } from "../middleware/errors.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { AGE_GROUPS, REFEREE_ROLES, TOURNAMENT_LEVELS, WIN_METHODS } from "../lib/categories.js";
import { categoryLabel } from "../lib/certificate.js";
import type { Entrant, Rounds } from "../lib/bracket.js";
import { getSettings, param } from "../lib/helpers.js";
import { publicView } from "./settings.routes.js";
import { isSandboxConfigured } from "../lib/sandbox.js";
import { onlinePaymentEnabled } from "../lib/payments.js";
import { describeDraw } from "./draws.routes.js";
import { loadRegistrations, officialCertificatesPdf, sendPdf, studentCertificatesPdf } from "./certificates.js";

const router = Router();
const VISIBLE = { status: { in: ["PUBLISHED", "COMPLETED"] } };

router.get("/settings", async (_req, res) => {
  // aadhaarVerification: whether self-registration asks for DigiLocker verification.
  // onlinePayment: whether entry fees can be paid online (Razorpay keys are set).
  res.json({ ...publicView(await getSettings()), aadhaarVerification: isSandboxConfigured(), onlinePayment: onlinePaymentEnabled() });
});

router.get("/logo", async (_req, res) => {
  const settings = await getSettings();
  if (!settings.logo || !settings.logoMime) throw notFound("Logo");
  res.setHeader("Content-Type", settings.logoMime);
  res.setHeader("Cache-Control", "public, max-age=300");
  res.end(Buffer.from(settings.logo));
});

router.get("/meta", (_req, res) => {
  res.json({
    ageGroups: AGE_GROUPS.map((g) => ({
      name: g.name, minAge: g.minAge, maxAge: g.maxAge, playUpFrom: g.playUpFrom ?? g.minAge,
      weightClasses: {
        MALE: [...g.weights.MALE.map((w) => `-${w}kg`), `+${g.weights.MALE.at(-1)}kg`],
        FEMALE: [...g.weights.FEMALE.map((w) => `-${w}kg`), `+${g.weights.FEMALE.at(-1)}kg`],
      },
    })),
    levels: TOURNAMENT_LEVELS,
    refereeRoles: REFEREE_ROLES,
    winMethods: WIN_METHODS,
  });
});

const publicTournamentFields = {
  id: true, slug: true, title: true, description: true, venue: true, city: true, startDate: true, endDate: true,
  level: true, gender: true, ageGroups: true, registrationOpensAt: true, registrationClosesAt: true, entryFee: true, additionalEntryFee: true, numberOfMats: true, status: true, resultsPublished: true, publishedAt: true,
} as const;

router.get("/tournaments", async (_req, res) => {
  const tournaments = await prisma.tournament.findMany({
    where: VISIBLE, orderBy: { startDate: "desc" },
    select: { ...publicTournamentFields, _count: { select: { registrations: true } } },
  });
  res.json(tournaments);
});

router.get("/tournaments/:slug", async (req, res) => {
  const tournament = await prisma.tournament.findFirst({ where: { slug: param(req, "slug"), ...VISIBLE }, select: publicTournamentFields });
  if (!tournament) throw notFound("Tournament");

  const [registrations, officials, draws] = await Promise.all([
    prisma.registration.findMany({ where: { tournamentId: tournament.id }, include: { student: { select: { fullName: true, club: true, district: true } } } }),
    prisma.tournamentReferee.findMany({ where: { tournamentId: tournament.id }, include: { referee: { select: { fullName: true, grade: true, district: true } } }, orderBy: { role: "asc" } }),
    prisma.draw.findMany({ where: { tournamentId: tournament.id }, orderBy: [{ ageGroup: "asc" }, { gender: "asc" }, { weightCategory: "asc" }] }),
  ]);

  const byId = new Map(registrations.map((r) => [r.id, r]));
  const results = tournament.resultsPublished
    ? draws.filter((d) => d.isConcluded).map((d) => {
        const entrants = d.entrants as unknown as Entrant[];
        const medal = (p: string) => entrants.map((e) => byId.get(e.id)).filter((r) => r?.placement === p).map((r) => ({ name: r!.student.fullName, club: r!.student.club || r!.student.district }));
        return { category: categoryLabel(d.ageGroup, d.gender, d.weightCategory), ageGroup: d.ageGroup, gender: d.gender, weightCategory: d.weightCategory, first: medal("FIRST"), second: medal("SECOND"), third: medal("THIRD") };
      })
    : [];

  const categoryCounts = new Map<string, number>();
  for (const r of registrations) {
    const label = categoryLabel(r.ageGroup, r.gender, r.weightCategory);
    categoryCounts.set(label, (categoryCounts.get(label) || 0) + 1);
  }

  res.json({
    ...tournament,
    entries: registrations.length,
    categories: [...categoryCounts.entries()].map(([label, entrants]) => ({ label, entrants })),
    officials: officials.map((o) => ({ name: o.referee.fullName, grade: o.referee.grade, district: o.referee.district, role: o.role, matNumber: o.matNumber })),
    draws: draws.map((d) => {
      const full = describeDraw({ ...d, rounds: d.rounds as unknown as Rounds, entrants: d.entrants as unknown as Entrant[] });
      return {
        id: d.id, ageGroup: d.ageGroup, gender: d.gender, weightCategory: d.weightCategory, format: d.format, matNumber: d.matNumber,
        isConcluded: d.isConcluded, rounds: full.rounds, entrants: full.entrants, standings: full.standings,
        matchesTotal: full.matchesTotal, matchesDone: full.matchesDone,
      };
    }),
    results,
  });
});

// ─── Certificates: lookup, verification, download ────────────────────────────

const lookupLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

const lookupSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("student"), name: z.string().trim().min(2), dob: z.coerce.date() }),
  z.object({ kind: z.literal("official"), name: z.string().trim().min(2), phone: z.string().trim().min(4) }),
]);

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const sameDay = (a: Date, b: Date) => a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);

/** Students find their certificate with name + date of birth; officials with name + phone. */
router.post("/tournaments/:slug/certificate-lookup", lookupLimiter, async (req, res) => {
  const tournament = await prisma.tournament.findFirst({ where: { slug: param(req, "slug"), ...VISIBLE } });
  if (!tournament) throw notFound("Tournament");
  if (!tournament.resultsPublished) throw new HttpError(400, "Certificates for this tournament have not been released yet.");
  const input = lookupSchema.parse(req.body);

  if (input.kind === "student") {
    const regs = await prisma.registration.findMany({ where: { tournamentId: tournament.id, placement: { not: null } }, include: { student: true } });
    const match = regs.find((r) => normalise(r.student.fullName) === normalise(input.name) && sameDay(r.student.dob, input.dob));
    if (!match?.certificateNo) throw new HttpError(404, "No certificate found. Check the spelling of the name and the date of birth, or ask the organiser.");
    return res.json({ certificateNo: match.certificateNo, name: match.student.fullName });
  }

  const officials = await prisma.tournamentReferee.findMany({ where: { tournamentId: tournament.id }, include: { referee: true } });
  const digits = (s: string) => s.replace(/\D/g, "");
  const match = officials.find((o) => normalise(o.referee.fullName) === normalise(input.name) && digits(o.referee.phone).length >= 4 && digits(o.referee.phone).endsWith(digits(input.phone)) && digits(input.phone).length >= 4);
  if (!match) throw new HttpError(404, "No certificate found. Check the name and phone number, or ask the organiser.");
  res.json({ certificateNo: match.certificateNo, name: match.referee.fullName });
});

/** A certificate is publicly valid once the tournament's results are published (and, for students, their category is concluded). */
async function findIssued(certificateNo: string) {
  const registration = await prisma.registration.findUnique({ where: { certificateNo }, include: { student: true, tournament: true } });
  if (registration?.tournament.resultsPublished && registration.placement) return { kind: "student" as const, registration };
  const official = await prisma.tournamentReferee.findUnique({ where: { certificateNo }, include: { referee: true, tournament: true } });
  if (official?.tournament.resultsPublished) return { kind: "official" as const, official };
  return null;
}

router.get("/verify/:certificateNo", lookupLimiter, async (req, res) => {
  const issued = await findIssued(param(req, "certificateNo").toUpperCase());
  if (!issued) return res.json({ valid: false });
  if (issued.kind === "student") {
    const { registration: r } = issued;
    return res.json({
      valid: true, kind: "STUDENT", certificateNo: r.certificateNo, name: r.student.fullName, club: r.student.club,
      placement: r.placement, category: categoryLabel(r.ageGroup, r.gender, r.weightCategory),
      tournament: { title: r.tournament.title, slug: r.tournament.slug, startDate: r.tournament.startDate, venue: r.tournament.venue },
    });
  }
  const { official: o } = issued;
  res.json({
    valid: true, kind: "OFFICIAL", certificateNo: o.certificateNo, name: o.referee.fullName, role: o.role,
    tournament: { title: o.tournament.title, slug: o.tournament.slug, startDate: o.tournament.startDate, venue: o.tournament.venue },
  });
});

router.get("/certificates/:certificateNo", lookupLimiter, async (req, res) => {
  const issued = await findIssued(param(req, "certificateNo").toUpperCase());
  if (!issued) throw notFound("Certificate");
  const download = req.query.download !== "0";
  if (issued.kind === "student") {
    const regs = await loadRegistrations({ tournamentId: issued.registration.tournamentId, id: issued.registration.id });
    return sendPdf(res, await studentCertificatesPdf(issued.registration.tournamentId, regs), `${issued.registration.student.fullName}_certificate.pdf`, download);
  }
  sendPdf(res, await officialCertificatesPdf(issued.official.tournamentId, [issued.official.id]), `${issued.official.referee.fullName}_certificate.pdf`, download);
});

export default router;
